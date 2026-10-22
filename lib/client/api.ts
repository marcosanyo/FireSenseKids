import { API_URL } from "./config";

/** Raw, surfaced API failure (status + body). Never converted into fake data. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  auth: { sessionId: string; secret: string },
  init: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${auth.sessionId}:${auth.secret}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    // TLS failures (e.g. a device clock outside the certificate's validity) surface only as
    // "Failed to fetch" in JS, so the device time is part of the message.
    const deviceTime = new Date().toISOString();
    throw new ApiError(0, `Network error calling ${path}: ${(err as Error).message} (device time: ${deviceTime})`, null);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, `${path} → HTTP ${res.status}: ${msg}`, body);
  }
  return body as T;
}
