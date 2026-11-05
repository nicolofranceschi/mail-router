const dateTime = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" });
const time = new Intl.DateTimeFormat("it-IT", { timeStyle: "short" });

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date();
  return date.toDateString() === today.toDateString() ? `oggi ${time.format(date)}` : dateTime.format(date);
}

export function relative(value: string | null | undefined): string {
  if (!value) return "mai";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "adesso";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min fa`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h fa`;
  return formatDate(value);
}

export const ENGINE_MODE: Record<string, { label: string; help: string }> = {
  live: { label: "Attivo", help: "Le regole attive inoltrano e spostano davvero la posta." },
  shadow: { label: "In prova", help: "Le regole vengono valutate e registrate, ma non viene inviato né spostato nulla." },
  paused: { label: "In pausa", help: "I nuovi messaggi aspettano: verranno valutati alla ripresa." },
};

export const RULE_MODE: Record<string, { label: string; tone: string }> = {
  enabled: { label: "Attiva", tone: "ok" },
  shadow: { label: "In prova", tone: "info" },
  disabled: { label: "Spenta", tone: "" },
};

export const ACTION_TYPE: Record<string, string> = {
  forward: "Inoltro",
  flags: "Etichetta",
  unflags: "Etichetta tolta",
  seen: "Segna come letto",
  move: "Spostamento",
  reply: "Risposta",
  send: "Invio",
};

export const ACTION_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "in coda", tone: "info" },
  running: { label: "in corso", tone: "info" },
  done: { label: "fatto", tone: "ok" },
  error: { label: "errore", tone: "err" },
  simulated: { label: "simulato", tone: "" },
  blocked: { label: "bloccato", tone: "warn" },
  skipped: { label: "saltato", tone: "" },
  cancelled: { label: "annullato", tone: "" },
  eseguirebbe: { label: "verrebbe eseguito", tone: "info" },
};

export function describeAction(action: Record<string, any>): string {
  const recipients = [...(action.to ?? []), ...(action.cc ?? [])].join(", ");
  switch (action.type) {
    case "forward":
      return recipients ? `a ${recipients}` : "";
    case "flags":
      return (action.flags ?? []).join(", ");
    case "move":
      return action.target ? `in ${action.target}` : "";
    default:
      return "";
  }
}

export function flagLabels(flags: string[]): string[] {
  const known: Record<string, string> = {
    "\\Seen": "letto",
    "\\Flagged": "importante",
    "\\Answered": "risposto",
    $Forwarded: "inoltrato",
  };
  return flags.filter((flag) => flag !== "\\Recent").map((flag) => known[flag] ?? flag.replace(/^\$/, ""));
}

export function splitList(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// ---- watched folders -----------------------------------------------------------

export interface WatcherStatus {
  folder: string;
  connected: boolean;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export type Tone = "ok" | "info" | "warn" | "err";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Connection errors in plain Italian; anything else stays as the server wrote it. */
export function friendlyError(message: string): string {
  if (/ECONNREFUSED/.test(message)) return "il server di posta ha rifiutato la connessione";
  if (/ETIMEDOUT|ETIMEOUT|time(d)?\s?out/i.test(message)) return "il server di posta non ha risposto in tempo";
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return "il nome del server di posta non è stato trovato";
  if (/ECONNRESET|EPIPE|socket hang up/i.test(message)) return "il server di posta ha interrotto la connessione";
  if (/certificate|self.signed|CERT_/i.test(message)) return "il certificato del server di posta non è valido";
  if (/AUTHENTICATIONFAILED|authentication failed|invalid credentials/i.test(message)) return "accesso rifiutato: controlla utente e password";
  return message;
}

/**
 * A watcher reconnects by itself and keeps its last error for diagnosis, so
 * `lastError` alone does not mean something is wrong: only a folder that is not
 * connected right now is a problem. The rest is at most a past interruption.
 */
export function watcherHealth<T extends WatcherStatus>(watchers: T[]) {
  const down = watchers.filter((watcher) => !watcher.connected);
  const latest = watchers
    .filter((watcher) => watcher.connected && watcher.lastError && watcher.lastErrorAt)
    .sort((a, b) => Date.parse(b.lastErrorAt!) - Date.parse(a.lastErrorAt!))[0];
  return {
    total: watchers.length,
    connected: watchers.length - down.length,
    down,
    lastInterruption: latest ? { at: latest.lastErrorAt!, error: latest.lastError! } : null,
  };
}

/** The one sentence that answers "is everything all right?". */
export function overallState(mode: string, watchers: WatcherStatus[], failedActions: number): { tone: Tone; title: string; detail: string } {
  const { connected, down } = watcherHealth(watchers);
  if (down.length) {
    const cause = down.find((watcher) => watcher.lastError)?.lastError;
    const reason = cause ? friendlyError(cause) : "";
    return {
      tone: "err",
      title: plural(down.length, "cartella non collegata", "cartelle non collegate"),
      detail: `${reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. ` : ""}Mail Router ritenta il collegamento da solo.`,
    };
  }
  if (failedActions) {
    return {
      tone: "warn",
      title: plural(failedActions, "azione non riuscita", "azioni non riuscite"),
      detail: "Trovi i dettagli in Attività e puoi rimetterle in coda.",
    };
  }
  const folders = `${plural(connected, "cartella collegata", "cartelle collegate")}.`;
  const help = ENGINE_MODE[mode]?.help ?? "";
  if (mode === "paused") return { tone: "warn", title: "In pausa", detail: `${folders} ${help}` };
  if (mode === "shadow") return { tone: "info", title: "In prova", detail: `${folders} ${help}` };
  return { tone: "ok", title: "Tutto regolare", detail: `${folders} ${help}` };
}

/** The folder path shared by all the given folders, so each row can show only what differs. */
export function folderPrefix(paths: string[]): string {
  if (paths.length < 2) return "";
  const split = paths.map((path) => path.split("/"));
  const first = split[0]!;
  let shared = 0;
  while (shared < first.length && split.every((parts) => parts[shared] === first[shared])) shared++;
  return first.slice(0, shared).join("/");
}

export function folderTail(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path === prefix) return lastSegment(path);
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
}

export function lastSegment(path: string): string {
  return path.split("/").pop() || path;
}
