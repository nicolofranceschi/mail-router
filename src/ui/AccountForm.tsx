import { useMemo, useState } from "react";

import { Check, Field } from "./components";
import { splitList } from "./format";

export interface Folder {
  path: string;
  specialUse: string | null;
}

export interface FormState {
  instanceName: string;
  imap: { host: string; port: string; secure: boolean; user: string; password: string; rejectUnauthorized: boolean; passwordSet?: boolean };
  smtpEnabled: boolean;
  /** "satellite": forwards leave from another, ordinary mailbox (always the case for a PEC box). */
  sender: "same" | "satellite";
  smtp: {
    host: string;
    port: string;
    secure: boolean;
    user: string;
    password: string;
    sameAsImap: boolean;
    from: string;
    requireTls: boolean;
    rejectUnauthorized: boolean;
    passwordSet?: boolean;
  };
  watch: string[];
  sentFolder: string | null;
  trashFolder: string | null;
  ownAddresses: string;
  allowedDomains: string;
  markForwarded: boolean;
  forwardAsAttachment: boolean;
  moveAfterForward: string | null;
  mcpPort: string;
}

/** Certified-mail providers' servers: forwarding from them would send PEC. */
export function looksLikePec(host: string): boolean {
  return /(^|[.-])(pec|legalmail|postacert|cert|arubapec|sicurezzapostale)([.-]|$)/i.test(host);
}

/** Defaults suited to a PEC inbox: send through a satellite box, attach the .eml, file what was forwarded. */
export function withPecDefaults(state: FormState): FormState {
  return {
    ...state,
    sender: "satellite",
    smtp: { ...state.smtp, host: "", user: "", password: "", from: "", sameAsImap: false },
    forwardAsAttachment: true,
    moveAfterForward: state.moveAfterForward ?? "Inoltrate",
  };
}

export function emptyForm(instanceName = "Smistamento posta"): FormState {
  return {
    instanceName,
    imap: { host: "", port: "993", secure: true, user: "", password: "", rejectUnauthorized: true },
    smtpEnabled: true,
    sender: "same",
    smtp: { host: "", port: "587", secure: false, user: "", password: "", sameAsImap: true, from: "", requireTls: true, rejectUnauthorized: true },
    watch: [],
    sentFolder: null,
    trashFolder: null,
    ownAddresses: "",
    allowedDomains: "",
    markForwarded: true,
    forwardAsAttachment: false,
    moveAfterForward: null,
    mcpPort: "8787",
  };
}

/** Settings as returned by the server (no passwords) → editable state. */
export function formFromSettings(settings: any): FormState {
  const base = emptyForm(settings.instanceName);
  return {
    ...base,
    imap: { ...base.imap, ...settings.imap, port: String(settings.imap.port), password: "" },
    smtpEnabled: Boolean(settings.smtp),
    sender: settings.smtp && (settings.smtp.host !== settings.imap.host || settings.smtp.user !== settings.imap.user) ? "satellite" : "same",
    smtp: settings.smtp ? { ...base.smtp, ...settings.smtp, port: String(settings.smtp.port), password: "", sameAsImap: false } : base.smtp,
    watch: settings.watch,
    sentFolder: settings.sentFolder,
    trashFolder: settings.trashFolder,
    ownAddresses: settings.ownAddresses.join(", "),
    allowedDomains: settings.allowedDomains.join(", "),
    markForwarded: settings.markForwarded,
    forwardAsAttachment: settings.forwardAsAttachment ?? false,
    moveAfterForward: settings.moveAfterForward ?? null,
    mcpPort: String(settings.mcpPort),
  };
}

export function imapPayload(state: FormState) {
  return { ...state.imap, port: Number(state.imap.port), password: state.imap.password || undefined };
}

export function smtpPayload(state: FormState) {
  const sameAsImap = state.sender === "same" && state.smtp.sameAsImap;
  return {
    ...state.smtp,
    port: Number(state.smtp.port),
    sameAsImap,
    password: sameAsImap ? undefined : state.smtp.password || undefined,
  };
}

export function settingsPayload(state: FormState) {
  return {
    instanceName: state.instanceName,
    imap: imapPayload(state),
    smtp: state.smtpEnabled ? smtpPayload(state) : null,
    watch: state.watch,
    sentFolder: state.sentFolder,
    trashFolder: state.trashFolder,
    ownAddresses: splitList(state.ownAddresses),
    allowedDomains: splitList(state.allowedDomains).map((domain) => domain.replace(/^@/, "")),
    markForwarded: state.markForwarded,
    forwardAsAttachment: state.forwardAsAttachment,
    moveAfterForward: state.moveAfterForward,
    mcpPort: Number(state.mcpPort),
  };
}

