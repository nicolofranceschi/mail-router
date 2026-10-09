import { useState } from "react";

import { tool } from "../api";
import { ActionChips, Button, Check, Empty, ErrorBox, Spinner, useAction, useLoad } from "../components";
import { formatDate } from "../format";
import { ActivityRow } from "./Overview";

export function Activity() {
  const [onlyMatched, setOnlyMatched] = useState(false);
  const [limit, setLimit] = useState(50);
  const activity = useLoad(() => tool("list_activity", { limit, onlyMatched }), [limit, onlyMatched], 15_000);
  const failed = useLoad(() => tool("list_outbox", { status: "error", limit: 50 }), [], 30_000);
  const { busy, run } = useAction();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Attività</h1>
          <p className="muted">Ogni messaggio nuovo, le regole che lo hanno riconosciuto e cosa è stato fatto.</p>
        </div>
        <div className="row">
          <Check checked={onlyMatched} onChange={setOnlyMatched}>
            Solo con regole applicate
          </Check>
          <Button small onClick={activity.reload}>
            Aggiorna
          </Button>
        </div>
      </div>

      {failed.data?.length ? (
        <div className="card stack">
          <div className="row spread">
            <h2>Azioni non riuscite</h2>
            <Button
              small
              busy={busy}
              onClick={() =>
                run(async () => {
                  await tool("retry_failed");
                  failed.reload();
                  activity.reload();
                }, "Rimesse in coda: partiranno se Mail Router è attivo")
              }
            >
              Riprova tutte
            </Button>
          </div>
          {failed.data.map((action: any) => (
            <div key={action.id} className="stack tight">
              <span className="small muted">
                {formatDate(action.createdAt)} · {action.folder} · UID {action.uid}
              </span>
              <ActionChips actions={[action]} />
            </div>
          ))}
        </div>
      ) : null}

      <div className="card flush">
        {activity.error ? <ErrorBox error={activity.error} onRetry={activity.reload} /> : null}
        {!activity.data ? (
          <div style={{ padding: 18 }}>
            <Spinner />
          </div>
        ) : activity.data.activity.length ? (
          <div className="list">
            {activity.data.activity.map((entry: any) => (
              <ActivityRow key={entry.evaluationId} entry={entry} />
            ))}
          </div>
        ) : (
          <Empty>Ancora nessun messaggio.</Empty>
        )}
      </div>
      {activity.data && activity.data.activity.length >= limit ? (
        <div className="row" style={{ justifyContent: "center" }}>
          <Button onClick={() => setLimit(Math.min(limit + 50, 200))} disabled={limit >= 200}>
            Mostra altri
          </Button>
        </div>
      ) : null}
    </div>
  );
}
