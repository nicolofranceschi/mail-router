import type { ImapFlow, MailboxObject } from "imapflow";

import { errorMessage, log } from "../log";
import { createImapClient, type AccountRuntime } from "../mail/clients";
import type { App } from "./app";
import { processMessage } from "./processor";

export interface WatcherStatus {
  id: string;
  account: string;
  folder: string;
  connected: boolean;
  uidValidity: string | null;
  lastUid: number | null;
  messagesInFolder: number | null;
  lastCheckAt: string | null;
  processedSinceStart: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Keeps one read-only (EXAMINE) connection on a folder, wakes on IMAP IDLE
 * notifications or on a poll timer, and feeds every message with a UID above
 * the stored watermark to the processor — in UID order, one at a time.
 * The watcher never writes to the mailbox: the executor does, separately.
 */
export class FolderWatcher {
  readonly id: string;
  private stopped = false;
  private client: ImapFlow | null = null;
  private wakeRequested = false;
  private wake: (() => void) | null = null;
  private skipBacklog = false;
  private readonly status: WatcherStatus;

  constructor(
    private readonly app: App,
    private readonly account: AccountRuntime,
    readonly folder: string,
  ) {
    this.id = `${account.config.id}:${folder}`;
    this.status = {
      id: this.id,
      account: account.config.id,
      folder,
      connected: false,
      uidValidity: null,
      lastUid: null,
      messagesInFolder: null,
      lastCheckAt: null,
      processedSinceStart: 0,
      lastError: null,
      lastErrorAt: null,
    };
  }

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeUp();
    await this.client?.logout().catch(() => this.client?.close());
  }

  wakeUp(): void {
    this.wakeRequested = true;
    this.wake?.();
  }

  /** Next check moves the watermark to the newest message instead of processing the backlog. */
  requestSkipBacklog(): void {
    this.skipBacklog = true;
    this.wakeUp();
  }

  snapshot(): WatcherStatus {
    const state = this.app.store.getWatchState(this.id);
    return { ...this.status, lastUid: state?.lastUid ?? null, uidValidity: state?.uidValidity ?? null };
  }

  private async loop(): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (!this.stopped) {
      // Enter IDLE one second after the last command (default 15 s), so new mail is seen at once.
      const client = createImapClient(this.account, `monitor ${this.folder}`, { autoIdleDelayMs: 1000 });
      this.client = client;
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      try {
        await client.connect();
        const mailbox = await client.mailboxOpen(this.folder, { readOnly: true });
        this.status.connected = true;
        this.status.messagesInFolder = mailbox.exists;
        backoff = MIN_BACKOFF_MS;
        this.initWatermark(mailbox);
        log.info(`[${this.id}] connesso, in ascolto dei nuovi messaggi`);
        client.on("exists", (data: { count: number }) => {
          this.status.messagesInFolder = data.count;
          this.wakeUp();
        });
        this.wakeRequested = true;
        while (!this.stopped && client.usable) {
          await this.waitForWake(this.app.config.engine.pollSeconds * 1000, closed);
          if (this.stopped || !client.usable) break;
          if (this.skipBacklog) await this.moveWatermarkToLatest(client);
          if (this.app.mode === "paused") continue;
          await this.processNew(client);
        }
      } catch (error) {
        this.recordError(error);
      } finally {
        this.status.connected = false;
        this.client = null;
        await client.logout().catch(() => client.close());
      }
      if (this.stopped) break;
      log.info(`[${this.id}] riconnessione tra ${Math.round(backoff / 1000)} s`);
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  private initWatermark(mailbox: MailboxObject): void {
    const uidValidity = String(mailbox.uidValidity);
    const state = this.app.store.getWatchState(this.id);
    const latest = Math.max(0, (mailbox.uidNext ?? 1) - 1);
    if (!state) {
      this.app.store.setWatchState(this.id, uidValidity, latest);
      log.info(
        `[${this.id}] primo avvio: si parte dai messaggi nuovi (UID > ${latest}); i ${mailbox.exists} già presenti non vengono toccati`,
      );
    } else if (state.uidValidity !== uidValidity) {
      this.app.store.setWatchState(this.id, uidValidity, latest);
      log.warn(
        `[${this.id}] UIDVALIDITY cambiata (${state.uidValidity} → ${uidValidity}): la cartella è stata ricreata, si riparte dai messaggi nuovi`,
      );
    }
  }

  private async moveWatermarkToLatest(client: ImapFlow): Promise<void> {
    this.skipBacklog = false;
    const state = this.app.store.getWatchState(this.id);
    if (!state) return;
    const last = await client.fetchOne("*", { uid: true });
    const latest = last ? last.uid : state.lastUid;
    if (latest > state.lastUid) {
      this.app.store.setWatchState(this.id, state.uidValidity, latest);
      log.info(`[${this.id}] arretrato saltato: ${latest - state.lastUid} UID ignorati`);
    }
  }

  private async processNew(client: ImapFlow): Promise<void> {
    const state = this.app.store.getWatchState(this.id);
    if (!state) return;
    const found = await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true });
    this.status.lastCheckAt = new Date().toISOString();
    const uids = (found || []).filter((uid) => uid > state.lastUid).sort((a, b) => a - b);
    for (const uid of uids) {
      if (this.stopped || this.app.mode === "paused") break;
      const watermark = { watchId: this.id, uidValidity: state.uidValidity, lastUid: uid };
      const message = await client.fetchOne(
        String(uid),
        { uid: true, flags: true, size: true, internalDate: true, source: true },
        { uid: true },
      );
      if (!message || !message.source) {
        this.app.store.setWatchState(this.id, state.uidValidity, uid);
        continue;
      }
      try {
        const result = await processMessage(
          this.app,
          {
            account: this.account,
            folder: this.folder,
            uidValidity: state.uidValidity,
            uid,
            flags: message.flags ?? new Set<string>(),
            size: message.size ?? message.source.length,
            internalDate: message.internalDate,
            raw: message.source,
          },
          "watch",
          watermark,
        );
        this.status.processedSinceStart++;
        const matched = result.outcomes.filter((outcome) => outcome.matched).map((outcome) => outcome.ruleName);
        log.info(
          `[${this.id}] UID ${uid} «${(result.email?.subject ?? "").slice(0, 80)}» → ${
            result.note ?? (matched.length ? `regole: ${matched.join(", ")}` : "nessuna regola")
          }`,
        );
      } catch (error) {
        // A message we cannot parse must not block the ones behind it.
        this.app.store.recordEvaluation(
          {
            account: this.account.config.id,
            folder: this.folder,
            uidValidity: state.uidValidity,
            uid,
            messageId: null,
            subject: null,
            fromAddress: null,
            fromName: null,
            date: null,
            origin: "watch",
            engineMode: this.app.mode,
            matched: false,
            note: `errore di elaborazione: ${errorMessage(error)}`,
          },
          [],
          [],
          watermark,
        );
        log.error(`[${this.id}] UID ${uid}: elaborazione non riuscita`, error);
      }
    }
  }

  private recordError(error: unknown): void {
    this.status.lastError = errorMessage(error);
    this.status.lastErrorAt = new Date().toISOString();
    log.warn(`[${this.id}] ${this.status.lastError}`);
  }

  private waitForWake(timeoutMs: number, closed: Promise<void>): Promise<void> {
    if (this.wakeRequested) {
      this.wakeRequested = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        this.wakeRequested = false;
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.wake = done;
      void closed.then(done);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
