import { useEffect, useState } from "react";

import { AccountPicker, NoMailbox, SHARED, type AccountView } from "../AccountPicker";
import { tool } from "../api";
import { Button, Confirm, Empty, ErrorBox, Field, Spinner, useAction, useLoad } from "../components";
import { formatDate } from "../format";

/** Arguments that point the data tools at the chosen mailbox, or at the old shared entries. */
function target(account: string | undefined) {
  return account === SHARED ? { shared: true } : { account };
}

export function DataPage({ status, isAdmin }: { status: any; isAdmin: boolean }) {
  const accounts: AccountView[] = status?.accounts ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);
  const account = accountId ?? accounts[0]?.id;
  const entries = useLoad(() => (account ? tool("list_data", target(account)) : Promise.resolve(null)), [account]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list: any[] = entries.data?.entries ?? [];
  // Old entries shared by every mailbox: shown to administrators only while some are left.
  const hasShared = isAdmin && (account === SHARED || Boolean(entries.data?.sharedOldEntries));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dati di riferimento</h1>
          <p className="muted">
            Elenchi che le regole leggono come <span className="mono">data.nome</span>: uffici, persone, fornitori… Cambiarli qui
            cambia il comportamento delle regole senza toccarne il codice. Ogni casella ha i suoi elenchi, letti solo dalle
            sue regole.
          </p>
        </div>
        <div className="row wrap">
          <AccountPicker
            accounts={accounts}
            value={account}
            onChange={(id) => {
              setAccountId(id);
              setSelected(null);
              setCreating(false);
            }}
            sharedLabel={hasShared ? "Comuni a tutte le caselle (vecchi)" : undefined}
          />
          <Button
            disabled={!account}
            onClick={() => {
              setCreating(true);
              setSelected(null);
            }}
          >
            Nuovo elenco
          </Button>
        </div>
      </div>
      {account === SHARED ? (
        <div className="notice">
          Elenchi di prima che ogni casella avesse i suoi: li leggono le regole di tutte le caselle. Per spostarne uno in una
          casella, ricrealo lì con lo stesso nome ed eliminalo da qui.
        </div>
      ) : null}
      {entries.error ? <ErrorBox error={entries.error} onRetry={entries.reload} /> : null}
      {!account ? <NoMailbox /> : null}
      {account && !entries.data && !entries.error ? <Spinner /> : null}
      {account && entries.data ? (
        <div className="split">
          <div className="card flush">
            {list.length ? (
              <div className="list">
                {list.map((entry: any) => (
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
              account={account}
              onSaved={(key) => {
                setCreating(false);
                setSelected(key);
                entries.reload();
              }}
              onDeleted={() => undefined}
            />
          ) : selected ? (
            <DataEditor
              key={`${account}:${selected}`}
              account={account}
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
      ) : null}
    </div>
  );
}

function DataEditor({
  account,
  entryKey,
  onSaved,
  onDeleted,
}: {
  account: string;
  entryKey?: string;
  onSaved: (key: string) => void;
  onDeleted: () => void;
}) {
  const existing = useLoad(
    () => (entryKey ? tool("get_data", { ...target(account), key: entryKey }) : Promise.resolve(null)),
    [account, entryKey],
  );
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
    const saved = await run(() => tool("set_data", { ...target(account), key, value, description }), "Elenco salvato");
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
            await tool("delete_data", { ...target(account), key: entryKey });
            onDeleted();
          }}
        >
          Le regole che usano <span className="mono">data.{entryKey}</span> non lo troveranno più.
        </Confirm>
      ) : null}
    </div>
  );
}
