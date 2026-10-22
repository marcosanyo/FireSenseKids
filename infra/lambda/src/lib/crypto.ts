import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 128-bit random identifier/secret, URL-safe. */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

/** Secrets are 128-bit random values, so a fast hash is sufficient for storage. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretMatches(secret: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
