import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { liveJwks, verifyIdToken, type Jwk } from "../worker/oidc";
import { BOT_ID, idToken, makeKey } from "./oidc-helpers";
const rsa = makeKey("RS256", "oidc-1"),
  ec = makeKey("ES256", "oidc-es256-1");
const NONCE = "n".repeat(43);
function options(overrides: Partial<Parameters<typeof verifyIdToken>[1]> = {}) {
  const used = new Set<string>();
  return {
    clientId: BOT_ID,
    jwks: async () => [rsa.jwk, ec.jwk] as Jwk[],
    // Behaves like the D1 table: a nonce works once.
    nonce: async (v: string) => v === NONCE && !used.has(v) && !!used.add(v),
    ...overrides,
  };
}
const rejects = async (token: unknown, opts = options()) =>
  assert.rejects(verifyIdToken(token, opts), (e: any) => e.status === 401);
test("OIDC: valid RS256 and ES256 tokens give the Mini App account (Telegram id, not sub)", async () => {
  for (const key of [rsa, ec]) {
    const me = await verifyIdToken(
      idToken(key, {
        nonce: NONCE,
        id: 42,
        name: "Анна Ф",
        preferred_username: "Anna_F",
      }),
      options(),
    );
    assert.deepEqual(me, { id: "42", name: "Анна Ф", username: "anna_f" });
  }
  // name may be absent; given/family names are used, then a placeholder.
  const parts = await verifyIdToken(
    idToken(rsa, {
      nonce: NONCE,
      name: undefined,
      given_name: "Анна",
      family_name: "Ф",
    }),
    options(),
  );
  assert.equal(parts.name, "Анна Ф");
  // aud may be an array.
  await verifyIdToken(
    idToken(rsa, { nonce: NONCE, aud: ["other", BOT_ID] }),
    options(),
  );
});
test("OIDC: forged, foreign and malformed tokens are rejected", async () => {
  const good = idToken(rsa, { nonce: NONCE });
  const [h, b, s] = good.split(".");
  const tamper = (claims: Record<string, unknown>) =>
    `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, "base64url").toString()), ...claims })).toString("base64url")}.${s}`;
  const stranger = makeKey("RS256", "oidc-1"); // same kid, different key
  for (const bad of [
    tamper({ id: 2 }), // changed payload, old signature
    idToken(stranger, { nonce: NONCE }),
    `${h}.${b}.${Buffer.from("x").toString("base64url")}`,
    "not-a-jwt",
    "a.b",
    `${h}.${b}.${s}.extra`,
    12345,
    null,
    "x".repeat(9000),
  ])
    await rejects(bad);
  // alg "none" and HS256 (with the public key as an HMAC secret) are refused.
  const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "oidc-1" })).toString("base64url")}.${b}.`;
  await rejects(none);
  const hsHead = Buffer.from(
    JSON.stringify({ alg: "HS256", kid: "oidc-1" }),
  ).toString("base64url");
  const hsSig = createHmac("sha256", JSON.stringify(rsa.jwk))
    .update(`${hsHead}.${b}`)
    .digest("base64url");
  await rejects(`${hsHead}.${b}.${hsSig}`);
  // RSA key cannot verify an ES256 header and vice versa.
  await rejects(idToken(rsa, { nonce: NONCE }, { alg: "ES256" }));
  // EdDSA/ES256K are not accepted (Telegram drops profile data with them).
  await rejects(idToken(rsa, { nonce: NONCE }, { alg: "EdDSA" }));
});
test("OIDC: wrong issuer, audience, expired or stale tokens are rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { iss: "https://evil.example" },
    { aud: "999999" },
    { aud: undefined },
    { exp: now - 3600 },
    { iat: now - 3600 }, // issued an hour ago: not a fresh login
    { iat: now + 3600 }, // from the future
    { exp: "soon" },
  ])
    await rejects(idToken(rsa, { nonce: NONCE, ...claims }));
});
test("OIDC: the nonce we issued is required and works once", async () => {
  const opts = options();
  await verifyIdToken(idToken(rsa, { nonce: NONCE }), opts);
  await rejects(idToken(rsa, { nonce: NONCE }), opts); // replay
  await rejects(idToken(rsa, { nonce: "m".repeat(43) })); // not issued by us
  await rejects(idToken(rsa, {})); // missing
  await rejects(idToken(rsa, { nonce: "short" }));
});
test("OIDC: a token without the profile scope (no Telegram id) cannot sign in", async () => {
  await rejects(idToken(rsa, { nonce: NONCE, id: undefined }));
  await rejects(idToken(rsa, { nonce: NONCE, id: -5 }));
  await rejects(idToken(rsa, { nonce: NONCE, id: "abc" }));
});
test("OIDC: an unknown key ID triggers one fresh key download, then is throttled", async () => {
  let published: Jwk[] = [rsa.jwk as Jwk],
    downloads = 0;
  const jwks = liveJwks(async () => {
    downloads++;
    return published;
  });
  await verifyIdToken(idToken(rsa, { nonce: NONCE }), options({ jwks }));
  assert.equal(downloads, 1);
  // Telegram rotates to the EC key: the first unknown kid reloads the set.
  published = [rsa.jwk as Jwk, ec.jwk as Jwk];
  await verifyIdToken(idToken(ec, { nonce: NONCE }), options({ jwks }));
  assert.equal(downloads, 2);
  // Made-up key IDs right after do not cause more downloads.
  const ghost = makeKey("RS256", "ghost");
  await rejects(idToken(ghost, { nonce: NONCE }), options({ jwks }));
  assert.equal(downloads, 2);
});
