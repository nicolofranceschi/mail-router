import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { ACTION_STATUS, ACTION_TYPE, describeAction } from "./format";

// ---- data loading -------------------------------------------------------------

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = [], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!refreshMs) return;
    const timer = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

// ---- toasts --------------------------------------------------------------------

type Toast = { id: number; text: string; error?: boolean };
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, error }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), error ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.error ? "err" : ""}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Runs an action with a busy flag and reports failures as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await action();
        if (success) toast(success);
        return result;
      } catch (failure) {
        toast((failure as Error).message, true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---- primitives -------------------------------------------------------------------

export function Button({
  children,
  variant,
  small,
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost"; small?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={["btn", variant, small ? "small" : "", props.className ?? ""].filter(Boolean).join(" ")}
    >
      {busy ? <span className="spinner" /> : null}
      {children}
    </button>
  );
}

export function Badge({ tone, children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small className="hint">{hint}</small> : null}
    </label>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row muted">
      <span className="spinner" /> {label ?? "Caricamento…"}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="notice err row spread">
      <span>{error}</span>
      {onRetry ? (
        <Button small onClick={onRetry}>
          Riprova
        </Button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted" style={{ padding: "18px", textAlign: "center" }}>{children}</div>;
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <div className="row spread">
          <h2>{title}</h2>
          <Button variant="ghost" small onClick={onClose} aria-label="Chiudi">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div>{children}</div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button onClick={onClose}>Annulla</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function CopyButton({ text, label = "Copia" }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <Button
      small
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast("Copiato negli appunti");
        } catch {
          toast("Copia non riuscita: seleziona il testo e copialo a mano", true);
        }
      }}
    >
      {label}
    </Button>
  );
}

export function ActionChips({ actions }: { actions: Record<string, any>[] }) {
  if (!actions.length) return null;
  return (
    <div className="stack tight">
      {actions.map((action, index) => {
        const status = ACTION_STATUS[action.status] ?? { label: action.status, tone: "" };
        const detail = describeAction(action);
        return (
          <div key={action.id ?? index} className="row wrap small">
            <Badge tone={status.tone}>{status.label}</Badge>
            <span>
              {ACTION_TYPE[action.type] ?? action.type}
              {detail ? ` ${detail}` : ""}
            </span>
            {action.detail ? <span className="muted">— {action.detail}</span> : null}
            {action.note ? <span className="muted">— {action.note}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