type Setter = (update: (state: FormState) => FormState) => void;

export function ImapFields({ state, set, passwordOptional, autoFocus }: { state: FormState; set: Setter; passwordOptional?: boolean; autoFocus?: boolean }) {
  const imap = state.imap;
  const update = (patch: Partial<FormState["imap"]>) => set((current) => ({ ...current, imap: { ...current.imap, ...patch } }));
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Server IMAP" hint="Es. mail.azienda.it">
          <input className="input" value={imap.host} onChange={(event) => update({ host: event.target.value.trim() })} autoFocus={autoFocus} />
        </Field>
        <Field label="Porta">
          <input
            className="input"
            inputMode="numeric"
            value={imap.port}
            onChange={(event) => {
              const port = event.target.value.trim();
              update({ port, ...(port === "993" ? { secure: true } : port === "143" ? { secure: false } : {}) });
            }}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Utente" hint="Di solito l'indirizzo email">
          <input className="input" value={imap.user} onChange={(event) => update({ user: event.target.value.trim() })} autoComplete="off" />
        </Field>
        <Field label="Password" hint={passwordOptional ? "Lascia vuoto per non cambiarla" : undefined}>
          <input
            className="input"
            type="password"
            value={imap.password}
            placeholder={passwordOptional ? "invariata" : ""}
            onChange={(event) => update({ password: event.target.value })}
            autoComplete="new-password"
          />
        </Field>
      </div>
      <div className="row wrap" style={{ gap: 18 }}>
        <Check checked={imap.secure} onChange={(secure) => update({ secure, port: secure ? "993" : "143" })}>
          Connessione protetta SSL/TLS
        </Check>
        <Check checked={!imap.rejectUnauthorized} onChange={(value) => update({ rejectUnauthorized: !value })}>
          Accetta certificati non verificati (solo server interni)
        </Check>
      </div>
    </div>
  );
}

function Radio({ checked, onChange, title, children }: { checked: boolean; onChange: () => void; title: string; children?: React.ReactNode }) {
  return (
    <label className="check" style={{ alignItems: "flex-start" }}>
      <input type="radio" checked={checked} onChange={onChange} style={{ marginTop: 4 }} />
      <span>
        {title}
        {children ? <span className="muted small" style={{ display: "block" }}>{children}</span> : null}
      </span>
    </label>
  );
}

