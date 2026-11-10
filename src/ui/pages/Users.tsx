import { useState } from "react";

import { api } from "../api";
import { ClaudeAccess, type Access } from "../ClaudeAccess";
import { Badge, Button, Confirm, CopyButton, Empty, ErrorBox, Field, Modal, Spinner, useAction, useLoad } from "../components";
import { formatDate } from "../format";

interface UserView {
  id: string;
  name: string;
  role: "admin" | "operator";
  keyHint: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

const ROLES = {
  admin: { label: "Amministratore", help: "Tutto: caselle di posta, impostazioni, utenti, oltre a regole, dati e posta." },
  operator: { label: "Operatore", help: "Regole, dati di riferimento, posta e modalità del servizio; niente caselle, impostazioni o utenti." },
} as const;

type Fresh = Access & { key: string; who: string };

/** Who may use the panel and Claude's connection: each user with an own key, revocable on its own. */
export function Users({ me }: { me: string }) {
  const users = useLoad(() => api<{ users: UserView[] }>("/api/users"), []);
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [rotating, setRotating] = useState<UserView | null>(null);
  const [removing, setRemoving] = useState<UserView | null>(null);
  const [renaming, setRenaming] = useState<UserView | null>(null);
  const { run } = useAction();

  const setRole = (user: UserView, role: UserView["role"]) =>
    run(async () => {
      await api("/api/users/update", { id: user.id, role });
      users.reload();
    }, `${user.name}: ${ROLES[role].label.toLowerCase()}`);

  if (users.error) return <ErrorBox error={users.error} onRetry={users.reload} />;
  if (!users.data) return <Spinner />;
  const list = users.data.users;
  const admins = list.filter((user) => user.role === "admin").length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Utenti</h1>
          <p className="muted">
            Ogni utente ha la sua chiave di accesso: vale per il pannello e per collegare Claude. Eliminando un utente o
            rigenerandone la chiave, la vecchia smette subito di funzionare.
          </p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Nuovo utente
        </Button>
      </div>

      {fresh ? <FreshKey fresh={fresh} onClose={() => setFresh(null)} /> : null}

      <div className="card flush">
        {list.length ? (
          <div className="list">
            {list.map((user) => {
              const lastAdmin = user.role === "admin" && admins <= 1;
              return (
                <div key={user.id} className="list-item">
                  <div className="grow stack tight">
                    <div className="row wrap">
                      <b>{user.name}</b>
                      {user.id === me ? <Badge tone="info">sei tu</Badge> : null}
                      <Badge tone={user.role === "admin" ? "warn" : ""}>{ROLES[user.role].label}</Badge>
                    </div>
                    <span className="muted small">
                      chiave {user.keyHint ?? "precedente agli utenti"} · creato {formatDate(user.createdAt)} ·{" "}
                      {user.lastUsedAt ? `ultimo uso ${formatDate(user.lastUsedAt)}` : "mai usata"}
                    </span>
                  </div>
                  <div className="row wrap">
                    <select
                      className="input"
                      style={{ width: "auto" }}
                      value={user.role}
                      disabled={lastAdmin}
                      title={lastAdmin ? "È l'unico amministratore" : ROLES[user.role].help}
                      onChange={(event) => void setRole(user, event.target.value as UserView["role"])}
                    >
                      <option value="admin">{ROLES.admin.label}</option>
                      <option value="operator">{ROLES.operator.label}</option>
                    </select>
                    <Button small onClick={() => setRenaming(user)}>
                      Rinomina
                    </Button>
                    <Button small onClick={() => setRotating(user)}>
                      Nuova chiave
                    </Button>
                    <Button
                      small
                      variant="danger"
                      disabled={user.id === me || lastAdmin}
                      title={user.id === me ? "Non puoi eliminare te stesso" : lastAdmin ? "È l'unico amministratore" : undefined}
                      onClick={() => setRemoving(user)}
                    >
                      Elimina
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty>Nessun utente.</Empty>
        )}
      </div>

      {adding ? (
        <NewUser
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false);
            setFresh(created);
            users.reload();
          }}
        />
      ) : null}
      {renaming ? (
        <RenameUser
          user={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            users.reload();
          }}
        />
      ) : null}
      {rotating ? (
        <Confirm
          title={`Nuova chiave per «${rotating.name}»?`}
          confirmLabel="Genera"
          danger
          onClose={() => setRotating(null)}
          onConfirm={async () => {
            const result = await api<Access & { key: string }>("/api/users/rotate", { id: rotating.id });
            setFresh({ ...result, who: rotating.name });
            users.reload();
          }}
        >
          La chiave attuale di {rotating.name} smette subito di funzionare: dovrà ricollegare Claude con quella nuova. Le sessioni
          del pannello già aperte restano valide.
        </Confirm>
      ) : null}
      {removing ? (
        <Confirm
          title={`Eliminare «${removing.name}»?`}
          confirmLabel="Elimina"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api("/api/users/delete", { id: removing.id });
            users.reload();
          }}
        >
          La sua chiave smette subito di funzionare, sia nel pannello sia in Claude, e le sue sessioni aperte vengono chiuse.
        </Confirm>
      ) : null}
    </div>
  );
}

