import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { api, onUnauthorized } from "./api";
import { Button, ErrorBox, Field, Spinner, ToastProvider } from "./components";
import { Panel } from "./Panel";
import { Setup } from "./Setup";

interface Bootstrap {
  mode: "setup" | "service";
  authenticated: boolean;
  version: string;
  instanceName?: string;
  defaults?: { instanceName: string };
}

/** A `?once=` link opens a session and is then removed from the address bar. */
async function consumeOnceLink(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const once = params.get("once");
  if (!once) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  await api("/api/session/once", { once }).catch(() => undefined);
}

function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      await consumeOnceLink();
      setBoot(await api<Bootstrap>("/api/bootstrap"));
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  useEffect(() => {
    void load();
    return onUnauthorized(() => setBoot((current) => (current ? { ...current, authenticated: false } : current)));
  }, []);

  if (error) {
    return (
      <div className="centered">
        <ErrorBox error={`Mail Router non risponde: ${error}`} onRetry={load} />
      </div>
    );
  }
  if (!boot) {
    return (
      <div className="centered">
        <Spinner />
      </div>
    );
  }
  if (!boot.authenticated) {
    return boot.mode === "setup" ? (
      <div className="centered">
        <div className="notice warn">Questo collegamento è scaduto: chiudi la finestra e riapri Mail Router.</div>
      </div>
    ) : (
      <Login instanceName={boot.instanceName ?? "Mail Router"} onDone={load} />
    );
  }
  if (boot.mode === "setup") return <Setup defaults={boot.defaults ?? { instanceName: "Smistamento posta" }} />;
  return <Panel instanceName={boot.instanceName ?? "Mail Router"} version={boot.version} onLogout={load} />;
}

function Login({ instanceName, onDone }: { instanceName: string; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/session/key", { key });
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="centered">
      <form
        className="card stack"
        style={{ width: "min(420px, 100%)" }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="row" style={{ gap: 12 }}>
          <div className="brand-mark">✉</div>
          <div>
            <h1>{instanceName}</h1>
            <p className="muted small">Pannello di Mail Router</p>
          </div>
        </div>
        <Field label="Chiave di accesso" hint="Sul PC dove è installato, apri «Mail Router» dal Desktop: entri senza chiave.">
          <input className="input mono" type="password" value={key} onChange={(event) => setKey(event.target.value)} autoFocus />
        </Field>
        {error ? <div className="notice err">{error}</div> : null}
        <Button variant="primary" busy={busy} disabled={!key.trim()} onClick={submit}>
          Entra
        </Button>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