export function SmtpFields({ state, set, passwordOptional }: { state: FormState; set: Setter; passwordOptional?: boolean }) {
  const smtp = state.smtp;
  const satellite = state.sender === "satellite";
  const update = (patch: Partial<FormState["smtp"]>) => set((current) => ({ ...current, smtp: { ...current.smtp, ...patch } }));
  const pec = looksLikePec(state.imap.host);
  return (
    <div className="stack">
      <Check checked={state.smtpEnabled} onChange={(smtpEnabled) => set((current) => ({ ...current, smtpEnabled }))}>
        Permetti l'invio (serve per inoltrare e rispondere)
      </Check>
      {state.smtpEnabled ? (
        <>
          <div className="stack tight">
            <b className="small">Con quale casella partono gli inoltri?</b>
            <Radio
              checked={!satellite}
              onChange={() => set((current) => ({ ...current, sender: "same", smtp: { ...current.smtp, sameAsImap: true } }))}
              title="Da questa stessa casella"
            />
            <Radio
              checked={satellite}
              onChange={() =>
                set((current) => ({
                  ...current,
                  sender: "satellite",
                  smtp: { ...current.smtp, host: "", user: "", password: "", from: "", sameAsImap: false },
                }))
              }
              title="Da un'altra casella (satellite)"
            >
              Una casella normale usata solo per inviare: consigliato se questa è una PEC, così gli inoltri non partono come posta
              certificata.
            </Radio>
          </div>
          {pec && !satellite ? (
            <div className="notice warn small">
              Questa sembra una casella PEC: inoltrando da qui ogni inoltro partirebbe come PEC. Meglio usare una casella satellite.
            </div>
          ) : null}
          <div className="form-grid">
            <Field label={satellite ? "Server SMTP della casella satellite" : "Server SMTP"}>
              <input
                className="input"
                value={smtp.host}
                placeholder={satellite ? "es. smtp.azienda.it" : state.imap.host}
                onChange={(event) => update({ host: event.target.value.trim() })}
              />
            </Field>
            <Field label="Porta" hint="587 con STARTTLS, 465 con SSL">
              <input
                className="input"
                inputMode="numeric"
                value={smtp.port}
                onChange={(event) => {
                  // 465 is implicit TLS, 587/25 start in clear and upgrade: keep the switch in step with the port.
                  const port = event.target.value.trim();
                  update({ port, ...(port === "465" ? { secure: true } : port === "587" || port === "25" ? { secure: false } : {}) });
                }}
              />
            </Field>
          </div>
          <div className="form-grid">
            <Field label={satellite ? "Utente della casella satellite" : "Utente"}>
              <input
                className="input"
                value={smtp.user}
                placeholder={satellite ? "es. smistamento@azienda.it" : state.imap.user}
                onChange={(event) => update({ user: event.target.value.trim() })}
                autoComplete="off"
              />
            </Field>
            <Field label="Mittente degli inoltri" hint="Es. Smistamento PEC <smistamento@azienda.it>">
              <input
                className="input"
                value={smtp.from}
                placeholder={satellite ? smtp.user || "smistamento@azienda.it" : state.imap.user}
                onChange={(event) => update({ from: event.target.value })}
              />
            </Field>
          </div>
          {!satellite ? (
            <Check checked={smtp.sameAsImap} onChange={(sameAsImap) => update({ sameAsImap })}>
              Stessa password della lettura
            </Check>
          ) : null}
          {satellite || !smtp.sameAsImap ? (
            <Field label={satellite ? "Password della casella satellite" : "Password SMTP"} hint={passwordOptional ? "Lascia vuoto per non cambiarla" : undefined}>
              <input
                className="input"
                type="password"
                value={smtp.password}
                placeholder={passwordOptional ? "invariata" : ""}
                onChange={(event) => update({ password: event.target.value })}
                autoComplete="new-password"
              />
            </Field>
          ) : null}
          <div className="row wrap" style={{ gap: 18 }}>
            <Check checked={smtp.secure} onChange={(secure) => update({ secure, port: secure ? "465" : "587" })}>
              SSL diretto (porta 465)
            </Check>
            {!smtp.secure ? (
              <Check checked={smtp.requireTls} onChange={(requireTls) => update({ requireTls })}>
                Richiedi cifratura STARTTLS
              </Check>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ForwardFields({ state, set, folders }: { state: FormState; set: Setter; folders: Folder[] }) {
  const [custom, setCustom] = useState(
    Boolean(state.moveAfterForward) && !folders.some((folder) => folder.path === state.moveAfterForward),
  );
  return (
    <div className="stack">
      <div className="stack tight">
        <b className="small">Come inoltrare</b>
        <Radio
          checked={!state.forwardAsAttachment}
          onChange={() => set((current) => ({ ...current, forwardAsAttachment: false }))}
          title="Inoltro classico"
        >
          Testo e allegati del messaggio, come «Inoltra» in Outlook.
        </Radio>
        <Radio
          checked={state.forwardAsAttachment}
          onChange={() => set((current) => ({ ...current, forwardAsAttachment: true }))}
          title="Allega il messaggio originale (.eml)"
        >
          Consigliato per la PEC: il messaggio arriva intero, con busta e firma del gestore, più un riepilogo (mittente, oggetto,
          data). Una regola può comunque scegliere diversamente.
        </Radio>
      </div>
      <Field
        label="Dopo l'inoltro, sposta il messaggio in"
        hint="Così chi lavora la posta a mano vede in arrivo solo quello che resta da fare. La cartella viene creata se non esiste."
      >
        {custom ? (
          <div className="row">
            <input
              className="input"
              value={state.moveAfterForward ?? ""}
              placeholder="es. Inoltrate"
              onChange={(event) => set((current) => ({ ...current, moveAfterForward: event.target.value || null }))}
            />
            <button type="button" className="btn small" onClick={() => setCustom(false)}>
              Scegli
            </button>
          </div>
        ) : (
          <select
            className="input"
            value={state.moveAfterForward ?? ""}
            onChange={(event) => {
              if (event.target.value === "__new__") {
                setCustom(true);
                set((current) => ({ ...current, moveAfterForward: "Inoltrate" }));
              } else set((current) => ({ ...current, moveAfterForward: event.target.value || null }));
            }}
          >
            <option value="">Non spostare</option>
            {state.moveAfterForward && !folders.some((folder) => folder.path === state.moveAfterForward) ? (
              <option value={state.moveAfterForward}>{state.moveAfterForward} (nuova)</option>
            ) : null}
            {folders.map((folder) => (
              <option key={folder.path} value={folder.path}>
                {folder.path}
              </option>
            ))}
            <option value="__new__">Nuova cartella…</option>
          </select>
        )}
      </Field>
    </div>
  );
}

/** Fills empty SMTP fields from the IMAP ones, as the placeholders suggest (same mailbox only). */
export function withSmtpDefaults(state: FormState): FormState {
  if (state.sender === "satellite") return { ...state, smtp: { ...state.smtp, from: state.smtp.from || state.smtp.user } };
  return {
    ...state,
    smtp: {
      ...state.smtp,
      host: state.smtp.host || state.imap.host,
      user: state.smtp.user || state.imap.user,
      from: state.smtp.from || state.imap.user,
    },
  };
}

export function FolderFields({ state, set, folders }: { state: FormState; set: Setter; folders: Folder[] }) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(
    () => folders.filter((folder) => folder.path.toLowerCase().includes(filter.toLowerCase())),
    [folders, filter],
  );
  const toggle = (path: string, on: boolean) =>
    set((current) => ({ ...current, watch: on ? [...new Set([...current.watch, path])] : current.watch.filter((entry) => entry !== path) }));
  return (
    <div className="stack">
      <Field label="Cartelle da sorvegliare" hint="Ogni nuovo messaggio in queste cartelle passa dalle regole">
        <div className="stack tight">
          {folders.length > 8 ? (
            <input className="input" placeholder="Filtra cartelle…" value={filter} onChange={(event) => setFilter(event.target.value)} />
          ) : null}
          <div className="folder-list">
            {visible.map((folder) => (
              <Check key={folder.path} checked={state.watch.includes(folder.path)} onChange={(on) => toggle(folder.path, on)}>
                {folder.path}
                {folder.specialUse ? <span className="muted small"> ({folder.specialUse.replace("\\", "")})</span> : null}
              </Check>
            ))}
          </div>
        </div>
      </Field>
      <div className="form-grid">
        <Field label="Copia di ciò che viene inviato" hint="Facoltativa: così resta traccia degli inoltri">
          <FolderSelect folders={folders} value={state.sentFolder} onChange={(sentFolder) => set((current) => ({ ...current, sentFolder }))} />
        </Field>
        <Field label="Cestino" hint="Dove finiscono le mail eliminate dal pannello o da Claude">
          <FolderSelect folders={folders} value={state.trashFolder} onChange={(trashFolder) => set((current) => ({ ...current, trashFolder }))} />
        </Field>
      </div>
    </div>
  );
}

function FolderSelect({ folders, value, onChange }: { folders: Folder[]; value: string | null; onChange: (value: string | null) => void }) {
  return (
    <select className="input" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">Nessuna</option>
      {value && !folders.some((folder) => folder.path === value) ? <option value={value}>{value}</option> : null}
      {folders.map((folder) => (
        <option key={folder.path} value={folder.path}>
          {folder.path}
        </option>
      ))}
    </select>
  );
}

export function SecurityFields({ state, set, showPort }: { state: FormState; set: Setter; showPort?: boolean }) {
  return (
    <div className="stack">
      <Field label="Indirizzi di questa casella" hint="Separati da virgola: le regole non inoltreranno mai a questi indirizzi">
        <input className="input" value={state.ownAddresses} onChange={(event) => set((current) => ({ ...current, ownAddresses: event.target.value }))} />
      </Field>
      <Field
        label="Domini a cui le regole possono inoltrare"
        hint="Separati da virgola, es. azienda.it. Vuoto = qualsiasi dominio (sconsigliato)"
      >
        <input className="input" value={state.allowedDomains} onChange={(event) => set((current) => ({ ...current, allowedDomains: event.target.value }))} />
      </Field>
      <Check checked={state.markForwarded} onChange={(markForwarded) => set((current) => ({ ...current, markForwarded }))}>
        Segna come «inoltrato» il messaggio originale dopo un inoltro automatico
      </Check>
      {showPort ? (
        <Field label="Porta del pannello e del collegamento con Claude">
          <input className="input" inputMode="numeric" value={state.mcpPort} onChange={(event) => set((current) => ({ ...current, mcpPort: event.target.value }))} />
        </Field>
      ) : null}
    </div>
  );
}