function NewUser({ onClose, onCreated }: { onClose: () => void; onCreated: (fresh: Fresh) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserView["role"]>("operator");
  const { busy, run } = useAction();
  const create = () =>
    run(async () => {
      const result = await api<Access & { key: string; user: UserView }>("/api/users/create", { name: name.trim(), role });
      onCreated({ ...result, who: result.user.name });
    });
  return (
    <Modal title="Nuovo utente" onClose={onClose}>
      <Field label="Nome" hint="Chi userà la chiave, es. «Mario Rossi» o «Ufficio paghe»">
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && name.trim() && void create()}
          autoFocus
        />
      </Field>
      <Field label="Ruolo" hint={ROLES[role].help}>
        <select className="input" value={role} onChange={(event) => setRole(event.target.value as UserView["role"])}>
          <option value="operator">{ROLES.operator.label}</option>
          <option value="admin">{ROLES.admin.label}</option>
        </select>
      </Field>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button onClick={onClose}>Annulla</Button>
        <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={create}>
          Crea e genera la chiave
        </Button>
      </div>
    </Modal>
  );
}

function RenameUser({ user, onClose, onDone }: { user: UserView; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(user.name);
  const { busy, run } = useAction();
  const save = () =>
    run(async () => {
      await api("/api/users/update", { id: user.id, name: name.trim() });
      onDone();
    }, "Nome aggiornato");
  return (
    <Modal title="Rinomina utente" onClose={onClose}>
      <Field label="Nome">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button onClick={onClose}>Annulla</Button>
        <Button variant="primary" busy={busy} disabled={!name.trim() || name.trim() === user.name} onClick={save}>
          Salva
        </Button>
      </div>
    </Modal>
  );
}

/** A key is shown once, right after it is made, with the ready-to-paste Claude configuration. */
export function FreshKey({ fresh, onClose }: { fresh: Fresh; onClose?: () => void }) {
  return (
    <div className="card stack">
      <div className="row spread">
        <h2>Chiave di accesso di {fresh.who}</h2>
        {onClose ? (
          <Button small variant="ghost" onClick={onClose}>
            Ho salvato la chiave
          </Button>
        ) : null}
      </div>
      <div className="keybox">{fresh.key}</div>
      <div className="row wrap">
        <CopyButton text={fresh.key} label="Copia la chiave" />
        <span className="muted small">Viene mostrata solo ora: consegnala a {fresh.who} in modo sicuro. Serve per il pannello e per Claude.</span>
      </div>
      <ClaudeAccess access={fresh} keyKnown />
    </div>
  );
}
