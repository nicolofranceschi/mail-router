import { tool } from "../api";
import { ActionChips, Badge, Button, Empty, ErrorBox, Spinner, useAction, useLoad } from "../components";
import { ENGINE_MODE, formatDate, relative } from "../format";

export function Overview({ status }: { status: ReturnType<typeof useLoad<any>> }) {
  const activity = useLoad(() => tool("list_activity", { limit: 8 }), [], 20_000);
  const { busy, run } = useAction();
  const data = status.data;

  if (status.error && !data) return <ErrorBox error={status.error} onRetry={status.reload} />;
  if (!data) return <Spinner />;

  const failed = data.outbox?.error ?? 0;
  const queued = (data.outbox?.pending ?? 0) + (data.outbox?.running ?? 0);

  return (
    <div className="page">
      <div className="cards">
        <div className="card stack tight">
          <span className="muted small">Modalità</span>
          <span className="stat">{ENGINE_MODE[data.mode]?.label}</span>
          <span className="muted small">{ENGINE_MODE[data.mode]?.help}</span>
        </div>
        <div className="card stack tight">
          <span className="muted small">Regole</span>
          <span className="stat">{data.rules.enabled} attive</span>
          <span className="muted small">
            {data.rules.shadow} in prova · {data.rules.disabled} spente
          </span>
        </div>
        <div className="card stack tight">
          <span className="muted small">Coda di invio</span>
          <span className="stat">{queued}</span>
          {failed ? (
            <div className="row wrap">
              <Badge tone="err">{failed} non riuscite</Badge>
              <Button small busy={busy} onClick={() => run(async () => {
                await tool("retry_failed");
                status.reload();
              }, "Azioni rimesse in coda")}>
                Riprova
              </Button>
            </div>
          ) : (
            <span className="muted small">nessun errore</span>
          )}
        </div>
        <div className="card stack tight">
          <span className="muted small">In funzione da</span>
          <span className="stat">{uptime(data.uptimeMinutes)}</span>
          <span className="muted small">versione {data.version}</span>
        </div>
      </div>

      <div className="card stack">
        <h2>Cartelle sorvegliate</h2>
        {data.watchers.map((watcher: any) => (
          <div key={watcher.id} className="row wrap">
            <span className={`dot ${watcher.connected ? "ok" : "err"}`} />
            <span className="grow">
              <b>{watcher.folder}</b> <span className="muted small">({watcher.account})</span>
            </span>
            <span className="muted small">
              {watcher.connected ? "collegata" : "non collegata"} · ultimo controllo {relative(watcher.lastCheckAt)} ·{" "}
              {watcher.processedSinceStart} messaggi valutati
            </span>
            {watcher.lastError ? (
              <div className="notice err small" style={{ width: "100%" }}>
                {formatDate(watcher.lastErrorAt)}: {watcher.lastError}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="card flush">
        <div className="row spread" style={{ padding: "16px 18px 6px" }}>
          <h2>Ultimi messaggi</h2>
          <a href="#/attivita">Tutta l'attività</a>
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
      </div>

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

export function ActivityRow({ entry }: { entry: any }) {
  return (
    <div className="list-item">
      <div className="grow stack tight">
        <div className="row spread">
          <span className="ellipsis">
            <b>{entry.message.subject || "(senza oggetto)"}</b>
          </span>
          <span className="muted small" style={{ flex: "none" }}>
            {formatDate(entry.at)}
          </span>
        </div>
        <span className="muted small ellipsis">
          {entry.message.from ?? "mittente sconosciuto"} · {entry.message.folder}
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
            {entry.rules.find((rule: any) => rule.reason) ? (
              <span className="muted">— {entry.rules.find((rule: any) => rule.reason)?.reason}</span>
            ) : null}
          </div>
        ) : !entry.note ? (
          <span className="small muted">Nessuna regola applicata</span>
        ) : null}
        {entry.rules.filter((rule: any) => rule.error).map((rule: any) => (
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
