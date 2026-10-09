import { useEffect, useState } from "react";

import { tool } from "../api";
import { ActionChips, Badge, Button, Confirm, Empty, ErrorBox, Field, Modal, Spinner, useAction, useLoad } from "../components";
import { formatDate, RULE_MODE } from "../format";

const TEMPLATE = `function rule(email, data, h) {
  // Restituisci null se la regola non riguarda il messaggio.
  if (email.bulk || email.autoSubmitted) return null;
  if (h.isFrom(email, "esempio.it")) {
    return { forward: "ufficio@azienda.it", reason: "Mittente esempio.it" };
  }
  return null;
}
`;

export function Rules() {
  const rules = useLoad(() => tool("list_rules"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { run } = useAction();

  const setMode = (id: string, mode: string) =>
    run(async () => {
      await tool("update_rule", { id, mode });
      rules.reload();
    }, `Regola ${RULE_MODE[mode]?.label.toLowerCase()}`);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Regole</h1>
          <p className="muted">
            Le regole le scrive Claude quando gliele chiedi a parole. Qui le controlli, le provi sulle mail vere e decidi quali
            accendere. Vengono valutate dall'alto in basso.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Nuova regola</Button>
      </div>

      {rules.error ? <ErrorBox error={rules.error} onRetry={rules.reload} /> : null}
      {!rules.data ? (
        <Spinner />
      ) : (
        <div className="split">
          <div className="card flush">
            {rules.data.rules.length ? (
              <div className="list">
                {rules.data.rules.map((rule: any) => (
                  <div
                    key={rule.id}
                    className={`list-item clickable ${selected === rule.id ? "selected" : ""}`}
                    onClick={() => setSelected(rule.id)}
                  >
                    <span className="muted small mono" style={{ width: 28 }}>
                      {rule.priority}
                    </span>
                    <div className="grow stack tight">
                      <div className="row spread">
                        <b className="ellipsis">{rule.name}</b>
                        <select
                          className="input"
                          style={{ width: "auto", padding: "3px 6px" }}
                          value={rule.mode}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setMode(rule.id, event.target.value)}
                        >
                          {Object.entries(RULE_MODE).map(([value, meta]) => (
                            <option key={value} value={value}>
                              {meta.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <span className="muted small">{rule.description}</span>
                      <span className="small muted">
                        Ultimi 30 giorni: {rule.last30Days.matched} messaggi riconosciuti
                        {rule.last30Days.errors ? <Badge tone="err">{rule.last30Days.errors} errori</Badge> : null}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>Nessuna regola. Chiedi a Claude di crearne una, oppure usa «Nuova regola».</Empty>
            )}
            {rules.data.deletedRules?.length ? (
              <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)" }} className="stack tight">
                <span className="muted small">Eliminate di recente</span>
                {rules.data.deletedRules.map((rule: any) => (
                  <div key={rule.id} className="row spread small">
                    <span className="ellipsis">{rule.name}</span>
                    <Button
                      small
                      onClick={() =>
                        run(async () => {
                          await tool("restore_rule", { id: rule.id, version: rule.version });
                          rules.reload();
                        }, "Regola ripristinata")
                      }
                    >
                      Ripristina
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {selected ? (
            <RuleDetail
              key={selected}
              id={selected}
              onChanged={rules.reload}
              onDeleted={() => {
                setSelected(null);
                rules.reload();
              }}
            />
          ) : (
            <div className="card muted">Seleziona una regola per vederne il codice, provarla o modificarla.</div>
          )}
        </div>
      )}
      {creating ? (
        <NewRule
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            rules.reload();
            setSelected(id);
          }}
        />
      ) : null}
    </div>
  );
}

function RuleDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const rule = useLoad(() => tool("get_rule", { id, includeHistory: true }), [id]);
  const [draft, setDraft] = useState<{ name: string; description: string; priority: string; code: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, run } = useAction();

  useEffect(() => {
    if (rule.data) {
      setDraft({ name: rule.data.name, description: rule.data.description, priority: String(rule.data.priority), code: rule.data.code });
    }
  }, [rule.data]);

  if (rule.error) return <ErrorBox error={rule.error} onRetry={rule.reload} />;
  if (!rule.data || !draft) return <Spinner />;

  const dirty =
    draft.name !== rule.data.name ||
    draft.description !== rule.data.description ||
    draft.priority !== String(rule.data.priority) ||
    draft.code !== rule.data.code;

  return (
    <div className="card stack">
      <div className="row spread">
        <h2 className="ellipsis">{rule.data.name}</h2>
        <Badge tone={RULE_MODE[rule.data.mode]?.tone}>{RULE_MODE[rule.data.mode]?.label}</Badge>
      </div>
      <div className="form-grid">
        <Field label="Nome">
          <input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Priorità" hint="Numero più basso = valutata prima">
          <input className="input" inputMode="numeric" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })} />
        </Field>
      </div>
      <Field label="Cosa fa">
        <textarea className="input" style={{ minHeight: 60 }} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </Field>
      <Field label="Codice" hint="JavaScript eseguito in un ambiente isolato: function rule(email, data, h)">
        <textarea className="input code" spellCheck={false} value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} />
      </Field>
      <div className="row wrap">
        <Button
          variant="primary"
          busy={busy}
          disabled={!dirty}
          onClick={() =>
            run(async () => {
              await tool("update_rule", {
                id,
                name: draft.name,
                description: draft.description,
                priority: Number(draft.priority),
                code: draft.code,
              });
              rule.reload();
              onChanged();
            }, "Regola salvata")
          }
        >
          Salva
        </Button>
        <Button onClick={() => setTesting(true)}>Prova sulle mail vere</Button>
        <span className="grow" />
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Elimina
        </Button>
      </div>

      <details>
        <summary className="muted small" style={{ cursor: "pointer" }}>
          Cronologia ({rule.data.history?.length ?? 0} versioni)
        </summary>
        <div className="stack tight" style={{ marginTop: 10 }}>
          {rule.data.history?.map((version: any) => (
            <div key={version.version} className="row spread small">
              <span>
                v{version.version} · {version.change === "created" ? "creata" : version.change === "deleted" ? "eliminata" : "modificata"} ·{" "}
                {formatDate(version.savedAt)} · {RULE_MODE[version.mode]?.label}
              </span>
              {version.version !== rule.data.version ? (
                <Button
                  small
                  onClick={() =>
                    run(async () => {
                      await tool("restore_rule", { id, version: version.version });
                      rule.reload();
                      onChanged();
                    }, `Ripristinata la versione ${version.version}`)
                  }
                >
                  Ripristina
                </Button>
              ) : (
                <span className="muted">attuale</span>
              )}
            </div>
          ))}
        </div>
      </details>

      {testing ? <TestRun code={draft.code} title={`Prova: ${draft.name}`} onClose={() => setTesting(false)} /> : null}
      {confirmDelete ? (
        <Confirm
          title="Eliminare la regola?"
          confirmLabel="Elimina"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await tool("delete_rule", { id });
            onDeleted();
          }}
        >
          «{rule.data.name}» smette subito di essere applicata. Resta nella cronologia e puoi ripristinarla.
        </Confirm>
      ) : null}
    </div>
  );
}

export function TestRun({ code, title, onClose }: { code?: string; title: string; onClose: () => void }) {
  const [last, setLast] = useState(50);
  const [showAll, setShowAll] = useState(false);
  const report = useLoad(() => tool("test_rules", { ...(code ? { code } : {}), last, showAll }), [last, showAll]);
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="row wrap">
        <span className="muted small">Nessun messaggio viene inviato o modificato.</span>
        <span className="grow" />
        <select className="input" style={{ width: "auto" }} value={last} onChange={(event) => setLast(Number(event.target.value))}>
          {[20, 50, 100, 200, 300].map((value) => (
            <option key={value} value={value}>
              ultime {value} mail
            </option>
          ))}
        </select>
        <label className="check small">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> mostra anche quelle non riconosciute
        </label>
      </div>
      {report.loading && !report.data ? <Spinner label="Provo la regola sui messaggi…" /> : null}
      {report.error ? <ErrorBox error={report.error} onRetry={report.reload} /> : null}
      {report.data ? (
        <div className="stack">
          <p>
            Su <b>{report.data.tested}</b> messaggi: <b>{report.data.matched}</b> riconosciuti
            {report.data.errors ? (
              <>
                , <span style={{ color: "var(--err)" }}>{report.data.errors} con errori</span>
              </>
            ) : null}
            .
          </p>
          {report.data.results.length ? (
            <div className="card flush">
              <div className="list">
                {report.data.results.map((result: any) => (
                  <div key={result.uid} className="list-item">
                    <div className="grow stack tight">
                      <div className="row spread">
                        <b className="ellipsis">{result.subject || "(senza oggetto)"}</b>
                        <span className="muted small">{formatDate(result.date)}</span>
                      </div>
                      <span className="muted small">{result.from}</span>
                      {result.error ? <span style={{ color: "var(--err)" }}>{result.error}</span> : null}
                      {result.rules
                        ?.filter((entry: any) => entry.error)
                        .map((entry: any) => (
                          <span key={entry.rule} className="small" style={{ color: "var(--err)" }}>
                            {entry.rule}: {entry.error}
                          </span>
                        ))}
                      {result.rules
                        ?.filter((entry: any) => entry.decision?.reason)
                        .map((entry: any) => (
                          <span key={entry.rule} className="small muted">
                            {code ? "" : `${entry.rule}: `}
                            {entry.decision.reason}
                          </span>
                        ))}
                      <ActionChips actions={result.wouldDo ?? []} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="muted">Nessun messaggio riconosciuto.</p>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

function NewRule({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState(TEMPLATE);
  const { busy, run } = useAction();
  return (
    <Modal title="Nuova regola" onClose={onClose} wide>
      <p className="muted small">
        Più semplice: chiedi a Claude di scriverla. Se la scrivi a mano, nasce «in prova» e non agisce finché non la attivi.
      </p>
      <Field label="Nome">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>
      <Field label="Cosa fa">
        <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field label="Codice">
        <textarea className="input code" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} />
      </Field>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button onClick={onClose}>Annulla</Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!name.trim()}
          onClick={async () => {
            const created = await run(() => tool("create_rule", { name, description, code }), "Regola creata in prova");
            if (created) onCreated(created.created.id);
          }}
        >
          Crea
        </Button>
      </div>
    </Modal>
  );
}
