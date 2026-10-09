import { z } from "zod";

/** Small helpers shared by the panel server and the first-run setup server. */

export function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, { ...init, headers: { "Cache-Control": "no-store", ...(init.headers ?? {}) } });
}

export function errorJson(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/**
 * Only JSON bodies are accepted: a cross-site form cannot send them without a
 * CORS preflight, which this server never grants (CSRF protection together
 * with the SameSite=Strict cookie).
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Serve un corpo JSON");
  }
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "JSON non valido");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Readable error responses: HTTP errors as they are, validation issues listed, anything else as 422. */
export function errorResponse(error: unknown, fallbackMessage: (error: unknown) => string): Response {
  if (error instanceof HttpError) return errorJson(error.status, error.message);
  if (error instanceof z.ZodError) {
    return errorJson(400, error.issues.map((issue) => `${issue.path.join(".") || "dati"}: ${issue.message}`).join("; "));
  }
  return errorJson(422, fallbackMessage(error));
}
