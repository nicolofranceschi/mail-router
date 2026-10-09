export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** The panel shows the login again when a call finds the session expired. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/session")) unauthorizedListeners.forEach((listener) => listener());
    throw new ApiError(response.status, data.error ?? `Errore ${response.status}`);
  }
  return data as T;
}

/** Runs one of the service tools (the same ones Claude uses over MCP). */
export function tool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return api<T>(`/api/tools/${name}`, { args });
}
