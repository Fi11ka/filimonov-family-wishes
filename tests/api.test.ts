import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { Miniflare, createFetchMock } from "miniflare";
import { idToken, makeKey } from "./oidc-helpers";
import { validateInitData } from "../worker/security";
const BOT = "123456:TEST_ONLY_NOT_A_REAL_TOKEN";
const origin = "https://family.example";
let mf: Miniflare;
// Telegram's OIDC keys are replaced by test keys served from a fetch mock.
const oidcKey = makeKey("RS256", "oidc-1");
const fetchMock = createFetchMock();
fetchMock
  .get("https://oauth.telegram.org")
  .intercept({ path: "/.well-known/jwks.json" })
  .reply(200, JSON.stringify({ keys: [oidcKey.jwk] }), {
    headers: { "content-type": "application/json" },
  })
  .persist();
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
function signed(
  id: number,
  extra: Record<string, string> = {},
  username: string | null = `user_${id}`,
) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({
      id,
      first_name: `User ${id}`,
      ...(username ? { username } : {}),
    }),
    ...extra,
  });
  const data = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(BOT).digest();
  p.set("hash", createHmac("sha256", key).update(data).digest("hex"));
  return p.toString();
}
async function call(
  path: string,
  id?: number,
  method = "GET",
  value?: unknown,
  guest?: string,
  headers: Record<string, string> = {},
) {
  const res = await mf.dispatchFetch(`https://api.example/api${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(id ? { Authorization: `tma ${signed(id)}` } : {}),
      ...(value !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(guest ? { "X-Guest-Token": guest } : {}),
      ...headers,
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, raw, headers: res.headers };
}
const input = {
  title: "Подарок",
  price_minor: 2599,
  currency: "EUR",
  shop_url: "https://example.com/product",
  description: "Размер M",
  priority: 3,
  photo: "data:image/png;base64,aGVsbG8=",
};
async function gift(id = 1, overrides = {}) {
  const r = await call("/gifts", id, "POST", { ...input, ...overrides });
  assert.equal(r.status, 200, r.raw);
  return r.body.id as string;
}
async function migrate(file: string) {
  // Run real migrations against workerd's D1 SQLite, not an in-memory JS mock.
  const statements: string[] = [];
  let statement = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!statement && line.trimStart().startsWith("--")) continue;
    statement += line + " ";
    if (
      statement.trimStart().startsWith("CREATE TRIGGER")
        ? !/END;\s*$/.test(statement)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    statements.push(statement.trim());
    statement = "";
  }
  await db.batch(statements.map((sql) => db.prepare(sql)));
}
before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: ".test/worker.mjs",
    compatibilityDate: "2026-07-01",
    d1Databases: { DB: "test" },
    bindings: { BOT_TOKEN: BOT, APP_ORIGIN: origin, APP_URL: `${origin}/app/` },
    fetchMock,
    log: undefined,
  });
  db = await mf.getD1Database("DB");
  await migrate("migrations/0001_initial.sql");
  // A family created before the switch to profiles: 1, 2 and 3 share it, 4 does not.
  await db.batch([
    ...[1, 2, 3, 4].map((id) =>
      db
        .prepare("INSERT INTO users(id,name) VALUES(?,?)")
        .bind(String(id), `User ${id}`),
    ),
    db.prepare(
      "INSERT INTO families(id,name,owner_id,invite_hash) VALUES('f1','Семья','1','x')",
    ),
    ...[1, 2, 3].map((id) =>
      db
        .prepare("INSERT INTO members(user_id,family_id) VALUES(?, 'f1')")
        .bind(String(id)),
    ),
  ]);
  await migrate("migrations/0002_profiles_friends_archive.sql");
  await migrate("migrations/0003_web_sessions.sql");
  await migrate("migrations/0004_oidc_login.sql");
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal((await call("/me", id)).status, 200);
});
after(async () => {
  await mf?.dispose();
});
test("Telegram: valid HMAC including signature field", async () => {
  const me = await validateInitData(
    signed(99, { signature: "example-signature" }),
    BOT,
  );
  assert.equal(me.id, "99");
  assert.equal(me.username, "user_99");
});
test("Telegram: forged user, malformed HMAC, expired/future and duplicate fields rejected", async () => {
  await assert.rejects(
    validateInitData(signed(1).replace("User+1", "Someone"), BOT),
  );
  const forged = new URLSearchParams(signed(1));
  forged.set("user", JSON.stringify({ id: 2, first_name: "Fake" }));
  await assert.rejects(validateInitData(forged.toString(), BOT));
  for (const raw of [
    "",
    signed(1) + "&user=extra",
    signed(1, { auth_date: "1" }),
    signed(1, { auth_date: String(Math.floor(Date.now() / 1000) + 600) }),
    signed(1, { user: "null" }),
    signed(1, { user: '{"id":-1,"first_name":"X"}' }),
  ])
    await assert.rejects(validateInitData(raw, BOT));
});
test("unauthenticated identity and untrusted user ID cannot grant access", async () => {
  assert.equal((await call("/me")).status, 401);
  assert.equal(
    (await call("/gifts", undefined, "POST", { ...input, user_id: 1 })).status,
    401,
  );
  assert.equal(
    (
      await call("/me", undefined, "GET", undefined, undefined, {
        Authorization: "tma invalid",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call("/fetch/product", undefined, "POST", {
        url: "https://example.com",
      })
    ).status,
    401,
  );
});
test("former family members become friends of each other", async () => {
  const f = (await call("/friends", 1)).body;
  assert.deepEqual(
    f.friends.map((x: any) => x.id),
    ["2", "3"],
  );
  assert.equal(f.friends[0].username, "user_2");
  assert.equal((await call("/friends", 4)).body.friends.length, 0);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM friendships WHERE status='accepted'",
        )
        .first()
    )?.n,
    3,
  );
});
test("friend isolation and gift ownership are enforced", async () => {
  const g = await gift();
  assert.equal((await call("/lists/1", 2)).status, 200);
  assert.equal((await call("/lists/1", 4)).status, 404);
  assert.equal(
    (await call(`/gifts/${g}`, 2, "PUT", { ...input, title: "Hacked" })).status,
    404,
  );
  assert.equal((await call(`/gifts/${g}`, 2, "DELETE")).status, 404);
  assert.equal((await call(`/gifts/${g}/archive`, 2, "POST")).status, 404);
  assert.equal((await call(`/gifts/${g}/photo`, 4)).status, 404);
  assert.equal(
    (await call(`/gifts/${g}`, 1, "PUT", { ...input, title: "Изменено" }))
      .status,
    200,
  );
  assert.equal((await call(`/gifts/${g}`, 1, "DELETE")).status, 200);
});
test("owner response remains byte-identical before/after reservation; no identity or timestamps leak", async () => {
  const g = await gift();
  const before = await call("/lists/1", 1);
  assert.equal((await call(`/gifts/${g}/reservation`, 2, "POST")).status, 200);
  const after = await call("/lists/1", 1);
  assert.equal(before.raw, after.raw);
  assert.ok(!after.raw.includes("reservation"));
  assert.ok(!after.raw.includes("user_id"));
  const ownGuest = await call("/guest-links", 1, "POST");
  const ownerView = await call(
    "/guest",
    1,
    "GET",
    undefined,
    ownGuest.body.token,
  );
  assert.ok(!ownerView.raw.includes("reservation"));
  const photo = await call(`/gifts/${g}/photo`, 1);
  assert.deepEqual(Object.keys(photo.body), ["photo"]);
  assert.equal((await call("/reservations", 1)).body.reservations.length, 0);
  assert.equal((await call(`/gifts/${g}/reservation`, 1, "POST")).status, 403);
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 1, "DELETE")).status,
    403,
  );
  const other = await call("/lists/1", 3);
  assert.equal(
    other.body.gifts.find((v: any) => v.id === g).reservation,
    "reserved",
  );
  assert.ok(!other.raw.includes("user_id"));
  assert.equal(
    (await call("/lists/1", 2)).body.gifts.find((v: any) => v.id === g)
      .reservation,
    "mine",
  );
  // Archiving and restoring a reserved gift answers exactly like an unreserved one.
  const free = await gift();
  const a = await call(`/gifts/${g}/archive`, 1, "POST"),
    b = await call(`/gifts/${free}/archive`, 1, "POST");
  assert.equal(a.raw, b.raw);
  const archive = await call("/archive", 1);
  assert.ok(!archive.raw.includes("reservation"));
  assert.equal((await call(`/gifts/${g}/restore`, 1, "POST")).raw, a.raw);
  await call(`/gifts/${free}/restore`, 1, "POST");
});
test("atomic concurrent reservations: exactly one succeeds", async () => {
  const g = await gift();
  const r = await Promise.all([
    call(`/gifts/${g}/reservation`, 2, "POST"),
    call(`/gifts/${g}/reservation`, 3, "POST"),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM reservations WHERE gift_id=?")
        .bind(g)
        .first()
    )?.n,
    1,
  );
  const winner = r[0].status === 200 ? 2 : 3,
    loser = winner === 2 ? 3 : 2;
  assert.equal(
    (await call(`/gifts/${g}/reservation`, loser, "DELETE")).status,
    200,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM reservations WHERE gift_id=?")
        .bind(g)
        .first()
    )?.n,
    1,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, winner, "DELETE")).status,
    200,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, loser, "POST")).status,
    200,
  );
});
test("archive: bought gifts leave friends' lists, cannot be reserved and can be restored", async () => {
  const g = await gift(1, { title: "Куплено" });
  assert.equal((await call(`/gifts/${g}/archive`, 1, "POST")).status, 200);
  assert.ok(
    !(await call("/lists/1", 2)).body.gifts.some((v: any) => v.id === g),
  );
  assert.ok(
    !(await call("/lists/1", 1)).body.gifts.some((v: any) => v.id === g),
  );
  const archive = (await call("/archive", 1)).body.gifts;
  assert.ok(archive.some((v: any) => v.id === g && v.archived_at > 0));
  assert.equal((await call("/archive", 2)).body.gifts.length, 0);
  assert.equal((await call(`/gifts/${g}/reservation`, 2, "POST")).status, 404);
  assert.equal((await call(`/gifts/${g}/photo`, 2)).status, 404);
  assert.equal((await call(`/gifts/${g}/photo`, 1)).status, 200);
  assert.equal((await call(`/gifts/${g}/restore`, 1, "POST")).status, 200);
  assert.ok(
    (await call("/lists/1", 2)).body.gifts.some((v: any) => v.id === g),
  );
  // Imported "bought" rows go straight to the archive.
  const r = await call("/gifts", 1, "POST", { ...input, archived: true });
  assert.equal(r.status, 200);
  assert.ok(
    (await call("/archive", 1)).body.gifts.some((v: any) => v.id === r.body.id),
  );
});
test("guest scope, anonymous anti-spoiler, authenticated reservation and revocation", async () => {
  const g = await gift(),
    unrelated = await gift(2);
  const link = await call("/guest-links", 1, "POST"),
    raw = link.body.token;
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  const stored = await db
    .prepare("SELECT token_hash FROM guest_links WHERE id=?")
    .bind(link.body.id)
    .first();
  assert.notEqual(stored?.token_hash, raw);
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, "invalid")).status,
    404,
  );
  const anonymous = await call("/guest", undefined, "GET", undefined, raw);
  assert.equal(anonymous.status, 200);
  assert.ok(!anonymous.raw.includes("reservation"));
  assert.equal(anonymous.body.can_reserve, false);
  assert.equal(
    (await call(`/gifts/${g}/photo`, undefined, "GET", undefined, raw)).status,
    200,
  );
  assert.equal(
    (await call(`/gifts/${unrelated}/photo`, undefined, "GET", undefined, raw))
      .status,
    404,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, undefined, "POST", undefined, raw))
      .status,
    401,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 4, "POST", undefined, raw)).status,
    200,
  );
  assert.equal((await call("/lists/2", 4, "GET", undefined, raw)).status, 404);
  assert.equal(
    (await call(`/gifts/${unrelated}/reservation`, 4, "POST", undefined, raw))
      .status,
    404,
  );
  assert.equal((await call(`/gifts/${g}`, 4, "PUT", input, raw)).status, 404);
  assert.equal(
    (await call("/friends", 4, "GET", undefined, raw)).body.friends.length,
    0,
  );
  assert.equal(
    (await call(`/guest-links/${link.body.id}`, 1, "DELETE")).status,
    200,
  );
  assert.equal((await call("/guest", 4, "GET", undefined, raw)).status, 404);
  assert.equal(
    (await call(`/gifts/${g}/photo`, 4, "GET", undefined, raw)).status,
    404,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 4, "DELETE")).status,
    200,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 4, "POST", undefined, raw)).status,
    404,
  );
});
test("expired guest link cannot grant access and new link revokes old", async () => {
  const a = await call("/guest-links", 2, "POST"),
    b = await call("/guest-links", 2, "POST");
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, a.body.token)).status,
    404,
  );
  await db
    .prepare("UPDATE guest_links SET expires_at=1 WHERE id=?")
    .bind(b.body.id)
    .run();
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, b.body.token)).status,
    404,
  );
});
test("friend requests by username need confirmation", async () => {
  assert.equal(
    (await call("/friends/requests", 5, "POST", { username: "@nobody_here" }))
      .status,
    404,
  );
  assert.equal(
    (await call("/friends/requests", 5, "POST", { username: "@user_5" }))
      .status,
    400,
  );
  const r = await call("/friends/requests", 5, "POST", { username: "@User_6" });
  assert.deepEqual(r.body, { status: "pending" });
  assert.equal((await call("/lists/6", 5)).status, 404);
  assert.deepEqual(
    (await call("/friends", 6)).body.incoming.map((x: any) => x.id),
    ["5"],
  );
  assert.deepEqual(
    (await call("/friends", 5)).body.outgoing.map((x: any) => x.id),
    ["6"],
  );
  // The requester cannot accept on the other person's behalf.
  assert.equal((await call("/friends/6/accept", 5, "POST")).status, 404);
  assert.equal((await call("/friends/5/accept", 6, "POST")).status, 200);
  assert.equal((await call("/lists/6", 5)).status, 200);
  assert.equal((await call("/lists/5", 6)).status, 200);
  assert.equal(
    (await call("/friends/requests", 5, "POST", { username: "user_6" })).status,
    409,
  );
  // Unfriending removes access both ways.
  assert.equal((await call("/friends/5", 6, "DELETE")).status, 200);
  assert.equal((await call("/lists/6", 5)).status, 404);
  // A counter-request accepts the pending one.
  await call("/friends/requests", 5, "POST", { username: "user_6" });
  assert.deepEqual(
    (await call("/friends/requests", 6, "POST", { username: "user_5" })).body,
    { status: "accepted" },
  );
});
test("friend invite links: preview, confirm, revoke", async () => {
  const inv = await call("/friend-invites", 7, "POST");
  assert.equal(inv.status, 200);
  const raw = new URL(inv.body.telegram_url).searchParams
    .get("startapp")!
    .slice(2);
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    (await call("/friend-invites/preview", 7, "POST", { token: raw })).status,
    400,
  );
  const preview = await call("/friend-invites/preview", 8, "POST", {
    token: raw,
  });
  assert.equal(preview.body.owner.id, "7");
  assert.equal(preview.body.already_friends, false);
  assert.equal((await call("/lists/7", 8)).status, 404);
  assert.equal(
    (await call("/friend-invites/accept", 8, "POST", { token: raw })).status,
    200,
  );
  assert.equal((await call("/lists/7", 8)).status, 200);
  assert.equal(
    (await call(`/friend-invites/${inv.body.id}`, 7, "DELETE")).status,
    200,
  );
  assert.equal(
    (await call("/friend-invites/accept", 9, "POST", { token: raw })).status,
    404,
  );
});
test("removed friend loses list access and can cancel their own reservation", async () => {
  const g = await gift();
  assert.equal((await call(`/gifts/${g}/reservation`, 3, "POST")).status, 200);
  assert.equal((await call("/friends/3", 1, "DELETE")).status, 200);
  assert.equal((await call("/lists/1", 3)).status, 404);
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 3, "DELETE")).status,
    200,
  );
  assert.equal((await call(`/gifts/${g}/reservation`, 3, "POST")).status, 404);
});
test("price ranges are validated and stored", async () => {
  const id = await gift(2, {
    price_minor: 600000,
    price_max_minor: 4000000,
    price_range: true,
  });
  const from = await gift(2, { price_minor: 100000, price_range: true });
  const listed = (await call("/lists/2", 2)).body.gifts;
  const r = listed.find((v: any) => v.id === id),
    f = listed.find((v: any) => v.id === from);
  assert.equal(r.price_max_minor, 4000000);
  assert.equal(r.price_range, 1);
  assert.equal(f.price_max_minor, null);
  assert.equal(f.price_range, 1);
  for (const overrides of [
    { price_minor: 500, price_max_minor: 100, price_range: true },
    { price_minor: 500, price_max_minor: 900 },
    { price_minor: 500, price_max_minor: 1.5, price_range: true },
  ])
    assert.equal(
      (await call("/gifts", 2, "POST", { ...input, ...overrides })).status,
      400,
    );
});
test("input validation blocks unsafe URLs, invalid price, priority, oversized photos and non-JSON", async () => {
  for (const overrides of [
    { shop_url: "javascript:alert(1)" },
    { photo: "data:image/svg+xml;base64,xxx" },
    { photo: "x".repeat(220001) },
    { price_minor: -1 },
    { price_minor: 1.5 },
    { currency: "XXX" },
    { priority: 9 },
    { title: "" },
  ])
    assert.equal(
      (await call("/gifts", 1, "POST", { ...input, ...overrides })).status,
      400,
    );
  assert.equal(
    (
      await call("/gifts", 1, "POST", input, undefined, {
        "Content-Type": "text/plain",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await call("/gifts", 1, "POST", {
        ...input,
        description: "x".repeat(250000),
      })
    ).status,
    413,
  );
});
test("outbound fetches refuse internal and non-HTTPS addresses", async () => {
  for (const url of [
    "http://example.com/item",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://localhost/",
    "https://printer.local/",
    "https://intranet/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://evil.workers.dev/",
    "file:///etc/passwd",
  ]) {
    const r = await call("/fetch/product", 1, "POST", { url });
    assert.ok([400].includes(r.status), `${url} → ${r.status}`);
    assert.equal((await call("/fetch/image", 1, "POST", { url })).status, 400);
  }
  assert.equal(
    (
      await call("/fetch/sheet", 1, "POST", {
        url: "https://example.com/spreadsheets/d/abc",
      })
    ).status,
    400,
  );
});
test("private responses are never cached and CORS is restricted", async () => {
  const r = await call("/me", 1);
  assert.equal(r.headers.get("Cache-Control"), "no-store, private");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(r.body.user.username, "user_1");
  assert.equal(
    (
      await call("/me", 1, "GET", undefined, undefined, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const preflight = await call("/me", undefined, "OPTIONS");
  assert.equal(preflight.status, 204);
});
test("friend request guessing and link creation have per-user rate limits", async () => {
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await call("/friends/requests", 9, "POST", { username: `missing_${i}` }))
        .status,
      404,
    );
  assert.equal(
    (await call("/friends/requests", 9, "POST", { username: "missing_x" }))
      .status,
    429,
  );
  for (let i = 0; i < 5; i++)
    assert.equal((await call("/guest-links", 8, "POST")).status, 200);
  assert.equal((await call("/guest-links", 8, "POST")).status, 429);
});
// Website sign-in: nonce from our API, id_token "from Telegram" (test key).
const session = (t: string) => ({ Authorization: `Session ${t}` });
async function nonceFor(ip = "192.0.2.1") {
  const r = await call("/auth/nonce", undefined, "POST", undefined, undefined, {
    "CF-Connecting-IP": ip,
  });
  assert.equal(r.status, 200, r.raw);
  return r.body.nonce as string;
}
async function webLogin(
  id: number,
  claims: Record<string, unknown> = {},
  ip = "192.0.2.1",
) {
  const nonce = await nonceFor(ip);
  return call(
    "/auth/telegram-oidc",
    undefined,
    "POST",
    {
      id_token: idToken(oidcKey, {
        nonce,
        id,
        name: `User ${id}`,
        preferred_username: `user_${id}`,
        ...claims,
      }),
    },
    undefined,
    { "CF-Connecting-IP": ip },
  );
}
const me = (t: string) =>
  call("/me", undefined, "GET", undefined, undefined, session(t));
test("website sign-in: Telegram id_token issues a revocable session for the same account", async () => {
  const login = await webLogin(1);
  assert.equal(login.status, 200, login.raw);
  const t = login.body.token;
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  const stored = await db
    .prepare("SELECT token_hash FROM sessions WHERE user_id='1'")
    .all();
  assert.ok(stored.results.length >= 1);
  assert.ok(!stored.results.some((r: any) => r.token_hash === t));
  const profile = await me(t);
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body.user, {
    id: "1",
    name: "User 1",
    username: "user_1",
  });
  assert.equal(profile.body.web_session, true);
  assert.equal((await call("/me", 1)).body.web_session, false);
  // Same account as in the Mini App: friends' lists, own gifts, reservations.
  assert.equal(
    (await call("/lists/2", undefined, "GET", undefined, undefined, session(t)))
      .status,
    200,
  );
  const g = await gift(2);
  assert.equal(
    (
      await call(
        `/gifts/${g}/reservation`,
        undefined,
        "POST",
        undefined,
        undefined,
        session(t),
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/lists/2", 1)).body.gifts.find((v: any) => v.id === g)
      .reservation,
    "mine",
  );
  // Logout revokes only this session.
  const other = (await webLogin(1)).body.token;
  assert.equal(
    (await call("/auth/logout", undefined, "POST", {}, undefined, session(t)))
      .status,
    200,
  );
  assert.equal((await me(t)).status, 401);
  assert.equal((await me(other)).status, 200);
  // Logout everywhere, also possible from the Mini App.
  assert.equal((await call("/auth/logout-all", 1, "POST", {})).status, 200);
  assert.equal((await me(other)).status, 401);
});
test("website sign-in: nonces are stored hashed, single-use and expire", async () => {
  const nonce = await nonceFor();
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM login_nonces WHERE nonce_hash=?")
        .bind(nonce)
        .first()
    )?.n,
    0,
  );
  const token = idToken(oidcKey, {
    nonce,
    id: 5,
    name: "User 5",
    preferred_username: "user_5",
  });
  assert.equal(
    (await call("/auth/telegram-oidc", undefined, "POST", { id_token: token }))
      .status,
    200,
  );
  // The same id_token (and nonce) cannot be used twice.
  assert.equal(
    (await call("/auth/telegram-oidc", undefined, "POST", { id_token: token }))
      .status,
    401,
  );
  // A nonce we never issued, or one that has expired, is refused.
  assert.equal(
    (
      await call("/auth/telegram-oidc", undefined, "POST", {
        id_token: idToken(oidcKey, { nonce: "z".repeat(43), id: 5 }),
      })
    ).status,
    401,
  );
  const old = await nonceFor();
  await db.prepare("UPDATE login_nonces SET expires_at=1").run();
  assert.equal(
    (
      await call("/auth/telegram-oidc", undefined, "POST", {
        id_token: idToken(oidcKey, { nonce: old, id: 5 }),
      })
    ).status,
    401,
  );
});
test("website sign-in rejects forged tokens, Mini App data and expired sessions", async () => {
  const stranger = makeKey("RS256", "oidc-1");
  for (const bad of [
    { id_token: idToken(stranger, { nonce: await nonceFor(), id: 5 }) },
    {
      id_token: idToken(oidcKey, {
        nonce: await nonceFor(),
        id: 5,
        aud: "999",
      }),
    },
    {
      id_token: idToken(oidcKey, { nonce: await nonceFor(), id: undefined }),
    },
    { id_token: signed(5) }, // Mini App initData is not an id_token
    { id_token: "" },
    {},
  ])
    assert.equal(
      (await call("/auth/telegram-oidc", undefined, "POST", bad)).status,
      401,
      JSON.stringify(bad).slice(0, 60),
    );
  const t = (await webLogin(5)).body.token;
  await db.prepare("UPDATE sessions SET expires_at=1 WHERE user_id='5'").run();
  const expired = await me(t);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, "SESSION_EXPIRED");
  for (const bad of [
    "Session short",
    "Session " + "x".repeat(43),
    "Bearer abc",
  ])
    assert.equal(
      (
        await call("/me", undefined, "GET", undefined, undefined, {
          Authorization: bad,
        })
      ).status,
      401,
    );
  // The legacy widget endpoint is gone.
  assert.equal(
    (await call("/auth/telegram-login", undefined, "POST", {})).status,
    401,
  );
});
test("website sign-in keeps at most 10 sessions per account and limits attempts", async () => {
  const tokens: string[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await webLogin(4, {}, `198.51.100.${i}`);
    assert.equal(r.status, 200, r.raw);
    tokens.push(r.body.token);
  }
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id='4'")
        .first()
    )?.n,
    10,
  );
  assert.equal((await me(tokens[10])).status, 200);
  assert.equal((await me(tokens[0])).status, 401);
  const ip = { "CF-Connecting-IP": "203.0.113.9" };
  for (let i = 0; i < 10; i++)
    await call(
      "/auth/telegram-oidc",
      undefined,
      "POST",
      { id_token: "x" },
      undefined,
      ip,
    );
  assert.equal(
    (
      await call(
        "/auth/telegram-oidc",
        undefined,
        "POST",
        { id_token: "x" },
        undefined,
        ip,
      )
    ).status,
    429,
  );
  const nonceIp = { "CF-Connecting-IP": "203.0.113.10" };
  for (let i = 0; i < 30; i++)
    await call("/auth/nonce", undefined, "POST", undefined, undefined, nonceIp);
  assert.equal(
    (
      await call(
        "/auth/nonce",
        undefined,
        "POST",
        undefined,
        undefined,
        nonceIp,
      )
    ).status,
    429,
  );
});
