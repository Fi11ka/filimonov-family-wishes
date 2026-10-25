import { fail, usernameOf, type Identity } from "./security";
// Telegram Login (OpenID Connect). The official telegram-login.js popup returns
// a signed id_token; it is verified here with Telegram's published keys.
// https://core.telegram.org/bots/telegram-login#validating-id-tokens
export const OIDC_ISSUER = "https://oauth.telegram.org";
export const JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";
/** id_token must be fresh: the popup sends it right after the user confirms. */
const MAX_AGE = 600,
  CLOCK_SKEW = 300;
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}
/** Network access for the key set; tests pass their own keys. */
export type JwksSource = (refresh: boolean) => Promise<Jwk[]>;
// Only algorithms Telegram allows together with the "profile" scope.
const ALGORITHMS = {
  RS256: {
    kty: "RSA",
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  ES256: {
    kty: "EC",
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
} as const;
const encoder = new TextEncoder();
function b64url(part: string) {
  const s = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function json(part: string): Record<string, unknown> {
  const v = JSON.parse(new TextDecoder().decode(b64url(part)));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
  return v;
}
function invalid(): never {
  return fail(
    401,
    "AUTH_INVALID",
    "Не удалось подтвердить вход через Telegram.",
  );
}
/**
 * Verifies an id_token and returns the Telegram account. `nonce` is the value
 * our server issued for this login; the caller consumes it once.
 */
export async function verifyIdToken(
  token: unknown,
  opts: {
    clientId: string;
    nonce: (value: string) => Promise<boolean>;
    jwks: JwksSource;
    now?: number;
  },
): Promise<Identity> {
  if (typeof token !== "string" || token.length > 8192) invalid();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    invalid();
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = json(parts[0]);
    claims = json(parts[1]);
  } catch {
    invalid();
  }
  // Never let the token choose a weaker scheme ("none", HS256 with a public key…).
  const alg = ALGORITHMS[header.alg as keyof typeof ALGORITHMS];
  if (!alg || typeof header.kid !== "string") invalid();
  const pick = (keys: Jwk[]) =>
    keys.find(
      (k) =>
        k.kid === header.kid &&
        k.kty === alg.kty &&
        (!k.alg || k.alg === header.alg),
    );
  // Telegram may rotate keys: an unknown kid triggers one fresh download.
  const jwk = pick(await opts.jwks(false)) || pick(await opts.jwks(true));
  if (!jwk) invalid();
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      alg.import,
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify(
      alg.verify,
      key,
      b64url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    ok = false;
  }
  if (!ok) invalid();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const aud = claims.aud;
  const exp = Number(claims.exp),
    iat = Number(claims.iat);
  if (
    claims.iss !== OIDC_ISSUER ||
    !(Array.isArray(aud) ? aud.map(String) : [String(aud)]).includes(
      opts.clientId,
    ) ||
    !Number.isSafeInteger(exp) ||
    exp + CLOCK_SKEW < now ||
    !Number.isSafeInteger(iat) ||
    iat > now + CLOCK_SKEW ||
    now - iat > MAX_AGE
  )
    fail(401, "AUTH_EXPIRED", "Время входа истекло. Войдите ещё раз.");
  // Replay protection: the nonce we issued must be present and unused.
  if (
    typeof claims.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(claims.nonce) ||
    !(await opts.nonce(claims.nonce))
  )
    fail(401, "AUTH_EXPIRED", "Время входа истекло. Войдите ещё раз.");
  // "id" (the Telegram user ID used by the Mini App) arrives with the profile scope;
  // "sub" is a different identifier and cannot be matched to existing accounts.
  const id = Number(claims.id);
  if (!Number.isSafeInteger(id) || id <= 0) invalid();
  const name =
    (typeof claims.name === "string" && claims.name.trim()) ||
    [claims.given_name, claims.family_name]
      .filter((v) => typeof v === "string" && v)
      .join(" ");
  return {
    id: String(id),
    name: String(name || "Участник").slice(0, 160),
    username: usernameOf(claims.preferred_username),
  };
}
/** Key set from Telegram with a short in-memory cache per Worker instance. */
export function liveJwks(
  load: () => Promise<Jwk[]>,
  ttlMs = 3600_000,
): JwksSource {
  let cache: { keys: Jwk[]; at: number } | null = null,
    lastForced = 0;
  return async (refresh) => {
    if (!refresh && cache && Date.now() - cache.at < ttlMs) return cache.keys;
    if (refresh && cache) {
      // Forced reloads (unknown kid) are allowed once per minute so tokens
      // with made-up key IDs cannot hammer Telegram.
      if (Date.now() - lastForced < 60_000) return cache.keys;
      lastForced = Date.now();
    }
    const keys = await load();
    cache = { keys, at: Date.now() };
    return keys;
  };
}
