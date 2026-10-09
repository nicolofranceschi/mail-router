import { useState } from "react";

import { tool } from "../api";
import { ActionChips, Badge, Button, Confirm, Empty, ErrorBox, Field, Modal, Spinner, useAction, useLoad } from "../components";
import { bytes, flagLabels, formatDate } from "../format";

export function Mailbox({ status }: { status: any }) {
  const defaultFolder: string = status?.accounts?.[0]?.watch?.[0] ?? "INBOX";
  const [folder, setFolder] = useState<string | null>(null);
  const activeFolder = folder ?? defaultFolder;
  const [query, setQuery] = useState({ subject: "", from: "", unseen: false });
  const [applied, setApplied] = useState(query);
  const [selected, setSelected] = useState<number | null>(null);
  const [pages, setPages] = useState(1);

  const folders = useLoad(() => tool("list_folders"), []);
  const messages = useLoad(
    () =>
      tool("search_emails", {
        folder: activeFolder,
        limit: 30 * pages,
        ...(applied.subject ? { subject: applied.subject } : {}),
        ...(applied.from ? { from: applied.from } : {}),
        ...(applied.unseen ? { unseen: true } : {}),
      }),
    [activeFolder, applied, pages],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Posta</h1>
          <p className="muted">I messaggi letti da qui non vengono segnati come letti.</p>
        </div>
      </div>
      <form
        className="card row wrap"
        onSubmit={(event) => {
          event.preventDefault();
          setPages(1);
          setApplied(query);
        }}
      >
        <select
          className="input"
          style={{ width: "auto", maxWidth: 320 }}
          value={activeFolder}
          onChange={(event) => {
            setFolder(event.target.value);
            setSelected(null);
            setPages(1);
          }}
        >
          {(folders.data ?? [{ path: activeFolder }]).map((entry: any) => (
            <option key={entry.path} value={entry.path}>
              {entry.path}
            </option>
          ))}
        </select>
        <input className="input grow" placeholder="Oggetto contiene…" value={query.subject} onChange={(event) => setQuery({ ...query, subject: event.target.value })} />
        <input className="input grow" placeholder="Mittente…" value={query.from} onChange={(event) => setQuery({ ...query, from: event.target.value })} />
        <label className="check small">
          <input type="checkbox" checked={query.unseen} onChange={(event) => setQuery({ ...query, unseen: event.target.checked })} /> non lette
        </label>
        <Button variant="primary" onClick={() => {
          setPages(1);
          setApplied(query);
        }}>
          Cerca
        </Button>
      </form>

      <div className="split">
        <div className="card flush">
          {messages.error ? <ErrorBox error={messages.error} onRetry={messages.reload} /> : null}
          {!messages.data ? (
            <div style={{ padding: 18 }}>
              <Spinner />
            </div>
          ) : messages.data.messages.length ? (
            <div className="list">
              {messages.data.messages.map((message: any) => (
                <div
                  key={message.uid}
                  className={`list-item clickable ${selected === message.uid ? "selected" : ""}`}
                  onClick={() => setSelected(message.uid)}
                >
                  <div className="grow stack tight">
                    <div className="row spread">
                      <span className="ellipsis" style={{ fontWeight: message.flags.includes("\\Seen") ? 400 : 600 }}>
                        {message.subject || "(senza oggetto)"}
                      </span>
                      <span className="muted small" style={{ flex: "none" }}>
                        {formatDate(message.date ?? message.receivedAt)}
                      </span>
                    </div>
                    <span className="muted small ellipsis">{message.from}</span>
                    <div className="row wrap">
                      {message.hasAttachments ? <Badge>allegati</Badge> : null}
                      {flagLabels(message.flags)
                        .filter((label) => label !== "letto")
                        .map((label) => (
                          <Badge key={label} tone={label === "inoltrato" ? "ok" : ""}>
                            {label}
                          </Badge>
                        ))}
                    </div>
                  </div>
                </div>
              ))}
              {messages.data.total > messages.data.messages.length ? (
                <div className="list-item" style={{ justifyContent: "center" }}>
                  <Button small onClick={() => setPages(pages + 1)}>
                    Carica altri ({messages.data.total - messages.data.messages.length} rimanenti)
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <Empty>Nessun messaggio.</Empty>
          )}
        </div>
        {selected ? (
          <MessageDetail
            key={`${activeFolder}:${selected}`}
            folder={activeFolder}
            uid={selected}
            folders={(folders.data ?? []).map((entry: any) => entry.path)}
            canDelete={Boolean(status?.accounts?.[0]?.trashFolder)}
            canSend={Boolean(status?.accounts?.[0]?.canSend)}
            onGone={() => {
              setSelected(null);
              messages.reload();
            }}
            onChanged={messages.reload}
          />
        ) : (
          <div className="card muted">Seleziona un messaggio.</div>
        )}
      </div>
    </div>
  );
}

function MessageDetail(props: {
  folder: string;
  uid: number;
  folders: string[];
  canDelete: boolean;
  canSend: boolean;
  onGone: () => void;
  onChanged: () => void;
}) {
  const { folder, uid } = props;
  const message = useLoad(() => tool("get_email", { folder, uid }), [folder, uid]);
  const [dialog, setDialog] = useState<"forward" | "move" | "delete" | "rules" | null>(null);
  const { busy, run } = useAction();

  if (message.error) return <ErrorBox error={message.error} onRetry={message.reload} />;
  if (!message.data) return <Spinner />;
  const email = message.data;
  const seen = email.flags.includes("\\Seen");
  const people = (list: any[]) => list.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).join(", ");

  return (
    <div className="card stack">
      <h2>{email.subject || "(senza oggetto)"}</h2>
      <div className="stack tight small">
        <span>
          <b>Da:</b> {email.from ? people([email.from]) : "—"}
        </span>
        <span>
          <b>A:</b> {people(email.to) || "—"}
        </span>
        {email.cc.length ? (
          <span>
            <b>Cc:</b> {people(email.cc)}
          </span>
        ) : null}
        <span className="muted">
          {formatDate(email.date ?? email.receivedAt)}
          {email.date ? "" : " (senza data nell'intestazione)"}
        </span>
      </div>
      <div className="row wrap">
        {props.canSend ? (
          <Button small onClick={() => setDialog("forward")}>
            Inoltra…
          </Button>
        ) : null}
        <Button
          small
          busy={busy}
          onClick={() =>
            run(async () => {
              await tool("set_flags", { folder, uid, ...(seen ? { remove: ["\\Seen"] } : { add: ["\\Seen"] }) });
              message.reload();
              props.onChanged();
            })
          }
        >
          {seen ? "Segna come non letto" : "Segna come letto"}
        </Button>
        <Button small onClick={() => setDialog("rules")}>
          Prova le regole
        </Button>
        <Button small onClick={() => setDialog("move")}>
          Sposta…
        </Button>
        {props.canDelete ? (
          <Button small variant="danger" onClick={() => setDialog("delete")}>
            Elimina
          </Button>
        ) : null}
      </div>
      {email.attachments.length && !email.pec?.original ? (
        <div className="row wrap">
          {email.attachments.map((attachment: any, index: number) => (
            <Badge key={index}>
              📎 {attachment.filename || "allegato"} ({bytes(attachment.size)})
            </Badge>
          ))}
        </div>
      ) : null}
      {email.pec ? <PecBox pec={email.pec} people={people} /> : null}
      <pre className="block" style={{ maxHeight: 420 }}>
        {(email.pec?.original?.text ?? email.text) || "(nessun testo)"}
        {(email.pec?.original?.textTruncated ?? email.textTruncated) ? "\n…" : ""}
      </pre>
      {email.routerHistory?.length ? (
        <div className="stack tight">
          <b>Cosa ha fatto Mail Router</b>
          {email.routerHistory.map((entry: any) => (
            <div key={entry.evaluationId} className="stack tight small">
              <span className="muted">
                {formatDate(entry.at)} · {entry.rules.map((rule: any) => rule.rule).join(", ") || entry.note || "nessuna regola"}
              </span>
              <ActionChips actions={entry.actions} />
            </div>
          ))}
        </div>
      ) : null}

      {dialog === "forward" ? <ForwardDialog folder={folder} uid={uid} onClose={() => setDialog(null)} onDone={() => { message.reload(); props.onChanged(); }} /> : null}
      {dialog === "rules" ? <RulesCheck folder={folder} uid={uid} onClose={() => setDialog(null)} /> : null}
      {dialog === "move" ? (
        <MoveDialog folders={props.folders.filter((path) => path !== folder)} onClose={() => setDialog(null)} onMove={async (target) => {
          await tool("move_email", { folder, uid, target });
          props.onGone();
        }} />
      ) : null}
      {dialog === "delete" ? (
        <Confirm
          title="Eliminare il messaggio?"
          confirmLabel="Sposta nel cestino"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await tool("delete_email", { folder, uid });
            props.onGone();
          }}
        >
          Il messaggio viene spostato nel cestino della casella: non viene cancellato definitivamente.
        </Confirm>
      ) : null}
    </div>
  );
}

