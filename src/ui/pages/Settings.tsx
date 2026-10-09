import { useEffect, useState } from "react";

import {
  FolderFields,
  formFromSettings,
  ForwardFields,
  ImapFields,
  imapPayload,
  SecurityFields,
  settingsPayload,
  SmtpFields,
  withSmtpDefaults,
  type Folder,
  type FormState,
} from "../AccountForm";
import { api, tool } from "../api";
import { ClaudeAccess, type Access as AccessInfo } from "../ClaudeAccess";
import { Button, Confirm, CopyButton, ErrorBox, Spinner, useAction, useLoad } from "../components";

export function Settings() {
  const settings = useLoad(() => api("/api/settings"), []);
  if (settings.error) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return <Spinner />;
  return (
    <div className="page">
      <h1>Impostazioni</h1>
      <Access access={settings.data.access} />
      <Account settings={settings.data.settings} />
      <Logs />
    </div>
  );
}

function Access({ access }: { access: AccessInfo }) {
  const [confirm, setConfirm] = useState(false);
  const [fresh, setFresh] = useState<(AccessInfo & { key: string }) | null>(null);
  return (
    <div className="card stack">
      <h2>Collegare Claude</h2>
      <ClaudeAccess access={fresh ?? access} keyKnown={Boolean(fresh)} />
      {fresh ? (
        <div className="stack tight">
          <b>Nuova chiave di accesso</b>
          <div className="keybox">{fresh.key}</div>
          <div className="row">
            <CopyButton text={fresh.key} label="Copia la chiave" />
            <span className="muted small">Viene mostrata solo ora; il testo qui sopra la contiene già.</span>
          </div>
        </div>
      ) : (
        <div>
          <Button onClick={() => setConfirm(true)}>Genera una nuova chiave</Button>
        </div>
      )}
      {confirm ? (
        <Confirm
          title="Generare una nuova chiave?"
          confirmLabel="Genera"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => setFresh(await api("/api/access/rotate", {}))}
        >
          La chiave attuale smette subito di funzionare: dovrai ricollegare Claude con quella nuova. Le sessioni del pannello
          già aperte restano valide.
        </Confirm>
      ) : null}
    </div>
  );
}

function Account({ settings }: { settings: any }) {
  const [state, setState] = useState<FormState>(() => formFromSettings(settings));
  const [folders, setFolders] = useState<Folder[]>(() =>
    [...new Set([...settings.watch, settings.sentFolder, settings.trashFolder].filter(Boolean))].map((path) => ({ path, specialUse: null })),
  );
  const [confirmSave, setConfirmSave] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const { busy, run } = useAction();

  useEffect(() => {
    void tool("list_folders").then((list: Folder[]) => setFolders(list), () => undefined);
  }, []);

  const test = () =>
    run(async () => {
      const response = await api<{ folders: Folder[] }>("/api/settings/test-imap", { imap: imapPayload(state) });
      setFolders(response.folders);
      if (state.smtpEnabled) {
        const filled = withSmtpDefaults(state);
        await api("/api/settings/test-smtp", { imap: imapPayload(filled), smtp: settingsPayload(filled).smtp });
      }
    }, "Collegamento riuscito");

  const save = async () => {
    const result = await api<{ restarting: boolean }>("/api/settings", { settings: settingsPayload(withSmtpDefaults(state)) });
    if (result.restarting) {
      setRestarting(true);
      setTimeout(() => window.location.reload(), 6000);
    }
  };

  return (
    <div className="card stack">
      <h2>Casella di posta</h2>
      {settings.otherAccounts?.length ? (
        <div className="notice small">Altre caselle configurate nel file: {settings.otherAccounts.join(", ")} (non modificabili da qui).</div>
      ) : null}
      <h3>Lettura (IMAP)</h3>
      <ImapFields state={state} set={setState} passwordOptional />
      <h3>Cartelle</h3>
      <FolderFields state={state} set={setState} folders={folders} />
      <h3>Inoltro</h3>
      <SmtpFields state={state} set={setState} passwordOptional />
      {state.smtpEnabled ? <ForwardFields state={state} set={setState} folders={folders} /> : null}
      <h3>Sicurezza</h3>
      <SecurityFields state={state} set={setState} />
      {restarting ? <Spinner label="Impostazioni salvate: Mail Router si riavvia…" /> : null}
      <div className="row">
        <Button busy={busy} onClick={test}>
          Prova il collegamento
        </Button>
        <Button variant="primary" disabled={restarting || !state.watch.length} onClick={() => setConfirmSave(true)}>
          Salva
        </Button>
      </div>
      {confirmSave ? (
        <Confirm title="Salvare le impostazioni?" confirmLabel="Salva e riavvia" onClose={() => setConfirmSave(false)} onConfirm={save}>
          Prima del salvataggio viene verificato l'accesso alla casella. Poi Mail Router si riavvia per qualche secondo; le regole e
          lo storico restano.
        </Confirm>
      ) : null}
    </div>
  );
}

function Logs() {
  const [level, setLevel] = useState("info");
  const logs = useLoad(() => tool("get_logs", { lines: 300, level }), [level]);
  return (
    <div className="card stack">
      <div className="row spread">
        <h2>Registro del servizio</h2>
        <div className="row">
          <select className="input" style={{ width: "auto" }} value={level} onChange={(event) => setLevel(event.target.value)}>
            <option value="info">Tutto</option>
            <option value="warn">Avvisi ed errori</option>
            <option value="error">Solo errori</option>
          </select>
          <Button small onClick={logs.reload}>
            Aggiorna
          </Button>
        </div>
      </div>
      {logs.error ? <ErrorBox error={logs.error} /> : null}
      <pre className="block" style={{ maxHeight: 360 }}>
        {typeof logs.data === "string" ? logs.data : logs.loading ? "…" : ""}
      </pre>
    </div>
  );
}
