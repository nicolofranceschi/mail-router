import { useEffect, useState } from "react";

import {
  emptyForm,
  FolderFields,
  formFromSettings,
  ForwardFields,
  ImapFields,
  imapPayload,
  looksLikePec,
  SecurityFields,
  settingsPayload,
  SmtpFields,
  withPecDefaults,
  withSmtpDefaults,
  type Folder,
  type FormState,
} from "../AccountForm";
import { api, tool } from "../api";
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Spinner, useAction, useLoad } from "../components";

type Editing = { mode: "new" } | { mode: "edit"; id: string } | null;

/** Every mailbox the service watches: add, change or remove them. Saving restarts the service. */
export function Accounts({ onChanged }: { onChanged: () => void }) {
  const settings = useLoad(() => api("/api/settings"), []);
  const status = useLoad(() => tool("get_status"), [], 20_000);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);

  const afterSave = (message: string, willRestart: boolean) => {
    setEditing(null);
    onChanged();
    if (willRestart) {
      setRestarting(message);
      setTimeout(() => window.location.reload(), 6000);
    } else settings.reload();
  };

  if (settings.error) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return <Spinner />;
  const accounts: any[] = settings.data.accounts;
  const general = settings.data.general;

  if (editing) {
    const account = editing.mode === "edit" ? accounts.find((entry) => entry.id === editing.id) : null;
    return (
      <div className="page">
        <AccountEditor
          key={editing.mode === "edit" ? editing.id : "new"}
          account={account}
          general={general}
          onCancel={() => setEditing(null)}
          onSaved={(result) => afterSave(`Casella «${result.id}» salvata: Mail Router si riavvia…`, result.restarting)}
        />
      </div>
    );
  }

  const watchers: any[] = status.data?.watchers ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Caselle di posta</h1>
          <p className="muted">
            Ogni casella ha le sue cartelle sorvegliate; le regole e i dati di riferimento valgono per tutte (nelle regole:{" "}
            <span className="mono">email.account</span>).
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing({ mode: "new" })} disabled={Boolean(restarting)}>
          Aggiungi casella
        </Button>
      </div>
      {restarting ? <Spinner label={restarting} /> : null}
      <div className="card flush">
        {accounts.length ? (
          <div className="list">
            {accounts.map((account) => {
              const own = watchers.filter((watcher) => watcher.account === account.id);
              const failing = own.filter((watcher) => watcher.lastError);
              return (
                <div key={account.id} className="list-item">
                  <div className="grow stack tight">
                    <div className="row wrap">
                      <b>{account.id}</b>
                      <span className="muted">{account.imap.user}</span>
                      {looksLikePec(account.imap.host) ? <Badge tone="info">PEC</Badge> : null}
                      {account.smtp ? <Badge tone="ok">invio attivo</Badge> : <Badge>solo lettura</Badge>}
                      {failing.length ? <Badge tone="err">errore di collegamento</Badge> : own.length ? <Badge tone="ok">collegata</Badge> : null}
                    </div>
                    <span className="muted small">
                      {account.imap.host}:{account.imap.port} · sorveglia {account.watch.join(", ")}
                      {account.smtp ? ` · invia come ${account.smtp.from}` : ""}
                    </span>
                    {failing.map((watcher) => (
                      <span key={watcher.folder} className="small" style={{ color: "var(--err)" }}>
                        {watcher.folder}: {watcher.lastError}
                      </span>
                    ))}
                  </div>
                  <div className="row">
                    <Button small onClick={() => setEditing({ mode: "edit", id: account.id })} disabled={Boolean(restarting)}>
                      Modifica
                    </Button>
                    <Button small variant="danger" onClick={() => setRemoving(account.id)} disabled={accounts.length < 2 || Boolean(restarting)}>
                      Elimina
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty>Nessuna casella configurata.</Empty>
        )}
      </div>
      {removing ? (
        <Confirm
          title={`Eliminare la casella «${removing}»?`}
          confirmLabel="Elimina e riavvia"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const result = await api<{ restarting: boolean }>("/api/accounts/delete", { id: removing });
            afterSave(`Casella «${removing}» eliminata: Mail Router si riavvia…`, result.restarting);
          }}
        >
          Mail Router smette di leggerla. La posta resta sul server, le regole e lo storico restano; la password salvata viene
          cancellata dalla configurazione.
        </Confirm>
      ) : null}
    </div>
  );
}

