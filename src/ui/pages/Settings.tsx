import { useState } from "react";

import { splitList } from "../format";
import { api, tool } from "../api";
import { ClaudeAccess, type Access as AccessInfo } from "../ClaudeAccess";
import { Button, Confirm, ErrorBox, Field, Spinner, useLoad } from "../components";
import { FreshKey } from "./Users";

export function Settings({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="page">
      <h1>Impostazioni</h1>
      <MyAccess />
      {isAdmin ? <General /> : null}
      <Logs />
    </div>
  );
}

/** The signed-in user's own key: how to connect Claude with it, and a new one when it leaked. */
function MyAccess() {
  const access = useLoad(() => api<{ user: { name: string; role: string; keyHint: string | null }; access: AccessInfo }>("/api/access"), []);
  const [confirm, setConfirm] = useState(false);
  const [fresh, setFresh] = useState<(AccessInfo & { key: string; who: string }) | null>(null);
  if (access.error) return <ErrorBox error={access.error} onRetry={access.reload} />;
  if (!access.data) return <Spinner />;
  const { user } = access.data;
  return (
    <div className="card stack">
      <h2>Collegare Claude</h2>
      <p className="muted small">
        Con la tua chiave personale ({user.keyHint ?? "creata prima degli utenti"}): Claude potrà fare quello che il tuo ruolo
        permette.
      </p>
      {fresh ? (
        <FreshKey fresh={fresh} />
      ) : (
        <>
          <ClaudeAccess access={access.data.access} keyKnown={false} />
          <div>
            <Button onClick={() => setConfirm(true)}>Genera una nuova chiave per me</Button>
          </div>
        </>
      )}
      {confirm ? (
        <Confirm
          title="Generare una nuova chiave?"
          confirmLabel="Genera"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => setFresh({ ...(await api<AccessInfo & { key: string }>("/api/access/rotate", {})), who: user.name })}
        >
          La tua chiave attuale smette subito di funzionare: dovrai ricollegare Claude con quella nuova. Le sessioni del pannello
          già aperte restano valide. Le chiavi degli altri utenti non cambiano.
        </Confirm>
      ) : null}
    </div>
  );
}

/** Settings that apply to the whole service, not to one mailbox. */
function General() {
  const settings = useLoad(() => api("/api/settings"), []);
  if (settings.error) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return <Spinner />;
  return <GeneralForm general={settings.data.general} />;
}

function GeneralForm({ general }: { general: { instanceName: string; allowedDomains: string[]; mcpPort: number } }) {
  const [instanceName, setInstanceName] = useState(general.instanceName);
  const [domains, setDomains] = useState(general.allowedDomains.join(", "));
  // The port inside the container is fixed: the published one is chosen in compose.yaml.
  const port = String(general.mcpPort);
  const [confirmSave, setConfirmSave] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const save = async () => {
    const result = await api<{ restarting: boolean }>("/api/settings/general", {
      general: {
        instanceName: instanceName.trim(),
        allowedDomains: splitList(domains).map((domain) => domain.replace(/^@/, "")),
        mcpPort: Number(port),
      },
    });
    if (result.restarting) {
      setRestarting(true);
      const portChanged = Number(port) !== general.mcpPort;
      setTimeout(() => {
        if (portChanged) window.location.port = port;
        else window.location.reload();
      }, 6000);
    }
  };

  return (
    <div className="card stack">
      <h2>Generali</h2>
      <p className="muted small">Valgono per tutte le caselle. Le caselle di posta si gestiscono nella pagina «Caselle di posta».</p>
      <Field label="Nome di questa installazione">
        <input className="input" value={instanceName} onChange={(event) => setInstanceName(event.target.value)} />
      </Field>
      <Field label="Domini a cui le regole possono inoltrare" hint="Separati da virgola, es. azienda.it. Vuoto = qualsiasi dominio (sconsigliato)">
        <input className="input" value={domains} onChange={(event) => setDomains(event.target.value)} />
      </Field>
      {restarting ? <Spinner label="Impostazioni salvate: Mail Router si riavvia…" /> : null}
      <div className="row">
        <Button variant="primary" disabled={restarting || !instanceName.trim() || !/^\d+$/.test(port)} onClick={() => setConfirmSave(true)}>
          Salva
        </Button>
      </div>
      {confirmSave ? (
        <Confirm title="Salvare le impostazioni?" confirmLabel="Salva e riavvia" onClose={() => setConfirmSave(false)} onConfirm={save}>
          Mail Router si riavvia per qualche secondo; le regole e lo storico restano.
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