function ForwardDialog({ folder, uid, onClose, onDone }: { folder: string; uid: number; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [replyToSender, setReplyToSender] = useState(false);
  const { busy, run } = useAction();
  return (
    <Modal title="Inoltra" onClose={onClose}>
      <Field label="A" hint="Uno o più indirizzi separati da virgola">
        <input className="input" value={to} onChange={(event) => setTo(event.target.value)} autoFocus />
      </Field>
      <Field label="Nota (facoltativa)">
        <textarea className="input" value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={replyToSender} onChange={(event) => setReplyToSender(event.target.checked)} /> le risposte vanno al mittente originale
      </label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button onClick={onClose}>Annulla</Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!to.trim()}
          onClick={async () => {
            const done = await run(() => tool("forward_email", { folder, uid, to, ...(note ? { note } : {}), replyToSender }), "Messaggio inoltrato");
            if (done) {
              onDone();
              onClose();
            }
          }}
        >
          Inoltra ora
        </Button>
      </div>
    </Modal>
  );
}

function MoveDialog({ folders, onClose, onMove }: { folders: string[]; onClose: () => void; onMove: (target: string) => Promise<void> }) {
  const [target, setTarget] = useState(folders[0] ?? "");
  const { busy, run } = useAction();
  return (
    <Modal title="Sposta in" onClose={onClose}>
      <select className="input" value={target} onChange={(event) => setTarget(event.target.value)}>
        {folders.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </select>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button onClick={onClose}>Annulla</Button>
        <Button variant="primary" busy={busy} disabled={!target} onClick={() => run(() => onMove(target), "Messaggio spostato")}>
          Sposta
        </Button>
      </div>
    </Modal>
  );
}

function RulesCheck({ folder, uid, onClose }: { folder: string; uid: number; onClose: () => void }) {
  const result = useLoad(() => tool("reprocess_email", { folder, uid }), [folder, uid]);
  return (
    <Modal title="Cosa farebbero le regole" onClose={onClose}>
      <p className="muted small">Simulazione con le regole attuali: non viene inviato né modificato nulla.</p>
      {result.error ? <ErrorBox error={result.error} /> : null}
      {!result.data ? (
        <Spinner />
      ) : (
        <div className="stack">
          {result.data.rules.length ? (
            result.data.rules.map((rule: any) => (
              <div key={rule.rule} className="row wrap small">
                <Badge tone={rule.error ? "err" : rule.matched ? "ok" : ""}>{rule.error ? "errore" : rule.matched ? "riconosce" : "non riguarda"}</Badge>
                <span>{rule.rule}</span>
                {rule.error ? <span style={{ color: "var(--err)" }}>{rule.error}</span> : null}
                {rule.decision?.reason ? <span className="muted">— {rule.decision.reason}</span> : null}
              </div>
            ))
          ) : (
            <p className="muted">Nessuna regola attiva o in prova.</p>
          )}
          {result.data.wouldDo?.length ? (
            <ActionChips actions={result.data.wouldDo.map((action: any) => ({ ...action, ...action.payload, status: action.status === "pending" ? "eseguirebbe" : action.status }))} />
          ) : null}
        </div>
      )}
    </Modal>
  );
}

const PEC_TYPES: Record<string, string> = {
  "posta-certificata": "messaggio PEC",
  accettazione: "ricevuta di accettazione",
  "avvenuta-consegna": "ricevuta di avvenuta consegna",
  "non-accettazione": "avviso di non accettazione",
  "presa-in-carico": "ricevuta di presa in carico",
  "errore-consegna": "avviso di mancata consegna",
  "preavviso-errore-consegna": "preavviso di mancata consegna",
  "rilevazione-virus": "avviso di rilevazione virus",
  errore: "anomalia: messaggio non PEC",
};

function PecBox({ pec, people }: { pec: any; people: (list: any[]) => string }) {
  const original = pec.original;
  return (
    <div className="notice stack tight small">
      <div className="row wrap">
        <Badge tone={pec.isReceipt ? "" : pec.isAnomaly ? "warn" : "info"}>PEC</Badge>
        <b>{PEC_TYPES[pec.tipo] ?? pec.tipo}</b>
        {pec.gestore ? <span className="muted">gestore {pec.gestore}</span> : null}
      </div>
      {pec.sender ? (
        <span>
          <b>Mittente originale:</b> {pec.sender}
        </span>
      ) : null}
      {pec.subject ? (
        <span>
          <b>Oggetto originale:</b> {pec.subject}
        </span>
      ) : null}
      {original?.to?.length ? (
        <span>
          <b>Destinatari:</b> {people(original.to)}
        </span>
      ) : null}
      {original?.attachments?.length ? (
        <span>
          <b>Allegati della PEC:</b> {original.attachments.map((attachment: any) => attachment.filename).join(", ")}
        </span>
      ) : null}
    </div>
  );
}
