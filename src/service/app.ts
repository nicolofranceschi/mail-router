import { randomBytes } from "node:crypto";
import path from "node:path";

import { DB_FILE, findAccount, VERSION, type Config } from "../config";
import { log } from "../log";
import type { AccountRuntime } from "../mail/clients";
import type { Identity } from "../mail/compose";
import type { EngineRule } from "../rules/engine";
import { RuleSandbox } from "../rules/sandbox";
import { resolveSecret } from "../secrets";
import { Store, type EngineMode } from "../store";
import { Executor } from "./executor";
import { FolderWatcher } from "./watcher";

const PURGE_INTERVAL_MS = 6 * 60 * 60_000;

export class App {
  readonly startedAt = new Date();
  readonly executor: Executor;
  readonly watchers: FolderWatcher[] = [];
  readonly instanceId: string;
  private readonly accounts = new Map<string, AccountRuntime>();
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    readonly home: string,
    readonly config: Config,
    readonly store: Store,
    readonly sandbox: RuleSandbox,
  ) {
    this.executor = new Executor(this);
    let instanceId = store.getMeta("instance_id");
    if (!instanceId) {
      instanceId = randomBytes(8).toString("hex");
      store.setMeta("instance_id", instanceId);
    }
    this.instanceId = instanceId;
    if (!store.getMeta("engine_mode")) store.setMeta("engine_mode", "shadow");
  }

  /** Opens the database and resolves secrets; does not touch the network. */
  static async open(home: string, config: Config, options: { resolveSecrets?: boolean } = {}): Promise<App> {
    const store = new Store(path.join(home, DB_FILE));
    const sandbox = await RuleSandbox.create();
    const app = new App(home, config, store, sandbox);
    if (options.resolveSecrets !== false) {
      for (const account of config.accounts) {
        app.accounts.set(account.id, {
          config: account,
          imapPassword: resolveSecret(account.imap.password, `${account.id}.imap.password`),
          smtpPassword: account.smtp ? resolveSecret(account.smtp.password, `${account.id}.smtp.password`) : null,
        });
      }
    }
    return app;
  }

  /** Starts watchers, executor and housekeeping. */
  startBackground(): void {
    for (const account of this.accounts.values()) {
      for (const folder of account.config.watch) {
        const watcher = new FolderWatcher(this, account, folder);
        this.watchers.push(watcher);
        watcher.start();
      }
    }
    this.executor.start();
    this.purge();
    this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
    log.info(`${this.config.instanceName} avviato in modalità ${this.mode.toUpperCase()} (${this.watchers.length} cartelle monitorate)`);
  }

  async stop(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.executor.stop();
    await Promise.all(this.watchers.map((watcher) => watcher.stop()));
    this.store.close();
  }

  get mode(): EngineMode {
    return (this.store.getMeta("engine_mode") as EngineMode | null) ?? "shadow";
  }

  setMode(mode: EngineMode, options: { skipBacklog?: boolean } = {}): { previous: EngineMode; cancelled: number } {
    const previous = this.mode;
    this.store.setMeta("engine_mode", mode);
    let cancelled = 0;
    if (previous === "live" && mode !== "live") {
      cancelled = this.store.cancelPendingRuleActions(`annullata: modalità passata a ${mode}`);
    }
    if (options.skipBacklog) for (const watcher of this.watchers) watcher.requestSkipBacklog();
    for (const watcher of this.watchers) watcher.wakeUp();
    if (mode === "live") this.executor.kick();
    log.info(`modalità: ${previous} → ${mode}${cancelled ? ` (${cancelled} azioni in coda annullate)` : ""}`);
    return { previous, cancelled };
  }

  account(accountId?: string): AccountRuntime {
    const config = findAccount(this.config, accountId);
    const runtime = this.accounts.get(config.id);
    if (!runtime) throw new Error(`Account ${config.id} non inizializzato`);
    return runtime;
  }

  /** Default folder for mailbox tools: the first watched one. */
  defaultFolder(account: AccountRuntime): string {
    return account.config.watch[0] ?? "INBOX";
  }

  identity(account: AccountRuntime): Identity {
    return {
      from: account.config.smtp?.from ?? account.config.imap.user,
      timeZone: this.config.timeZone,
      instanceId: this.instanceId,
    };
  }

  ownAddresses(account: AccountRuntime): string[] {
    const addresses = [...account.config.ownAddresses, account.config.imap.user];
    if (account.config.smtp) addresses.push(account.config.smtp.from, account.config.smtp.user);
    return addresses.filter((address) => address.includes("@"));
  }

  engineRules(): EngineRule[] {
    return this.store.listRules().filter((rule) => rule.mode !== "disabled");
  }

  status() {
    const rules = this.store.listRules();
    return {
      instance: this.config.instanceName,
      version: VERSION,
      mode: this.mode,
      startedAt: this.startedAt.toISOString(),
      uptimeMinutes: Math.round((Date.now() - this.startedAt.getTime()) / 60_000),
      timeZone: this.config.timeZone,
      accounts: this.config.accounts.map((account) => ({
        id: account.id,
        user: account.imap.user,
        watch: account.watch,
        canSend: Boolean(account.smtp),
        sendsFrom: account.smtp?.from ?? null,
        forwardAsAttachment: account.forwardAsAttachment,
        moveAfterForward: account.moveAfterForward ?? null,
        sentFolder: account.sentFolder ?? null,
        trashFolder: account.trashFolder ?? null,
      })),
      watchers: this.watchers.map((watcher) => watcher.snapshot()),
      outbox: this.store.outboxCounts(),
      rules: {
        total: rules.length,
        enabled: rules.filter((rule) => rule.mode === "enabled").length,
        shadow: rules.filter((rule) => rule.mode === "shadow").length,
        disabled: rules.filter((rule) => rule.mode === "disabled").length,
      },
      allowedForwardDomains: this.config.outbound.allowedDomains,
    };
  }

  private purge(): void {
    const cutoff = new Date(Date.now() - this.config.engine.retentionDays * 86_400_000).toISOString();
    const purged = this.store.purgeOlderThan(cutoff);
    if (purged.evaluations || purged.actions) {
      log.info(`pulizia storico: ${purged.evaluations} valutazioni e ${purged.actions} azioni manuali più vecchie di ${this.config.engine.retentionDays} giorni`);
    }
  }
}
