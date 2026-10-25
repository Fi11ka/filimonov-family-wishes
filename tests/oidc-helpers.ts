import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
// Test stand-in for Telegram's OIDC signer: our own key pairs, published as a
// JWKS, and id_tokens signed the way oauth.telegram.org signs them.
export const BOT_ID = "123456";
export interface TestKey {
  kid: string;
  alg: "RS256" | "ES256";
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}
export function makeKey(alg: "RS256" | "ES256", kid: string): TestKey {
  const { privateKey, publicKey } =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    kid,
    alg,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg, use: "sig" },
  };
}
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
export function idToken(
  key: TestKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(
    JSON.stringify({ alg: key.alg, kid: key.kid, typ: "JWT", ...header }),
  );
  const body = b64(
    JSON.stringify({
      iss: "https://oauth.telegram.org",
      aud: BOT_ID,
      sub: "9876543210123456789",
      iat: now,
      exp: now + 3600,
      id: 1,
      name: "User 1",
      preferred_username: "user_1",
      ...claims,
    }),
  );
  const data = Buffer.from(`${head}.${body}`);
  const signature =
    key.alg === "RS256"
      ? sign("sha256", data, key.privateKey)
      : sign("sha256", data, {
          key: key.privateKey,
          dsaEncoding: "ieee-p1363",
        });
  return `${head}.${body}.${b64(signature)}`;
}