function AccountEditor({
  account,
  general,
  onCancel,
  onSaved,
}: {
  account: any | null;
  general: any;
  onCancel: () => void;
  onSaved: (result: { id: string; restarting: boolean }) => void;
}) {
  const isNew = !account;
  const [state, setState] = useState<FormState>(() =>
    account ? formFromSettings({ ...general, ...account }) : { ...emptyForm(general.instanceName), allowedDomains: general.allowedDomains.join(", "), mcpPort: String(general.mcpPort) },
  );
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<Folder[]>(() =>
    account
      ? [...new Set([...account.watch, account.sentFolder, account.trashFolder].filter(Boolean))].map((path) => ({ path, specialUse: null }))
      : [],
  );
  const [tested, setTested] = useState(!isNew);
  const [pecSuggested, setPecSuggested] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const { busy, run } = useAction();

  useEffect(() => {
    if (account) void tool("list_folders", { account: account.id }).then((list: Folder[]) => setFolders(list), () => undefined);
  }, [account]);

  // A new PEC box: suggest the safer defaults once (send through a satellite box, attach the .eml).
  useEffect(() => {
    if (isNew && !pecSuggested && looksLikePec(state.imap.host)) {
      setPecSuggested(true);
      setState((current) => withPecDefaults(current));
    }
  }, [isNew, pecSuggested, state.imap.host]);

  const test = () =>
    run(async () => {
      const response = await api<{ folders: Folder[] }>("/api/settings/test-imap", { account: account?.id ?? "", imap: imapPayload(state) });
      setFolders(response.folders);
      if (isNew && !state.watch.length && response.folders.some((folder) => folder.path === "INBOX")) {
        setState((current) => ({ ...current, watch: ["INBOX"], ownAddresses: current.ownAddresses || current.imap.user }));
      }
      if (state.smtpEnabled) {
        const filled = withSmtpDefaults(state);
        await api("/api/settings/test-smtp", { account: account?.id ?? "", imap: imapPayload(filled), smtp: settingsPayload(filled).smtp });
      }
      setTested(true);
    }, "Collegamento riuscito");

  const save = async () => {
    const payload = { ...settingsPayload(withSmtpDefaults(state)), ...(isNew && name.trim() ? { id: name.trim() } : {}) };
    const result = await api<{ id: string; restarting: boolean }>("/api/accounts/save", { editing: account?.id ?? null, account: payload });
    onSaved(result);
  };

  const canTest = Boolean(state.imap.host && state.imap.user && (state.imap.password || !isNew));

  return (
    <div className="card stack">
      <div className="row spread">
        <h2>{isNew ? "Nuova casella di posta" : `Casella «${account.id}»`}</h2>
        <Button small variant="ghost" onClick={onCancel}>
          Torna all'elenco
        </Button>
      </div>
      {isNew ? (
        <Field label="Nome breve" hint="Facoltativo: identifica la casella nelle regole (email.account) e negli strumenti. Se vuoto, si ricava dall'utente IMAP.">
          <input className="input" value={name} placeholder="es. pec, amministrazione, info" onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
      ) : null}
      <h3>Lettura (IMAP)</h3>
      <ImapFields state={state} set={setState} passwordOptional={!isNew} />
      {isNew && !tested ? (
        <div className="notice small">Prova il collegamento per vedere le cartelle della casella e scegliere quali sorvegliare.</div>
      ) : (
        <>
          <h3>Cartelle</h3>
          <FolderFields state={state} set={setState} folders={folders} />
        </>
      )}
      <h3>Inoltro</h3>
      <SmtpFields state={state} set={setState} passwordOptional={!isNew} />
      {state.smtpEnabled ? <ForwardFields state={state} set={setState} folders={folders} /> : null}
      <h3>Sicurezza</h3>
      <SecurityFields state={state} set={setState} hideDomains />
      <p className="muted small">I domini a cui le regole possono inoltrare valgono per tutte le caselle: si cambiano in Impostazioni.</p>
      <div className="row">
        <Button busy={busy} onClick={test} disabled={!canTest}>
          Prova il collegamento
        </Button>
        <Button variant="primary" disabled={!tested || !state.watch.length} onClick={() => setConfirmSave(true)}>
          {isNew ? "Aggiungi" : "Salva"}
        </Button>
        <Button onClick={onCancel}>Annulla</Button>
      </div>
      {confirmSave ? (
        <Confirm title={isNew ? "Aggiungere la casella?" : "Salvare la casella?"} confirmLabel="Salva e riavvia" onClose={() => setConfirmSave(false)} onConfirm={save}>
          Prima del salvataggio viene verificato l'accesso alla casella. Poi Mail Router si riavvia per qualche secondo; le regole e
          lo storico restano.{isNew ? " La nuova casella parte dai messaggi che arrivano da ora in poi." : ""}
        </Confirm>
      ) : null}
    </div>
  );
}
