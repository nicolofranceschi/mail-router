import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuleMode = "enabled" | "shadow" | "disabled";
export type EngineMode = "live" | "shadow" | "paused";
export type ActionType = "forward" | "flags" | "unflags" | "seen" | "move" | "reply" | "send";
export type ActionStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "simulated"
  | "blocked"
  | "skipped"
  | "cancelled";

export interface RuleRow {
  id: string;
  name: string;
  description: string;
  code: string;
  mode: RuleMode;
  priority: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RuleVersionRow {
  rule_id: string;
  version: number;
  change: "created" | "updated" | "deleted";
  name: string;
  description: string;
  code: string;
  mode: RuleMode;
  priority: number;
  saved_at: string;
}

export interface DataRow {
  key: string;
  value: string;
  description: string;
  updated_at: string;
}

export interface EvaluationInput {
  account: string;
  folder: string;
  uidValidity: string;
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  date: string | null;
  origin: "watch" | "reprocess";
  engineMode: EngineMode;
  matched: boolean;
  note?: string | null;
}

export interface RuleResultInput {
  ruleId: string;
  ruleName: string;
  ruleVersion: number;
  ruleMode: RuleMode;
  matched: boolean;
  decision: unknown;
  error: string | null;
  durationMs: number;
}

export interface ActionInput {
  seq: number;
  ruleId: string | null;
  account: string;
  folder: string | null;
  uidValidity: string | null;
  uid: number | null;
  messageId: string | null;
  type: ActionType;
  payload: unknown;
  raw?: Uint8Array | null;
  status: ActionStatus;
  lastError?: string | null;
  result?: unknown;
  origin: "rule" | "manual";
}

export interface ActionRow {
  id: number;
  evaluation_id: number | null;
  seq: number;
  rule_id: string | null;
  account: string;
  folder: string | null;
  uid_validity: string | null;
  uid: number | null;
  message_id: string | null;
  type: ActionType;
  payload: string;
  raw: Uint8Array | null;
  status: ActionStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  result: string | null;
  origin: "rule" | "manual";
  created_at: string;
  updated_at: string;
}

export interface EvaluationRow {
  id: number;
  account: string;
  folder: string;
  uid_validity: string;
  uid: number;
  message_id: string | null;
  subject: string | null;
  from_address: string | null;
  from_name: string | null;
  date: string | null;
  origin: string;
  engine_mode: EngineMode;
  matched: number;
  note: string | null;
  created_at: string;
}

export interface RuleResultRow {
  evaluation_id: number;
  rule_id: string;
  rule_name: string;
  rule_version: number;
  rule_mode: RuleMode;
  matched: number;
  decision: string | null;
  error: string | null;
  duration_ms: number;
}

const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('enabled', 'shadow', 'disabled')),
      priority INTEGER NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE rule_versions (
      rule_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      change TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      code TEXT NOT NULL,
      mode TEXT NOT NULL,
      priority INTEGER NOT NULL,
      saved_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, version)
    );

    CREATE TABLE data_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE watch_state (
      watch_id TEXT PRIMARY KEY,
      uid_validity TEXT NOT NULL,
      last_uid INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid_validity TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      subject TEXT,
      from_address TEXT,
      from_name TEXT,
      date TEXT,
      origin TEXT NOT NULL,
      engine_mode TEXT NOT NULL,
      matched INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX evaluations_created ON evaluations (created_at);
    CREATE INDEX evaluations_message ON evaluations (account, folder, uid);
    CREATE INDEX evaluations_message_id ON evaluations (message_id);

    CREATE TABLE rule_results (
      evaluation_id INTEGER NOT NULL REFERENCES evaluations (id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      rule_version INTEGER NOT NULL,
      rule_mode TEXT NOT NULL,
      matched INTEGER NOT NULL,
      decision TEXT,
      error TEXT,
      duration_ms REAL NOT NULL
    );
    CREATE INDEX rule_results_evaluation ON rule_results (evaluation_id);
    CREATE INDEX rule_results_rule ON rule_results (rule_id);

    CREATE TABLE actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evaluation_id INTEGER REFERENCES evaluations (id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      rule_id TEXT,
      account TEXT NOT NULL,
      folder TEXT,
      uid_validity TEXT,
      uid INTEGER,
      message_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      raw BLOB,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      result TEXT,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX actions_status ON actions (status, next_attempt_at);
    CREATE INDEX actions_evaluation ON actions (evaluation_id, seq);
    CREATE INDEX actions_message ON actions (message_id, type, status);
  `,
  2: `
    CREATE TABLE ui_sessions (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('session', 'once')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `,
};

/**
 * SQLite reports a missing folder, a permission problem and a locked file all
 * as "unable to open database file": find out which one it is.
 */
export function describeOpenFailure(file: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const folder = path.dirname(file);
  const who = os.userInfo().username;
  const parts = [`Impossibile aprire il database ${file} (${reason}).`];
  if (!existsSync(folder)) {
    parts.push(`La cartella ${folder} non esiste.`);
  } else {
    const probe = path.join(folder, `.prova-scrittura-${process.pid}`);
    try {
      writeFileSync(probe, "");
      rmSync(probe, { force: true });
      parts.push(
        existsSync(file)
          ? "La cartella è scrivibile: il file è probabilmente bloccato da un altro programma (antivirus, copia di sicurezza) o danneggiato."
          : "La cartella è scrivibile ma SQLite non riesce a creare il file.",
      );
    } catch (probeError) {
      const code = (probeError as NodeJS.ErrnoException).code ?? "errore";
      parts.push(
        `L'utente «${who}» non può scrivere in ${folder} (${code}): la cartella è riservata ad amministratori e sistema, avvia Mail Router come amministratore.`,
      );
    }
  }
  return parts.join(" ");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newRuleId(): string {
  return `r_${randomBytes(4).toString("hex")}`;
}

export class Store {
  readonly db: Database;

  constructor(file: string) {
    try {
      this.db = new Database(file, { create: true, strict: true });
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      throw new Error(describeOpenFailure(file, error));
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.query("PRAGMA user_version").get() as { user_version: number };
    for (let version = row.user_version + 1; version <= SCHEMA_VERSION; version++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.exec(`PRAGMA user_version = ${version}`);
      })();
    }
  }

  // ---- meta -------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = $key").get({ key }) as
      | { value: string }
      | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query("INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run({ key, value });
  }

  // ---- panel sessions ---------------------------------------------------

  /** Stores only the hash of a session or one-time login token. */
  addUiToken(tokenHash: string, kind: "session" | "once", ttlMs: number): void {
    const now = new Date();
    this.db
      .query(
        `INSERT INTO ui_sessions (token_hash, kind, created_at, expires_at) VALUES ($tokenHash, $kind, $created, $expires)
         ON CONFLICT (token_hash) DO NOTHING`,
      )
      .run({ tokenHash, kind, created: now.toISOString(), expires: new Date(now.getTime() + ttlMs).toISOString() });
    this.db.query("DELETE FROM ui_sessions WHERE expires_at < $now").run({ now: now.toISOString() });
  }

  hasUiToken(tokenHash: string, kind: "session" | "once"): boolean {
    return Boolean(
      this.db
        .query("SELECT 1 FROM ui_sessions WHERE token_hash = $tokenHash AND kind = $kind AND expires_at > $now")
        .get({ tokenHash, kind, now: nowIso() }),
    );
  }

  /** A one-time token works once: consuming it deletes it. */
  consumeUiToken(tokenHash: string, kind: "once"): boolean {
    const found = this.hasUiToken(tokenHash, kind);
    if (found) this.removeUiToken(tokenHash);
    return found;
  }

  removeUiToken(tokenHash: string): void {
    this.db.query("DELETE FROM ui_sessions WHERE token_hash = $tokenHash").run({ tokenHash });
  }

  // ---- rules ------------------------------------------------------------

  listRules(): RuleRow[] {
    return this.db
      .query("SELECT * FROM rules ORDER BY priority ASC, created_at ASC")
      .all() as RuleRow[];
  }

  getRule(id: string): RuleRow | null {
    return (this.db.query("SELECT * FROM rules WHERE id = $id").get({ id }) as RuleRow | null) ?? null;
  }

  createRule(input: {
    name: string;
    description: string;
    code: string;
    mode: RuleMode;
    priority: number;
  }): RuleRow {
    const now = nowIso();
    const row: RuleRow = { id: newRuleId(), version: 1, created_at: now, updated_at: now, ...input };
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO rules (id, name, description, code, mode, priority, version, created_at, updated_at)
           VALUES ($id, $name, $description, $code, $mode, $priority, $version, $created_at, $updated_at)`,
        )
        .run({ ...row });
      this.saveVersion(row, "created");
    })();
    return row;
  }

  updateRule(
    id: string,
    patch: Partial<Pick<RuleRow, "name" | "description" | "code" | "mode" | "priority">>,
  ): RuleRow {
    const current = this.getRule(id);
    if (!current) throw new Error(`Regola ${id} non trovata`);
    const next: RuleRow = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      version: current.version + 1,
      updated_at: nowIso(),
    };
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE rules SET name = $name, description = $description, code = $code, mode = $mode,
             priority = $priority, version = $version, updated_at = $updated_at WHERE id = $id`,
        )
        .run({
          id,
          name: next.name,
          description: next.description,
          code: next.code,
          mode: next.mode,
          priority: next.priority,
          version: next.version,
          updated_at: next.updated_at,
        });
      this.saveVersion(next, "updated");
    })();
    return next;
  }

  deleteRule(id: string): RuleRow {
    const current = this.getRule(id);
    if (!current) throw new Error(`Regola ${id} non trovata`);
    this.db.transaction(() => {
      this.saveVersion({ ...current, version: current.version + 1 }, "deleted");
      this.db.query("DELETE FROM rules WHERE id = $id").run({ id });
    })();
    return current;
  }

  /** Brings a rule back to a saved version — also a deleted rule, under its old id. */
  restoreRule(id: string, version: number): RuleRow {
    const snapshot = this.db
      .query("SELECT * FROM rule_versions WHERE rule_id = $id AND version = $version")
      .get({ id, version }) as RuleVersionRow | null;
    if (!snapshot) throw new Error(`Versione ${version} della regola ${id} non trovata`);
    const fields = {
      name: snapshot.name,
      description: snapshot.description,
      code: snapshot.code,
      mode: snapshot.mode,
      priority: snapshot.priority,
    };
    if (this.getRule(id)) return this.updateRule(id, fields);
    const latest = this.db
      .query("SELECT MAX(version) AS version FROM rule_versions WHERE rule_id = $id")
      .get({ id }) as { version: number };
    const now = nowIso();
    const row: RuleRow = { id, version: latest.version + 1, created_at: now, updated_at: now, ...fields };
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO rules (id, name, description, code, mode, priority, version, created_at, updated_at)
           VALUES ($id, $name, $description, $code, $mode, $priority, $version, $created_at, $updated_at)`,
        )
        .run({ ...row });
      this.saveVersion(row, "created");
    })();
    return row;
  }

  ruleVersions(id: string): RuleVersionRow[] {
    return this.db
      .query("SELECT * FROM rule_versions WHERE rule_id = $id ORDER BY version DESC")
      .all({ id }) as RuleVersionRow[];
  }

  deletedRules(): RuleVersionRow[] {
    return this.db
      .query(
        `SELECT v.* FROM rule_versions v
         WHERE v.change = 'deleted' AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.id = v.rule_id)
         ORDER BY v.saved_at DESC`,
      )
      .all() as RuleVersionRow[];
  }

  private saveVersion(row: RuleRow, change: RuleVersionRow["change"]): void {
    this.db
      .query(
        `INSERT INTO rule_versions (rule_id, version, change, name, description, code, mode, priority, saved_at)
         VALUES ($rule_id, $version, $change, $name, $description, $code, $mode, $priority, $saved_at)`,
      )
      .run({
        rule_id: row.id,
        version: row.version,
        change,
        name: row.name,
        description: row.description,
        code: row.code,
        mode: row.mode,
        priority: row.priority,
        saved_at: nowIso(),
      });
  }

  ruleStats(sinceIso: string): Map<string, { evaluated: number; matched: number; errors: number; lastMatchAt: string | null }> {
    const rows = this.db
      .query(
        `SELECT rr.rule_id AS rule_id, COUNT(*) AS evaluated, SUM(rr.matched) AS matched,
                SUM(CASE WHEN rr.error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
                MAX(CASE WHEN rr.matched = 1 THEN e.created_at END) AS last_match_at
         FROM rule_results rr JOIN evaluations e ON e.id = rr.evaluation_id
         WHERE e.created_at >= $since AND e.origin = 'watch'
         GROUP BY rr.rule_id`,
      )
      .all({ since: sinceIso }) as {
      rule_id: string;
      evaluated: number;
      matched: number;
      errors: number;
      last_match_at: string | null;
    }[];
    return new Map(
      rows.map((row) => [
        row.rule_id,
        { evaluated: row.evaluated, matched: row.matched ?? 0, errors: row.errors ?? 0, lastMatchAt: row.last_match_at },
      ]),
    );
  }

  // ---- data -------------------------------------------------------------

  listData(): DataRow[] {
    return this.db.query("SELECT * FROM data_entries ORDER BY key").all() as DataRow[];
  }

  getData(key: string): DataRow | null {
    return (this.db.query("SELECT * FROM data_entries WHERE key = $key").get({ key }) as DataRow | null) ?? null;
  }

  setData(key: string, value: unknown, description: string): void {
    this.db
      .query(
        `INSERT INTO data_entries (key, value, description, updated_at) VALUES ($key, $value, $description, $now)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, description = excluded.description, updated_at = excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value), description, now: nowIso() });
  }

  deleteData(key: string): boolean {
    return this.db.query("DELETE FROM data_entries WHERE key = $key").run({ key }).changes > 0;
  }

  dataObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.listData()) out[row.key] = JSON.parse(row.value);
    return out;
  }

  // ---- watch state ------------------------------------------------------

  getWatchState(watchId: string): { uidValidity: string; lastUid: number } | null {
    const row = this.db
      .query("SELECT uid_validity, last_uid FROM watch_state WHERE watch_id = $watchId")
      .get({ watchId }) as { uid_validity: string; last_uid: number } | null;
    return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null;
  }

  setWatchState(watchId: string, uidValidity: string, lastUid: number): void {
    this.db
      .query(
        `INSERT INTO watch_state (watch_id, uid_validity, last_uid, updated_at) VALUES ($watchId, $uidValidity, $lastUid, $now)
         ON CONFLICT (watch_id) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
      )
      .run({ watchId, uidValidity, lastUid, now: nowIso() });
  }

  // ---- evaluations and actions -----------------------------------------

  /**
   * Persists one evaluation, its per-rule results and planned actions — and,
   * for the watcher, advances the folder watermark in the same transaction, so
   * a crash can neither lose a decision nor run one twice.
   */
  recordEvaluation(
    evaluation: EvaluationInput,
    results: RuleResultInput[],
    actions: ActionInput[],
    watermark?: { watchId: string; uidValidity: string; lastUid: number },
  ): number {
    return this.db.transaction(() => {
      const now = nowIso();
      const inserted = this.db
        .query(
          `INSERT INTO evaluations (account, folder, uid_validity, uid, message_id, subject, from_address, from_name, date,
             origin, engine_mode, matched, note, created_at)
           VALUES ($account, $folder, $uidValidity, $uid, $messageId, $subject, $fromAddress, $fromName, $date,
             $origin, $engineMode, $matched, $note, $now)`,
        )
        .run({
          ...evaluation,
          matched: evaluation.matched ? 1 : 0,
          note: evaluation.note ?? null,
          now,
        });
      const evaluationId = Number(inserted.lastInsertRowid);
      const insertResult = this.db.query(
        `INSERT INTO rule_results (evaluation_id, rule_id, rule_name, rule_version, rule_mode, matched, decision, error, duration_ms)
         VALUES ($evaluationId, $ruleId, $ruleName, $ruleVersion, $ruleMode, $matched, $decision, $error, $durationMs)`,
      );
      for (const result of results) {
        insertResult.run({
          evaluationId,
          ...result,
          matched: result.matched ? 1 : 0,
          decision: result.decision === undefined || result.decision === null ? null : JSON.stringify(result.decision),
        });
      }
      for (const action of actions) this.insertAction(action, evaluationId, now);
      if (watermark) this.setWatchState(watermark.watchId, watermark.uidValidity, watermark.lastUid);
      return evaluationId;
    })();
  }

  insertAction(action: ActionInput, evaluationId: number | null, now = nowIso()): number {
    const inserted = this.db
      .query(
        `INSERT INTO actions (evaluation_id, seq, rule_id, account, folder, uid_validity, uid, message_id, type, payload, raw,
           status, attempts, next_attempt_at, last_error, result, origin, created_at, updated_at)
         VALUES ($evaluationId, $seq, $ruleId, $account, $folder, $uidValidity, $uid, $messageId, $type, $payload, $raw,
           $status, 0, NULL, $lastError, $result, $origin, $now, $now)`,
      )
      .run({
        evaluationId,
        seq: action.seq,
        ruleId: action.ruleId,
        account: action.account,
        folder: action.folder,
        uidValidity: action.uidValidity,
        uid: action.uid,
        messageId: action.messageId,
        type: action.type,
        payload: JSON.stringify(action.payload ?? {}),
        raw: action.raw ?? null,
        status: action.status,
        lastError: action.lastError ?? null,
        result: action.result === undefined ? null : JSON.stringify(action.result),
        origin: action.origin,
        now,
      });
    return Number(inserted.lastInsertRowid);
  }

  /** Recipients this message was already (or is about to be) forwarded to, across all evaluations. */
  forwardedRecipients(account: string, messageId: string | null, folder: string, uid: number): Set<string> {
    const rows = this.db
      .query(
        `SELECT payload FROM actions
         WHERE type = 'forward' AND status IN ('pending', 'running', 'done') AND account = $account
           AND (($messageId IS NOT NULL AND message_id = $messageId) OR (folder = $folder AND uid = $uid))`,
      )
      .all({ account, messageId, folder, uid }) as { payload: string }[];
    const recipients = new Set<string>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { to?: string[]; cc?: string[] };
      for (const address of [...(payload.to ?? []), ...(payload.cc ?? [])]) recipients.add(address.toLowerCase());
    }
    return recipients;
  }

  dueEvaluationIds(limit = 20): number[] {
    const rows = this.db
      .query(
        `SELECT evaluation_id FROM actions
         WHERE status = 'pending' AND evaluation_id IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at <= $now)
         GROUP BY evaluation_id ORDER BY MIN(id) LIMIT $limit`,
      )
      .all({ now: nowIso(), limit }) as { evaluation_id: number }[];
    return rows.map((row) => row.evaluation_id);
  }

  actionsForEvaluation(evaluationId: number): ActionRow[] {
    return this.db
      .query("SELECT * FROM actions WHERE evaluation_id = $evaluationId ORDER BY seq ASC, id ASC")
      .all({ evaluationId }) as ActionRow[];
  }

  getAction(id: number): ActionRow | null {
    return (this.db.query("SELECT * FROM actions WHERE id = $id").get({ id }) as ActionRow | null) ?? null;
  }

  markActionRunning(id: number): void {
    this.db
      .query("UPDATE actions SET status = 'running', attempts = attempts + 1, updated_at = $now WHERE id = $id")
      .run({ id, now: nowIso() });
  }

  finishAction(id: number, status: ActionStatus, details: { error?: string | null; result?: unknown; retryAt?: string | null } = {}): void {
    this.db
      .query(
        `UPDATE actions SET status = $status, last_error = $error, result = COALESCE($result, result),
           next_attempt_at = $retryAt, updated_at = $now,
           raw = CASE WHEN $status IN ('done', 'cancelled', 'skipped') THEN NULL ELSE raw END
         WHERE id = $id`,
      )
      .run({
        id,
        status,
        error: details.error ?? null,
        result: details.result === undefined ? null : JSON.stringify(details.result),
        retryAt: details.retryAt ?? null,
        now: nowIso(),
      });
  }

  /** After a crash, actions caught mid-flight go back to the queue. */
  recoverRunningActions(): number {
    return this.db
      .query("UPDATE actions SET status = 'pending', updated_at = $now WHERE status = 'running'")
      .run({ now: nowIso() }).changes;
  }

  cancelPendingRuleActions(reason: string): number {
    return this.db
      .query(
        `UPDATE actions SET status = 'cancelled', last_error = $reason, raw = NULL, updated_at = $now
         WHERE status = 'pending' AND origin = 'rule'`,
      )
      .run({ reason, now: nowIso() }).changes;
  }

  retryErroredActions(id?: number): number {
    const where = id === undefined ? "" : " AND id = $id";
    return this.db
      .query(
        `UPDATE actions SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = $now
         WHERE origin = 'rule' AND status = 'error'${where}`,
      )
      .run(id === undefined ? { now: nowIso() } : { id, now: nowIso() }).changes;
  }

  outboxCounts(): Record<string, number> {
    const rows = this.db
      .query(
        `SELECT status, COUNT(*) AS count FROM actions WHERE status IN ('pending', 'running', 'error') GROUP BY status`,
      )
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  listActions(filter: { status?: ActionStatus; limit: number }): ActionRow[] {
    const sql = filter.status
      ? "SELECT * FROM actions WHERE status = $status ORDER BY id DESC LIMIT $limit"
      : "SELECT * FROM actions ORDER BY id DESC LIMIT $limit";
    return this.db.query(sql).all(filter.status ? { status: filter.status, limit: filter.limit } : { limit: filter.limit }) as ActionRow[];
  }

  listEvaluations(filter: {
    limit: number;
    sinceIso?: string;
    ruleId?: string;
    onlyMatched?: boolean;
    account?: string;
    folder?: string;
    uid?: number;
    messageId?: string;
  }): EvaluationRow[] {
    const clauses: string[] = [];
    const params: Record<string, string | number> = { limit: filter.limit };
    if (filter.sinceIso) {
      clauses.push("e.created_at >= $since");
      params.since = filter.sinceIso;
    }
    if (filter.onlyMatched) clauses.push("e.matched = 1");
    if (filter.account) {
      clauses.push("e.account = $account");
      params.account = filter.account;
    }
    if (filter.folder) {
      clauses.push("e.folder = $folder");
      params.folder = filter.folder;
    }
    if (filter.uid !== undefined) {
      clauses.push("e.uid = $uid");
      params.uid = filter.uid;
    }
    if (filter.messageId) {
      clauses.push("e.message_id = $messageId");
      params.messageId = filter.messageId;
    }
    if (filter.ruleId) {
      clauses.push("EXISTS (SELECT 1 FROM rule_results rr WHERE rr.evaluation_id = e.id AND rr.rule_id = $ruleId AND rr.matched = 1)");
      params.ruleId = filter.ruleId;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .query(`SELECT e.* FROM evaluations e ${where} ORDER BY e.id DESC LIMIT $limit`)
      .all(params) as EvaluationRow[];
  }

  ruleResultsFor(evaluationIds: number[]): RuleResultRow[] {
    if (!evaluationIds.length) return [];
    return this.db
      .query(`SELECT * FROM rule_results WHERE evaluation_id IN (${evaluationIds.map(() => "?").join(",")})`)
      .all(...evaluationIds) as RuleResultRow[];
  }

  actionsFor(evaluationIds: number[]): ActionRow[] {
    if (!evaluationIds.length) return [];
    return this.db
      .query(
        `SELECT id, evaluation_id, seq, rule_id, account, folder, uid_validity, uid, message_id, type, payload, NULL AS raw,
                status, attempts, next_attempt_at, last_error, result, origin, created_at, updated_at
         FROM actions WHERE evaluation_id IN (${evaluationIds.map(() => "?").join(",")}) ORDER BY seq`,
      )
      .all(...evaluationIds) as ActionRow[];
  }

  purgeOlderThan(cutoffIso: string): { evaluations: number; actions: number } {
    return this.db.transaction(() => {
      const evaluations = this.db
        .query("DELETE FROM evaluations WHERE created_at < $cutoff")
        .run({ cutoff: cutoffIso }).changes;
      const actions = this.db
        .query("DELETE FROM actions WHERE evaluation_id IS NULL AND created_at < $cutoff")
        .run({ cutoff: cutoffIso }).changes;
      return { evaluations, actions };
    })();
  }
}
