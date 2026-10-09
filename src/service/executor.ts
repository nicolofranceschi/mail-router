import type { ImapFlow } from "imapflow";

import { errorMessage, log } from "../log";
import { appendToSent, createImapClient, sendRaw, type AccountRuntime } from "../mail/clients";
import { safeMove } from "../mail/move";
import { nowIso, type ActionRow } from "../store";
import type { App } from "./app";

const BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60];

export class PermanentError extends Error {}

function isPermanent(error: unknown): boolean {
  if (error instanceof PermanentError) return true;
  const smtpCode = (error as { responseCode?: unknown }).responseCode;
  if (typeof smtpCode === "number" && smtpCode >= 500 && smtpCode !== 530 && smtpCode !== 535) return true;
  // An IMAP NO/BAD (missing folder, no permission on a shared folder…) will not fix itself.
  const imapStatus = (error as { responseStatus?: unknown }).responseStatus;
  if (imapStatus === "NO" || imapStatus === "BAD") return true;
  const imapCode = (error as { serverResponseCode?: unknown }).serverResponseCode;
  return imapCode === "TRYCREATE" || imapCode === "NONEXISTENT" || imapCode === "NOPERM";
}

/**
 * Drains the outbox written by the processor. Actions of one message run in
 * their planned order; a transient failure parks that message's remaining
 * actions until the retry time, so a move never overtakes its forward. Only
 * runs in live mode: switching to shadow/paused cancels what is still queued.
 */
export class Executor {
  private stopped = false;
  private wakeRequested = false;
  private wake: (() => void) | null = null;
  private draining: Promise<void> | null = null;

  constructor(private readonly app: App) {}

  start(): void {
    const recovered = this.app.store.recoverRunningActions();
    if (recovered) log.warn(`${recovered} azioni interrotte dall'ultimo arresto rimesse in coda`);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  kick(): void {
    this.wakeRequested = true;
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.waitForWake(10_000);
      if (this.stopped) break;
      if (this.app.mode !== "live") continue;
      this.draining = this.drain().catch((error) => log.error("esecuzione delle azioni non riuscita", error));
      await this.draining;
      this.draining = null;
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const due = this.app.store.dueEvaluationIds(20);
      if (!due.length || this.stopped || this.app.mode !== "live") return;
      let progressed = false;
      for (const evaluationId of due) {
        if (await this.runEvaluation(evaluationId)) progressed = true;
      }
      if (!progressed) return;
    }
  }

  /** Returns true when at least one action reached a final state. */
  private async runEvaluation(evaluationId: number): Promise<boolean> {
    const actions = this.app.store.actionsForEvaluation(evaluationId);
    let forwardFailed = false;
    let progressed = false;
    let imap: ImapFlow | null = null;
    const imapFor = async (account: AccountRuntime) => {
      if (!imap) {
        imap = createImapClient(account, "esecuzione azioni");
        await imap.connect();
      }
      return imap;
    };
    try {
      for (const action of actions) {
        if (action.type === "forward" && action.status === "error") forwardFailed = true;
        if (action.status !== "pending") continue;
        if (action.next_attempt_at && action.next_attempt_at > nowIso()) break;
        if (this.stopped || this.app.mode !== "live") break;
        if (action.type === "move" && forwardFailed) {
          this.app.store.finishAction(action.id, "skipped", {
            error: "inoltro non riuscito: il messaggio resta nella cartella per la gestione manuale",
          });
          progressed = true;
          continue;
        }
        this.app.store.markActionRunning(action.id);
        try {
          const account = this.app.account(action.account);
          const result = await this.perform(action, account, imapFor);
          this.app.store.finishAction(action.id, "done", { result });
          progressed = true;
          log.info(`azione ${action.id} (${action.type}) eseguita`, result);
        } catch (error) {
          const attempts = action.attempts + 1;
          const message = errorMessage(error);
          if (attempts >= this.app.config.engine.maxAttempts || isPermanent(error)) {
            this.app.store.finishAction(action.id, "error", { error: message });
            if (action.type === "forward") forwardFailed = true;
            progressed = true;
            log.error(`azione ${action.id} (${action.type}) fallita definitivamente: ${message}`);
            continue;
          }
          const minutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
          const retryAt = new Date(Date.now() + minutes * 60_000).toISOString();
          this.app.store.finishAction(action.id, "pending", { error: message, retryAt });
          log.warn(`azione ${action.id} (${action.type}) non riuscita, nuovo tentativo tra ${minutes} min: ${message}`);
          // Reset a broken IMAP session before the next evaluation.
          if (action.type !== "forward") {
            const broken = imap as ImapFlow | null;
            imap = null;
            await broken?.logout().catch(() => broken.close());
          }
          break;
        }
      }
    } finally {
      const open = imap as ImapFlow | null;
      await open?.logout().catch(() => open.close());
    }
    return progressed;
  }

  private async perform(
    action: ActionRow,
    account: AccountRuntime,
    imapFor: (account: AccountRuntime) => Promise<ImapFlow>,
  ): Promise<unknown> {
    const payload = JSON.parse(action.payload) as Record<string, unknown>;
    if (action.type === "forward") {
      if (!action.raw) throw new PermanentError("messaggio da inoltrare non più disponibile");
      const envelope = payload.envelope as { from: string; to: string[] };
      const sent = await sendRaw(account, action.raw, envelope);
      await appendToSent(account, action.raw);
      return sent;
    }

    if (!action.folder || action.uid === null) throw new PermanentError("azione senza messaggio di riferimento");
    const client = await imapFor(account);
    const lock = await client.getMailboxLock(action.folder);
    try {
      const uidValidity = client.mailbox ? String(client.mailbox.uidValidity) : null;
      if (action.uid_validity && uidValidity !== action.uid_validity) {
        throw new PermanentError("la cartella è stata ricreata (UIDVALIDITY cambiata): messaggio non più identificabile");
      }
      const uid = String(action.uid);
      switch (action.type) {
        case "flags":
        case "seen": {
          const flags = action.type === "seen" ? ["\\Seen"] : (payload.flags as string[]);
          if (await client.messageFlagsAdd(uid, flags, { uid: true })) return { flags };
          // imapflow answers false both for a vanished message and for a refused STORE.
          if (!(await client.fetchOne(uid, { uid: true }, { uid: true }))) return { note: "messaggio non più presente nella cartella" };
          throw new PermanentError("il server ha rifiutato le etichette (permessi di scrittura sulla cartella?)");
        }
        case "move": {
          const result = await safeMove(client, action.uid, payload.target as string);
          if (!result.moved) return { note: "messaggio non più presente nella cartella" };
          return { movedTo: result.target, ...(result.folderCreated ? { folderCreated: true } : {}) };
        }
        default:
          throw new PermanentError(`tipo di azione non eseguibile in coda: ${action.type}`);
      }
    } finally {
      lock.release();
    }
  }

  private waitForWake(timeoutMs: number): Promise<void> {
    if (this.wakeRequested) {
      this.wakeRequested = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, timeoutMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        this.wakeRequested = false;
        resolve();
      };
    });
  }
}
