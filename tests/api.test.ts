import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import { validateInitData } from "../worker/security";
const BOT = "123456:TEST_ONLY_NOT_A_REAL_TOKEN";
const origin = "https://family.example";
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
function signed(id: number, extra: Record<string, string> = {}) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: `User ${id}` }),
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
  return {
    status: res.status,
    body: raw ? JSON.parse(raw) : null,
    raw,
    headers: res.headers,
  };
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
before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: ".test/worker.mjs",
    compatibilityDate: "2026-07-01",
    d1Databases: { DB: "test" },
    bindings: { BOT_TOKEN: BOT, APP_ORIGIN: origin, APP_URL: `${origin}/app/` },
    log: undefined,
  });
  db = await mf.getD1Database("DB");
  // Run real migration against workerd's D1 SQLite, not an in-memory JS mock.
  const statements: string[] = [];
  let statement = "";
  for (const line of readFileSync("migrations/0001_initial.sql", "utf8").split(
    "\n",
  )) {
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
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal((await call("/me", id)).status, 200);
  const f = await call("/family", 1, "POST", { name: "Семья" });
  assert.equal(f.status, 200);
  for (const id of [2, 3])
    assert.equal(
      (await call("/family/join", id, "POST", { code: f.body.invite_code }))
        .status,
      200,
    );
});
after(async () => {
  await mf?.dispose();
});
test("Telegram: valid HMAC including signature field", async () => {
  assert.equal(
    (
      await validateInitData(
        signed(99, { signature: "example-signature" }),
        BOT,
      )
    ).id,
    "99",
  );
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
});
test("family isolation and gift ownership are enforced", async () => {
  const g = await gift();
  assert.equal((await call("/lists/1", 2)).status, 200);
  assert.equal((await call("/lists/1", 4)).status, 404);
  assert.equal(
    (await call(`/gifts/${g}`, 2, "PUT", { ...input, title: "Hacked" })).status,
    404,
  );
  assert.equal((await call(`/gifts/${g}`, 2, "DELETE")).status, 404);
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
    (await call("/family/members", 4, "GET", undefined, raw)).status,
    404,
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
test("removed member loses list access and can cancel their own reservation", async () => {
  const g = await gift();
  assert.equal((await call(`/gifts/${g}/reservation`, 3, "POST")).status, 200);
  assert.equal((await call("/family/members/3", 1, "DELETE")).status, 200);
  assert.equal((await call("/lists/1", 3)).status, 404);
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 3, "DELETE")).status,
    200,
  );
  assert.equal((await call(`/gifts/${g}/reservation`, 3, "POST")).status, 404);
});
test("only family owner can rotate invites/remove members; creator cannot leave", async () => {
  assert.equal((await call("/family/invite", 2, "POST")).status, 404);
  assert.equal((await call("/family/members/1", 2, "DELETE")).status, 404);
  assert.equal((await call("/family/leave", 1, "POST")).status, 409);
  const old = await call("/family/invite", 1, "POST");
  await call("/family/invite", 1, "POST");
  assert.equal(
    (await call("/family/join", 5, "POST", { code: old.body.invite_code }))
      .status,
    404,
  );
  assert.equal(
    (await call("/family", 2, "POST", { name: "Other" })).status,
    409,
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
test("private responses are never cached and CORS is restricted", async () => {
  const r = await call("/me", 1);
  assert.equal(r.headers.get("Cache-Control"), "no-store, private");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), origin);
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
test("join guessing and link creation have per-user rate limits", async () => {
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await call("/family/join", 7, "POST", { code: "wrong" })).status,
      404,
    );
  assert.equal(
    (await call("/family/join", 7, "POST", { code: "wrong" })).status,
    429,
  );
  for (let i = 0; i < 5; i++)
    assert.equal((await call("/guest-links", 8, "POST")).status, 200);
  assert.equal((await call("/guest-links", 8, "POST")).status, 429);
});
