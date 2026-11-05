import { tool } from "../api";
import { ActionChips, Badge, Button, Empty, ErrorBox, Spinner, useAction, useLoad } from "../components";
import { folderPrefix, folderTail, formatDate, friendlyError, lastSegment, overallState, relative, watcherHealth } from "../format";
import { StatusIcon } from "../icons";

export function Overview({ status }: { status: ReturnType<typeof useLoad<any>> }) {
  const activity = useLoad(() => tool("list_activity", { limit: 8 }), [], 20_000);
  const { busy, run } = useAction();
  const data = status.data;

  if (status.error && !data) return <ErrorBox error={status.error} onRetry={status.reload} />;
  if (!data) return <Spinner />;

  const failed = data.outbox?.error ?? 0;
  const queued = (data.outbox?.pending ?? 0) + (data.outbox?.running ?? 0);
  const watchers: any[] = data.watchers;
  const health = watcherHealth(watchers);
  const state = overallState(data.mode, watchers, failed);
  const evaluated = watchers.reduce((sum, watcher) => sum + (watcher.processedSinceStart ?? 0), 0);

  return (
    <div className="page">
      <section className={`hero ${state.tone}`}>
        <div className="hero-icon">
          <StatusIcon tone={state.tone} />
        </div>
        <div className="grow">
          <h1 className="hero-title">{state.title}</h1>
          <p className="muted">{state.detail}</p>
        </div>
      </section>

      <div className="metrics">
        <Metric label="Cartelle collegate" value={`${health.connected}/${health.total}`}>
          {health.down.length ? `${health.down.length} da ricollegare` : "tutte in ascolto"}
        </Metric>
        <Metric label="Regole attive" value={data.rules.enabled}>
          {data.rules.shadow} in prova · {data.rules.disabled} spente
        </Metric>
        <Metric label="Coda di invio" value={queued}>
          {failed ? (
            <span className="row wrap">
              <Badge tone="err">{failed} non riuscite</Badge>
              <Button
                small
                busy={busy}
                onClick={() =>
                  run(async () => {
                    await tool("retry_failed");
                    status.reload();
                  }, "Azioni rimesse in coda")
                }
              >
                Riprova
              </Button>
            </span>
          ) : (
            "nessun errore"
          )}
        </Metric>
        <Metric label="Messaggi valutati" value={evaluated.toLocaleString("it-IT")}>
          dall'avvio, {uptime(data.uptimeMinutes)} fa
        </Metric>
      </div>

      <FolderPanel watchers={watchers} showAccount={(data.accounts?.length ?? 1) > 1} />

      <section className="card flush">
        <div className="panel-head">
          <h2>Ultimi messaggi</h2>
          <a href="#/attivita" className="small">
            Tutta l'attività
          </a>
        </div>
        {activity.data ? (
          activity.data.activity.length ? (
            <div className="list">
              {activity.data.activity.map((entry: any) => (
                <ActivityRow key={entry.evaluationId} entry={entry} />
              ))}
            </div>
          ) : (
            <Empty>Nessun messaggio nuovo da quando il servizio è partito.</Empty>
          )
        ) : (
          <div style={{ padding: 18 }}>
            <Spinner />
          </div>
        )}
      </section>

      {data.rules.total === 0 ? (
        <div className="notice">
          <b>Nessuna regola ancora.</b> Apri Claude Code sul tuo computer (collegato con il comando in Impostazioni) e
          chiedi, per esempio: «le mail della Cassa Edile vanno all'ufficio paghe». Claude scrive la regola, la prova sui
          messaggi veri e te la mostra qui.
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, children }: { label: string; value: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <span className="metric-sub">{children}</span>
    </div>
  );
}

function FolderPanel({ watchers, showAccount }: { watchers: any[]; showAccount: boolean }) {
  const { down, lastInterruption } = watcherHealth(watchers);
  const prefix = folderPrefix(watchers.map((watcher) => watcher.folder));
  const ordered = [...down, ...watchers.filter((watcher) => watcher.connected)];

  return (
    <section className="card flush">
      <div className="panel-head">
        <h2>Cartelle sorvegliate</h2>
        <span className="muted small ellipsis" title={prefix}>
          {prefix ? `in ${prefix} · ` : ""}messaggi valutati dall'avvio
        </span>
      </div>
      <div className="folder-grid">
        {ordered.map((watcher) => (
          <div
            key={watcher.id}
            className={`folder-row ${watcher.connected ? "" : "down"}`}
            title={`${watcher.folder}\nUltimo controllo: ${relative(watcher.lastCheckAt)}`}
          >
            <span className={`dot ${watcher.connected ? "ok" : "err"}`} />
            <span className="folder-name ellipsis">
              {folderTail(watcher.folder, prefix)}
              {showAccount ? <span className="muted small"> ({watcher.account})</span> : null}
            </span>
            <span className="folder-count">{watcher.processedSinceStart}</span>
            {!watcher.connected ? (
              <span className="folder-error" title={watcher.lastError ?? undefined}>
                {watcher.lastError ? `${friendlyError(watcher.lastError)} · ${formatDate(watcher.lastErrorAt)}` : "collegamento in corso"}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {lastInterruption ? (
        <p className="panel-note" title={lastInterruption.error}>
          Ultima interruzione {formatDate(lastInterruption.at)}: {friendlyError(lastInterruption.error)}. Ricollegamento automatico riuscito.
        </p>
      ) : null}
    </section>
  );
}

export function ActivityRow({ entry }: { entry: any }) {
  const reason = entry.rules.find((rule: any) => rule.reason)?.reason;
  const failedRules = entry.rules.filter((rule: any) => rule.error);
  return (
    <div className={`list-item activity ${entry.rules.length ? "" : "quiet"}`}>
      <span className="when">{formatDate(entry.at)}</span>
      <div className="stack tight" style={{ minWidth: 0 }}>
        <span className="subject ellipsis">{entry.message.subject || "(senza oggetto)"}</span>
        <span className="muted small ellipsis">
          {entry.message.from ?? "mittente sconosciuto"} · <span title={entry.message.folder}>{lastSegment(entry.message.folder)}</span>
          {entry.origin === "reprocess" ? " · rielaborato" : ""}
        </span>
        {entry.note ? <span className="small muted">{entry.note}</span> : null}
        {entry.rules.length ? (
          <div className="row wrap small">
            {entry.rules.map((rule: any) => (
              <Badge key={rule.ruleId} tone={rule.error ? "err" : rule.mode === "enabled" ? "ok" : "info"}>
                {rule.rule}
                {rule.error ? ": errore" : rule.mode === "shadow" ? " (prova)" : ""}
              </Badge>
            ))}
            {reason ? <span className="muted">{reason}</span> : null}
          </div>
        ) : null}
        {failedRules.map((rule: any) => (
          <span key={rule.ruleId} className="small" style={{ color: "var(--err)" }}>
            {rule.rule}: {rule.error}
          </span>
        ))}
        <ActionChips actions={entry.actions} />
      </div>
    </div>
  );
}

function uptime(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} ore`;
  return `${Math.round(minutes / 1440)} giorni`;
}
