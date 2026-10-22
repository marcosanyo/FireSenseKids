// Build-time endpoints (validated in next.config.ts). Literal access so Next.js inlines them.
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL as string;
export const API_URL = (process.env.NEXT_PUBLIC_API_URL as string).replace(/\/$/, "");
export const WEB_ORIGIN = (process.env.NEXT_PUBLIC_WEB_ORIGIN as string).replace(/\/$/, "");

export function cameraPairingUrl(sessionId: string, pairingToken: string): string {
  const q = new URLSearchParams({ s: sessionId, t: pairingToken });
  return `${WEB_ORIGIN}/camera/?${q.toString()}`;
}

/** The parent phone's page, opened from the TV's parent QR (`pt` = one-time parent token). */
export function parentPairingUrl(sessionId: string, pairingToken: string): string {
  const q = new URLSearchParams({ s: sessionId, pt: pairingToken });
  return `${WEB_ORIGIN}/parent/?${q.toString()}`;
}

/** Local calendar date YYYY-MM-DD (daily summaries follow the household's day, not UTC). */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
