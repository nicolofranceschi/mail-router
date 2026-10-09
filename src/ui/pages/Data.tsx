import { useEffect, useState } from "react";

import { tool } from "../api";
import { Button, Confirm, Empty, ErrorBox, Field, Spinner, useAction, useLoad } from "../components";
import { formatDate } from "../format";

export function DataPage() {
  const entries = useLoad(() => tool("list_data"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dati di riferimento</h1>
          <p className="muted">
            Elenchi che le regole leggono come <span className="mono">data.nome</span>: uffici, persone, fornitori… Cambiarli qui
            cambia il comportamento delle regole senza toccarne il codice.
          </p>
        </div>
        <Button
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
        >
          Nuovo elenco
        </Button>
      </div>
      {entries.error ? <ErrorBox error={entries.error} onRetry={entries.reload} /> : null}
      {!entries.data ? (
        <Spinner />
      ) : (
        <div className="split">
          <div className="card flush">
            {entries.data.length ? (
              <div className="list">
                {entries.data.map((entry: any) => (
                  <div
                    key={entry.key}
                    className={`list-item clickable ${selected === entry.key ? "selected" : ""}`}
                    onClick={() => {
                      setSelected(entry.key);
                      setCreating(false);
                    }}
                  >
                    <div className="grow stack tight">
                      <b className="mono">{entry.key}</b>
                      <span className="muted small">{entry.description || "—"}</span>
                      <span className="muted small">aggiornato {formatDate(entry.updatedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>Nessun elenco. Claude li crea quando servono alle regole.</Empty>
            )}
          </div>
          {creating ? (
            <DataEditor
              key="new"
              onSaved={(key) => {
                setCreating(false);
                setSelected(key);
                entries.reload();
              }}
              onDeleted={() => undefined}
            />
          ) : selected ? (
            <DataEditor
              key={selected}
              entryKey={selected}
              onSaved={() => entries.reload()}
              onDeleted={() => {
                setSelected(null);
                entries.reload();
              }}
            />
          ) : (
            <div className="card muted">Seleziona un elenco per vederlo o modificarlo.</div>
          )}
        </div>
      )}
    </div>
  );
}

function DataEditor({ entryKey, onSaved, onDeleted }: { entryKey?: string; onSaved: (key: string) => void; onDeleted: () => void }) {
  const existing = useLoad(() => (entryKey ? tool("get_data", { key: entryKey }) : Promise.resolve(null)), [entryKey]);
  const [key, setKey] = useState(entryKey ?? "");
  const [description, setDescription] = useState("");
  const [text, setText] = useState(entryKey ? "" : '{\n  "esempio": "valore"\n}');
  const [parseError, setParseError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, run } = useAction();

  useEffect(() => {
    if (existing.data) {
      setDescription(existing.data.description ?? "");
      setText(JSON.stringify(existing.data.value, null, 2));
    }
  }, [existing.data]);

  if (entryKey && existing.error) return <ErrorBox error={existing.error} onRetry={existing.reload} />;
  if (entryKey && !existing.data) return <Spinner />;

  const save = async () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
      setParseError(null);
    } catch (failure) {
      setParseError(`Il contenuto non è JSON valido: ${(failure as Error).message}`);
      return;
    }
    const saved = await run(() => tool("set_data", { key, value, description }), "Elenco salvato");
    if (saved) onSaved(key);
  };

  return (
    <div className="card stack">
      <div className="form-grid">
        <Field label="Nome" hint="Lettere, numeri e _ (es. uffici)">
          <input className="input mono" value={key} disabled={Boolean(entryKey)} onChange={(event) => setKey(event.target.value)} />
        </Field>
        <Field label="Descrizione">
          <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>
      <Field label="Contenuto (JSON)">
        <textarea className="input code" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      {parseError ? <div className="notice err">{parseError}</div> : null}
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!key.trim()} onClick={save}>
          Salva
        </Button>
        <span className="grow" />
        {entryKey ? (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Elimina
          </Button>
        ) : null}
      </div>
      {confirmDelete && entryKey ? (
        <Confirm
          title="Eliminare l'elenco?"
          confirmLabel="Elimina"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await tool("delete_data", { key: entryKey });
            onDeleted();
          }}
        >
          Le regole che usano <span className="mono">data.{entryKey}</span> non lo troveranno più.
        </Confirm>
      ) : null}
    </div>
  );
}
