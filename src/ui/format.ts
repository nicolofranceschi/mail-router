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
