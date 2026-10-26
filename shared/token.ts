// Random values the server hands out, checked before any database lookup.
/** A token from token() in worker/security.ts: 32 random bytes in base64url.
 * Sessions, share links, booking codes, login codes and nonces. */
export const isToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
/** A gift or link ID from crypto.randomUUID(). */
export const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
