export interface AccountView {
  id: string;
  user: string;
}

/** Value of the picker for the old rules and data that belong to no mailbox (administrators only). */
export const SHARED = "__comuni__";

/**
 * Which mailbox a page works on. Hidden when there is only one choice: a user
 * with a single mailbox never has to think about it.
 */
export function AccountPicker({
  accounts,
  value,
  onChange,
  sharedLabel,
}: {
  accounts: AccountView[];
  value: string | undefined;
  onChange: (id: string) => void;
  /** Adds the «shared» choice with this label. */
  sharedLabel?: string;
}) {
  if (accounts.length + (sharedLabel ? 1 : 0) <= 1) return null;
  return (
    <select
      className="input"
      style={{ width: "auto", maxWidth: 320 }}
      aria-label="Casella"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {accounts.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.id} ({entry.user})
        </option>
      ))}
      {sharedLabel ? <option value={SHARED}>{sharedLabel}</option> : null}
    </select>
  );
}

/** Message shown to an operator who has no mailbox yet. */
export function NoMailbox() {
  return (
    <div className="card muted">
      Non hai ancora caselle di posta assegnate: chiedi a un amministratore di assegnartene una dalla pagina «Utenti».
    </div>
  );
}
