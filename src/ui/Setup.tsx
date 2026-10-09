import { useState } from "react";

import {
  emptyForm,
  FolderFields,
  ForwardFields,
  looksLikePec,
  withPecDefaults,
  ImapFields,
  imapPayload,
  SecurityFields,
  settingsPayload,
  SmtpFields,
  smtpPayload,
  withSmtpDefaults,
  type Folder,
  type FormState,
} from "./AccountForm";
import { api } from "./api";
import { Button, CopyButton, Field, Spinner } from "./components";

const STEPS = ["Benvenuto", "Casella", "Cartelle", "Inoltro", "Sicurezza", "Installazione"];

interface FinishResult {
  key: string;
  steps: string[];
  running: boolean;
  openUrl: string;
  access: { command: string; panelUrl: string; hosts: string[] };
}

export function Setup({ defaults }: { defaults: { instanceName: string } }) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<FormState>(() => emptyForm(defaults.instanceName));
  const [folders, setFolders] = useState<Folder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FinishResult | null>(null);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const testImap = () =>
    attempt(async () => {
      const response = await api<{ folders: Folder[] }>("/api/setup/imap", { imap: imapPayload(state) });
      setFolders(response.folders);
      const inbox = response.folders.find((folder) => folder.path.toUpperCase() === "INBOX");
      const domain = state.imap.user.includes("@") ? state.imap.user.split("@")[1]! : "";
      setState((current) => ({
        ...(looksLikePec(current.imap.host) && current.sender === "same" ? withPecDefaults(current) : current),
        watch: current.watch.length ? current.watch : inbox ? [inbox.path] : [],
        sentFolder: current.sentFolder ?? response.folders.find((folder) => folder.specialUse === "\\Sent")?.path ?? null,
        trashFolder: current.trashFolder ?? response.folders.find((folder) => folder.specialUse === "\\Trash")?.path ?? null,
        ownAddresses: current.ownAddresses || (current.imap.user.includes("@") ? current.imap.user : ""),
        allowedDomains: current.allowedDomains || domain,
      }));
      setStep(2);
    });

  const testSmtp = () =>
    attempt(async () => {
      if (state.smtpEnabled) {
        const filled = withSmtpDefaults(state);
        setState(filled);
        await api("/api/setup/smtp", { imap: imapPayload(filled), smtp: smtpPayload(filled) });
      }
      setStep(4);
    });

  const finish = () =>
    attempt(async () => {
      const filled = withSmtpDefaults(state);
      setResult(await api<FinishResult>("/api/setup/finish", { settings: settingsPayload(filled) }));
      setStep(5);
    });

  const openPanel = async () => {
    if (!result) return;
    await api("/api/setup/close", {}).catch(() => undefined);
    window.location.href = result.openUrl;
  };

  return (
    <div className="centered">
      <div className="wizard">
        <div className="row" style={{ gap: 12 }}>
          <div className="brand-mark">✉</div>
          <div>
            <h1>Configura Mail Router</h1>
            <p className="muted">
              Passo {step + 1} di {STEPS.length} — {STEPS[step]}
            </p>
          </div>
        </div>
        <div className="steps">
          {STEPS.map((name, index) => (
            <span key={name} className={index <= step ? "done" : ""} />
          ))}
        </div>

        <div className="card stack">
          {step === 0 ? (
            <>
              <p>
                Mail Router sorveglia una casella di posta e inoltra in automatico i messaggi secondo regole che scrivi con
                Claude, in italiano. Gira in background su questo PC, anche quando nessuno è collegato.
              </p>
              <p className="muted">
                All'inizio lavora <b>in prova</b>: valuta ogni messaggio e registra cosa farebbe, senza inviare nulla. Lo
                attivi tu quando le regole ti convincono.
              </p>
              <Field label="Nome del servizio" hint="Compare nel pannello e in Claude">
                <input
                  className="input"
                  value={state.instanceName}
                  onChange={(event) => setState((current) => ({ ...current, instanceName: event.target.value }))}
                />
              </Field>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h2>Lettura della posta (IMAP)</h2>
              <ImapFields state={state} set={setState} autoFocus />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h2>Cartelle</h2>
              <FolderFields state={state} set={setState} folders={folders} />
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h2>Inoltro</h2>
              <SmtpFields state={state} set={setState} />
              {state.smtpEnabled ? <ForwardFields state={state} set={setState} folders={folders} /> : null}
            </>
          ) : null}

          {step === 4 ? (
            <>
              <h2>Sicurezza</h2>
              <SecurityFields state={state} set={setState} showPort />
              <p className="muted small">
                Premendo «Installa e avvia», Mail Router si installa come servizio di Windows (parte da solo all'accensione
                del PC) e apre la porta {state.mcpPort} solo per la rete locale.
              </p>
            </>
          ) : null}

          {step === 5 && result ? (
            <>
              <h2>{result.running ? "Mail Router è in funzione" : "Installazione completata"}</h2>
              {!result.running ? (
                <div className="notice warn">Il servizio non risponde ancora: se il pannello non si apre, riprova tra un minuto.</div>
              ) : null}
              <div className="stack tight">
                <b>Chiave di accesso</b>
                <p className="muted small">
                  Serve per collegare Claude e per entrare nel pannello da un altro computer. Viene mostrata solo ora:
                  copiala in un posto sicuro (potrai generarne una nuova dalle Impostazioni).
                </p>
                <div className="keybox">{result.key}</div>
                <div>
                  <CopyButton text={result.key} label="Copia la chiave" />
                </div>
              </div>
              <div className="stack tight">
                <b>Collegare Claude Code dal tuo computer</b>
                <pre className="block">{result.access.command}</pre>
                <div>
                  <CopyButton text={result.access.command} label="Copia il comando" />
                </div>
              </div>
              <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
                {result.steps.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </>
          ) : null}

          {error ? <div className="notice err">{error}</div> : null}
          {busy && step === 4 ? <Spinner label="Installazione in corso, può richiedere un minuto…" /> : null}
        </div>

        <div className="row spread">
          {step > 0 && step < 5 ? (
            <Button onClick={() => setStep(step - 1)} disabled={busy}>
              Indietro
            </Button>
          ) : (
            <span />
          )}
          {step === 0 ? (
            <Button variant="primary" onClick={() => setStep(1)} disabled={!state.instanceName.trim()}>
              Inizia
            </Button>
          ) : null}
          {step === 1 ? (
            <Button variant="primary" busy={busy} onClick={testImap} disabled={!state.imap.host || !state.imap.user || !state.imap.password}>
              Prova l'accesso e continua
            </Button>
          ) : null}
          {step === 2 ? (
            <Button variant="primary" onClick={() => setStep(3)} disabled={!state.watch.length}>
              Continua
            </Button>
          ) : null}
          {step === 3 ? (
            <Button variant="primary" busy={busy} onClick={testSmtp}>
              {state.smtpEnabled ? "Prova l'invio e continua" : "Continua senza invio"}
            </Button>
          ) : null}
          {step === 4 ? (
            <Button variant="primary" busy={busy} onClick={finish}>
              Installa e avvia
            </Button>
          ) : null}
          {step === 5 ? (
            <Button variant="primary" onClick={openPanel}>
              Ho copiato la chiave, apri il pannello
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
