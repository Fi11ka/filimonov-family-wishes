import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
// Telegram Bot API: a local server records every call; chat 403403 has blocked the bot.
type TelegramCall = { method: string; body: any };
const telegram: TelegramCall[] = [];
const telegramServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    telegram.push({ method: String(req.url).split("/").pop()!, body });
    const blocked = body.chat_id === "403403";
    res.writeHead(blocked ? 403 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        blocked
          ? { ok: false, error_code: 403 }
          : { ok: true, result: { message_id: 1 } },
      ),
    );
  });
});
/** Messages sent to a chat, waiting briefly for ones sent after the HTTP answer. */
async function messages(chat: number, count = 1) {
  for (let i = 0; i < 100; i++) {
    const found = telegram.filter(
      (c) =>
        (c.method === "sendMessage" || c.method === "editMessageText") &&
        c.body.chat_id === String(chat),
    );
    if (found.length >= count) return found.map((c) => c.body);
    await new Promise((r) => setTimeout(r, 20));
  }
  return telegram
    .filter((c) => c.body.chat_id === String(chat))
    .map((c) => c.body);
}
async function befriend(x: number, y: number) {
  for (const id of [x, y]) await call("/me", id);
  const [a, b] = [String(x), String(y)].sort();
  await db
    .prepare(
      "INSERT OR REPLACE INTO friendships(user_a,user_b,status,requested_by,accepted_at) VALUES(?,?,'accepted',?,unixepoch())",
    )
    .bind(a, b, a)
    .run();
}
const settle = () => new Promise((r) => setTimeout(r, 150));
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
  await new Promise<void>((r) => telegramServer.listen(0, "127.0.0.1", r));
  const telegramApi = `http://127.0.0.1:${(telegramServer.address() as AddressInfo).port}`;
  mf = new Miniflare({
    modules: true,
    scriptPath: ".test/worker.mjs",
    compatibilityDate: "2026-07-01",
    d1Databases: { DB: "test" },
    bindings: {
      BOT_TOKEN: BOT,
      APP_ORIGIN: origin,
      APP_URL: `${origin}/app/`,
      TELEGRAM_API: telegramApi,
    },
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
  await migrate("migrations/0005_permanent_sharing.sql");
  await migrate("migrations/0006_home_helper.sql");
  await migrate("migrations/0007_archive_reasons.sql");
  await db.batch([
    db.prepare(
      "INSERT INTO users(id,name) VALUES('999100','Migration fixture')",
    ),
    db.prepare(
      "INSERT INTO gifts(id,owner_id,title,currency,priority,created_at,updated_at,archived_at) VALUES('00000000-0000-4000-8000-000000999100','999100','Existing wish','EUR',2,100,200,150)",
    ),
    db.prepare(
      "INSERT INTO guest_links(id,owner_id,token_hash,expires_at) VALUES('migration-link','999100','migration-hash',253402300799)",
    ),
  ]);
  await migrate("migrations/0008_profile_and_sharing.sql");
  await migrate("migrations/0009_bot_notifications_group_gifts.sql");
  await migrate("migrations/0010_birthday_reminders.sql");
  await migrate("migrations/0011_hearts_and_about.sql");
  await migrate("migrations/0012_events.sql");
  assert.equal(
    (
      await db
        .prepare("SELECT wishlist_updated_at FROM users WHERE id='999100'")
        .first()
    )?.wishlist_updated_at,
    200,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT created_by FROM guest_links WHERE id='migration-link'")
        .first()
    )?.created_by,
    "999100",
  );
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal((await call("/me", id)).status, 200);
});
after(async () => {
  await mf?.dispose();
  telegramServer.close();
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
  assert.ok(ownerView.raw.includes("reservation"));
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
  // Archiving answers the same whether a gift is booked or not.
  const free = await gift();
  const a = await call(`/gifts/${g}/archive`, 1, "POST"),
    b = await call(`/gifts/${free}/archive`, 1, "POST");
  assert.equal(a.status, 200);
  assert.equal(a.raw, b.raw);
  const archive = await call("/archive", 1);
  assert.ok(!archive.raw.includes("reservation"));
  assert.equal((await call(`/gifts/${g}/restore`, 1, "POST")).status, 200);
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
test("guest scope, anonymous booking statuses, authenticated reservation and revocation", async () => {
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
  assert.ok(anonymous.raw.includes("reservation"));
  assert.equal(anonymous.body.can_reserve, true);
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
test("permanent guest links are reused and revocation remains available", async () => {
  const a = await call("/guest-links", 2, "POST"),
    b = await call("/guest-links", 2, "POST");
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, a.body.token)).status,
    200,
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
  const {
    birthday,
    allow_resharing,
    wishlist_updated_at,
    about,
    gender: _gender,
    events: _events,
    ...identity
  } = profile.body.user;
  assert.equal(birthday, null);
  assert.equal(about, null);
  assert.equal(allow_resharing, 1);
  assert.equal(typeof wishlist_updated_at, "number");
  assert.deepEqual(identity, {
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

test("permanent Telegram share requires login and allows friend requests by profile ID", async () => {
  await call("/me", 21);
  const shared = await call("/guest-links", 21, "POST");
  const telegram = shared.body.links.find((l: any) => l.kind === "telegram");
  const raw = telegram.web_url.split("startapp=s_")[1];
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, raw)).status,
    404,
  );
  const view = await call("/guest", 22, "GET", undefined, raw);
  assert.equal(view.status, 200, view.raw);
  assert.equal(view.body.owner.id, "21");
  const g = await gift(21);
  assert.equal(
    (await call(`/gifts/${g}/photo`, undefined, "GET", undefined, raw)).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: "Гость" },
        raw,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call("/friends/requests", 22, "POST", { user_id: "21" })).status,
    200,
  );
  const again = await call("/guest-links", 21);
  assert.deepEqual(again.body.links, shared.body.links);
});

test("guest reservations require names, reveal status only, and share the atomic booking slot", async () => {
  const g = await gift(23);
  const link = (await call("/guest-links", 23, "POST")).body.token;
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: " " },
        link,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: "Бабушка" },
        link,
      )
    ).status,
    200,
  );
  const view = await call("/guest", undefined, "GET", undefined, link);
  assert.equal(
    view.body.gifts.find((x: any) => x.id === g).reservation,
    "reserved",
  );
  assert.ok(!view.raw.includes("Бабушка"));
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: "Другой гость" },
        link,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 24, "POST", undefined, link)).status,
    409,
  );
  const own = await call("/lists/23", 23);
  assert.ok(!own.raw.includes("reservation"));
  assert.ok(!own.raw.includes("Бабушка"));
});

test("guests cancel only with their own code; owners have no view of guest bookings", async () => {
  const g = await gift(25);
  const raw = (await call("/guest-links", 25, "POST")).body.token;
  const booked = await call(
    `/guest-reservations/${g}`,
    undefined,
    "POST",
    { name: "Бабушка" },
    raw,
  );
  assert.equal(booked.status, 200);
  assert.match(booked.body.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call("/guest-bookings", 25)).status, 404);
  assert.ok(!(await call("/lists/25", 25)).raw.includes("Бабушка"));
  const cancel = (code: string) =>
    call(`/guest-reservations/${g}/cancel`, undefined, "POST", { code }, raw);
  assert.equal((await cancel("x".repeat(43))).status, 404);
  assert.equal((await cancel(booked.body.code)).status, 200);
  assert.equal((await cancel(booked.body.code)).status, 404);
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: "Дедушка" },
        raw,
      )
    ).status,
    200,
  );
});

test("guest and Telegram bookings racing for one gift have exactly one winner", async () => {
  const g = await gift(27);
  const link = (await call("/guest-links", 27, "POST")).body.token;
  const results = await Promise.all([
    call(
      `/guest-reservations/${g}`,
      undefined,
      "POST",
      { name: "Бабушка" },
      link,
    ),
    call(`/gifts/${g}/reservation`, 28, "POST", undefined, link),
    call(
      `/guest-reservations/${g}`,
      undefined,
      "POST",
      { name: "Дедушка" },
      link,
    ),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
});

test("subscription changes are allowed by browser CORS preflight", async () => {
  const result = await call(
    "/subscriptions/2",
    undefined,
    "OPTIONS",
    undefined,
    undefined,
    { "Access-Control-Request-Method": "PUT" },
  );
  assert.equal(result.status, 204);
  assert.ok(
    result.headers.get("Access-Control-Allow-Methods")?.includes("PUT"),
  );
});

test("booked gifts can be archived for any reason without revealing the buyer", async () => {
  for (const reason of ["changed_mind", "bought_self", "gifted"]) {
    const booked = await gift(31),
      free = await gift(31);
    const link = (await call("/guest-links", 31, "POST")).body.token;
    await call(`/gifts/${booked}/reservation`, 32, "POST", undefined, link);
    const a = await call(`/gifts/${booked}/archive`, 31, "POST", { reason }),
      b = await call(`/gifts/${free}/archive`, 31, "POST", { reason });
    assert.equal(a.status, 200);
    assert.equal(a.raw, b.raw);
    const archive = await call("/archive", 31);
    assert.equal(
      archive.body.gifts.find((x: any) => x.id === booked).archive_reason,
      reason,
    );
    assert.ok(!archive.raw.includes("User 32"));
    assert.ok(!archive.raw.includes("gifted_by"));
  }
  const g = await gift(31);
  assert.equal(
    (await call(`/gifts/${g}/archive`, 31, "POST", { reason: "unknown" }))
      .status,
    400,
  );
  assert.equal((await call(`/gifts/${g}/archive-status`, 31)).status, 404);
  assert.equal((await call(`/gifts/${g}/archive-donor`, 31)).status, 404);
});

test("home helper endpoints stay hidden until HELPER_TOKEN is configured", async () => {
  const r = await mf.dispatchFetch("https://api.example/api/helper/next", {
    method: "POST",
    headers: {
      Authorization: "Bearer anything",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(r.status, 404);
  await r.text();
});

test("profile birthday and resharing settings are validated and survive Telegram sign-in", async () => {
  await call("/me", 41);
  assert.equal(
    (
      await call("/me", 41, "PATCH", {
        birthday: "02-29",
        allow_resharing: false,
      })
    ).status,
    200,
  );
  let me = (await call("/me", 41)).body.user;
  assert.equal(me.birthday, "02-29");
  assert.equal(me.allow_resharing, 0);
  for (const birthday of ["02-30", "04-31", "2020-01-01", 123])
    assert.equal((await call("/me", 41, "PATCH", { birthday })).status, 400);
  assert.equal(
    (await call("/me", 41, "PATCH", { allow_resharing: "false" })).status,
    400,
  );
  assert.equal(
    (await call("/me", undefined, "PATCH", { birthday: "01-01" })).status,
    401,
  );
  await call("/me", 42, "PATCH", { birthday: "06-12", user_id: "41" });
  assert.equal((await call("/me", 41)).body.user.birthday, "02-29");
  assert.equal(
    (await call("/me", 41, "PATCH", { birthday: null })).body.user.birthday,
    null,
  );
});

test("wishlist freshness changes on all gift mutations but never on bookings or sign-in", async () => {
  const g = await gift(43);
  const raw = (await call("/guest-links", 43, "POST")).body.token;
  async function old() {
    await db
      .prepare("UPDATE users SET wishlist_updated_at=1 WHERE id='43'")
      .run();
  }
  async function updated() {
    assert.ok((await call("/lists/43", 43)).body.owner.wishlist_updated_at > 1);
  }
  await old();
  await call(`/gifts/${g}`, 43, "PUT", { ...input, title: "Изменено" });
  await updated();
  await old();
  await call(`/gifts/${g}/archive`, 43, "POST", { reason: "changed_mind" });
  await updated();
  await old();
  await call(`/gifts/${g}/restore`, 43, "POST");
  await updated();
  await old();
  await call(`/gifts/${g}/reservation`, 44, "POST", undefined, raw);
  assert.equal((await call("/lists/43", 43)).body.owner.wishlist_updated_at, 1);
  await call(`/gifts/${g}/reservation`, 44, "DELETE");
  assert.equal((await call("/me", 43)).body.user.wishlist_updated_at, 1);
  await call("/me", 43, "PATCH", { birthday: "06-12" });
  assert.equal((await call("/me", 43)).body.user.wishlist_updated_at, 1);
  await old();
  await call(`/gifts/${g}`, 43, "DELETE");
  await updated();
  await old();
  await gift(43, { title: "Импортированное", archived: true });
  await updated();
  const guest = await call("/guest", undefined, "GET", undefined, raw);
  assert.equal(guest.body.owner.birthday, "06-12");
  assert.ok(guest.body.owner.wishlist_updated_at > 1);
});

test("viewers share independent links and owner disabling resharing revokes only viewers' links", async () => {
  const g = await gift(45);
  const original = (await call("/guest-links", 45, "POST")).body;
  // Existing access is required; strangers cannot mint links by guessing an owner ID.
  assert.equal((await call("/lists/45/share-links", 46, "POST")).status, 404);
  const shared = await call(
    "/lists/45/share-links",
    46,
    "POST",
    undefined,
    original.token,
  );
  assert.equal(shared.status, 200, shared.raw);
  assert.notEqual(shared.body.token, original.token);
  assert.deepEqual(
    (await call("/lists/45/share-links", 46, "GET", undefined, original.token))
      .body.links,
    shared.body.links,
  );
  assert.deepEqual((await call("/guest-links", 45)).body.links, original.links);
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, shared.body.token))
      .status,
    200,
  );
  const telegram = shared.body.links
    .find((l: any) => l.kind === "telegram")
    .web_url.split("startapp=s_")[1];
  assert.equal(
    (await call("/guest", 47, "GET", undefined, telegram)).status,
    200,
  );
  await call("/me", 45, "PATCH", { allow_resharing: false });
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, shared.body.token))
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        `/gifts/${g}/photo`,
        undefined,
        "GET",
        undefined,
        shared.body.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: "Гость" },
        shared.body.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 47, "POST", undefined, telegram))
      .status,
    404,
  );
  assert.equal(
    (await call("/lists/45/share-links", 46, "POST", undefined, original.token))
      .status,
    403,
  );
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, original.token)).status,
    200,
  );
  assert.equal((await call("/guest-links", 45)).body.links.length, 2);
  await call("/me", 45, "PATCH", { allow_resharing: true });
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, shared.body.token))
      .status,
    404,
  );
  const fresh = await call(
    "/lists/45/share-links",
    46,
    "POST",
    undefined,
    original.token,
  );
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.token, shared.body.token);
  // An unrelated viewer cannot revoke another person's links.
  await call(`/guest-links/${fresh.body.id}`, 47, "DELETE");
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, fresh.body.token))
      .status,
    200,
  );
  await call(`/guest-links/${fresh.body.id}`, 46, "DELETE");
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, fresh.body.token))
      .status,
    404,
  );
});

test("disabled resharing is rechecked on access and booking even for an unrevoked delegated link", async () => {
  const g = await gift(48);
  const original = (await call("/guest-links", 48, "POST")).body.token;
  const delegated = (
    await call("/lists/48/share-links", 49, "POST", undefined, original)
  ).body;
  await call("/me", 48, "PATCH", { allow_resharing: false });
  // Simulate a link left over by an in-flight operation: policy checks must still deny it.
  await db
    .prepare(
      "UPDATE guest_links SET revoked_at=NULL WHERE owner_id='48' AND created_by='49'",
    )
    .run();
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, delegated.token)).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/gifts/${g}/photo`,
        undefined,
        "GET",
        undefined,
        delegated.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: "Гость" },
        delegated.token,
      )
    ).status,
    409,
  );
  const telegram = delegated.links
    .find((l: any) => l.kind === "telegram")
    .web_url.split("startapp=s_")[1];
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 50, "POST", undefined, telegram))
      .status,
    404,
  );
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, original)).status,
    200,
  );
});

test("subscribers of a friend hear about added and removed wishes; bookers learn their gift is gone", async () => {
  await befriend(701, 702);
  await befriend(701, 703);
  await call("/me", 704);
  assert.equal((await call("/subscriptions/701", 704, "PUT")).status, 403);
  const sub = await call("/subscriptions/701", 702, "PUT");
  assert.equal(sub.status, 200);
  assert.equal(sub.body.subscribed, true);
  assert.equal(
    (await call("/friends", 702)).body.friends.find((f: any) => f.id === "701")
      .subscribed,
    true,
  );
  const g = await gift(701, {
    title: "Велосипед",
    price_minor: 1500000,
    currency: "RUB",
  });
  const added = await messages(702);
  assert.match(added[0].text, /добавил\(а\) желание «Велосипед»/);
  assert.equal(
    added[0].reply_markup.inline_keyboard[0][0].web_app.url,
    "https://family.example/app/?open=l_701",
  );
  // Not subscribed: no message. The owner gets nothing either.
  await settle();
  assert.equal((await messages(703, 0)).length, 0);
  assert.equal((await messages(701, 0)).length, 0);
  // A quiet import is announced in one message.
  const quiet = [
    await gift(701, { title: "Книга", quiet: true }),
    await gift(701, { title: "Плед", quiet: true }),
  ];
  await settle();
  assert.equal((await messages(702)).length, 1);
  await call("/gifts/announce", 701, "POST", { ids: quiet });
  assert.match(
    (await messages(702, 2))[1].text,
    /желания \(2\):\n• Плед|желания \(2\):\n• Книга/,
  );
  // 703 books it; the owner deletes it: 703 is told, 702 hears it was removed.
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 703, "POST")).status,
    200,
  );
  const before = await call(`/gifts/${quiet[0]}`, 701, "DELETE");
  const after = await call(`/gifts/${g}`, 701, "DELETE");
  assert.equal(before.raw, after.raw);
  const booker = await messages(703);
  assert.match(
    booker[0].text,
    /удалил\(а\) из вишлиста «Велосипед» — подарок, который вы забронировали/,
  );
  const removed = await messages(702, 4);
  assert.ok(
    removed.some((m) =>
      /убрал\(а\) из вишлиста желание «Велосипед»/.test(m.text),
    ),
  );
  assert.equal((await call("/reservations", 703)).body.reservations.length, 0);
  // Archiving tells the booker too; unfriending ends the subscription.
  const h = await gift(701, { title: "Самокат" });
  await call(`/gifts/${h}/reservation`, 703, "POST");
  await call(`/gifts/${h}/archive`, 701, "POST", { reason: "gifted" });
  assert.match(
    (await messages(703, 2))[1].text,
    /отметил\(а\) «Самокат» как подаренный/,
  );
  await call("/friends/701", 702, "DELETE");
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber_id='702'",
        )
        .first()
    )?.n,
    0,
  );
  assert.equal((await call("/subscriptions/701", 702, "DELETE")).status, 200);
});

test("friend requests, accepted invitations and accepted requests are announced in the bot", async () => {
  for (const id of [711, 712, 713]) await call("/me", id);
  await call("/friends/requests", 711, "POST", { username: "user_712" });
  const request = (await messages(712))[0];
  assert.match(request.text, /User 711.*хочет добавить вас в друзья/);
  assert.equal(
    request.reply_markup.inline_keyboard[0][0].callback_data,
    "fa:711",
  );
  await call("/friends/711/accept", 712, "POST");
  assert.match(
    (await messages(711))[0].text,
    /User 712.*теперь у вас в друзьях/,
  );
  const invite = await call("/friend-invites", 713, "POST");
  const tokenValue = invite.body.telegram_url.split("startapp=f_")[1];
  await call("/friend-invites/accept", 711, "POST", { token: tokenValue });
  assert.match(
    (await messages(713))[0].text,
    /User 711.*теперь у вас в друзьях/,
  );
});

test("group gifts: invite friends, answer from the site or the bot, owner sees nothing", async () => {
  await befriend(721, 722);
  await befriend(721, 723);
  await befriend(722, 723);
  await befriend(722, 724);
  await call("/me", 725);
  const g = await gift(721, { title: "Палатка" });
  const ownerBefore = await call("/lists/721", 721);
  // 725 is not a friend of the organizer and the owner can never be invited: both skipped.
  const r = await call(`/gifts/${g}/reservation`, 722, "POST", {
    friends: ["723", "724", "725", "721"],
  });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.body.invited.sort(), ["723", "724"]);
  const invite = (await messages(723))[0];
  assert.match(
    invite.text,
    /предлагает скинуться на подарок для .*User 721.*«Палатка»/,
  );
  assert.equal(
    invite.reply_markup.inline_keyboard[0][0].callback_data,
    `gj:${g}`,
  );
  assert.equal(
    (await call("/lists/721", 723)).body.gifts.find((x: any) => x.id === g)
      .reservation,
    "invited",
  );
  // 724 cannot see the owner's list but sees the invitation in «Мои брони».
  const invited = (await call("/reservations", 724)).body.reservations[0];
  assert.equal(invited.role, "invited");
  assert.equal(invited.title, "Палатка");
  assert.deepEqual(invited.members, []);
  assert.equal(
    (await call(`/gifts/${g}/reservation/join`, 723, "POST")).status,
    200,
  );
  assert.match((await messages(722))[0].text, /User 723.*участвует/);
  assert.equal(
    (await call("/lists/721", 723)).body.gifts.find((x: any) => x.id === g)
      .reservation,
    "mine",
  );
  const organizer = (await call("/reservations", 722)).body.reservations[0];
  assert.equal(organizer.role, "organizer");
  assert.deepEqual(
    organizer.members.map((m: any) => [m.id, m.status]),
    [
      ["723", "joined"],
      ["724", "invited"],
    ],
  );
  assert.equal(
    (
      await call(`/gifts/${g}/reservation/invite`, 723, "POST", {
        friends: ["724"],
      })
    ).status,
    403,
  );
  // Others still see it simply as booked; the owner's answer is unchanged and nobody tells the owner.
  assert.equal((await call("/lists/721", 723)).status, 200);
  const ownerAfter = await call("/lists/721", 721);
  assert.equal(ownerBefore.raw, ownerAfter.raw);
  await settle();
  assert.equal((await messages(721, 0)).length, 0);
  // 724 declines in the bot.
  const secret = createHash("sha256").update(`webhook:${BOT}`).digest("hex");
  const update = (data: string, from = 724) =>
    call(
      "/telegram/webhook",
      undefined,
      "POST",
      {
        callback_query: {
          id: "q",
          from: { id: from, first_name: `User ${from}` },
          data,
          message: { message_id: 5, chat: { id: from, type: "private" } },
        },
      },
      undefined,
      { "X-Telegram-Bot-Api-Secret-Token": secret, Origin: "" },
    );
  assert.equal((await update(`gd:${g}`)).status, 200);
  assert.match((await messages(722, 2))[1].text, /User 724.*не участвует/);
  assert.equal((await call("/reservations", 724)).body.reservations.length, 0);
  // The organizer cancels: the joined friend is told.
  await call(`/gifts/${g}/reservation`, 722, "DELETE");
  assert.match(
    (await messages(723, 2))[1].text,
    /отменил\(а\) бронь совместного подарка «Палатка»/,
  );
  assert.equal((await call("/reservations", 723)).body.reservations.length, 0);
  assert.equal(
    (await call("/lists/721", 723)).body.gifts.find((x: any) => x.id === g)
      .reservation,
    "available",
  );
});

test("bot webhook: secret required, menu, adding and editing one's own wishes", async () => {
  const secret = createHash("sha256").update(`webhook:${BOT}`).digest("hex");
  const hook = (update: unknown, key = secret) =>
    call("/telegram/webhook", undefined, "POST", update, undefined, {
      "X-Telegram-Bot-Api-Secret-Token": key,
      Origin: "",
    });
  // Updates are handled after the 200 answer: wait for the bot's reply before the next one.
  const replied = async (from: number, send: () => Promise<unknown>) => {
    const count = (await messages(from, 0)).length;
    await send();
    await messages(from, count + 1);
  };
  const text = (t: string, from = 731) =>
    replied(from, () =>
      hook({
        message: {
          message_id: 1,
          from: { id: from, first_name: "Анна", username: "anna_bot_test" },
          chat: { id: from, type: "private" },
          text: t,
        },
      }),
    );
  const press = (data: string, from = 731) =>
    replied(from, () =>
      hook({
        callback_query: {
          id: "q",
          from: { id: from, first_name: "Анна" },
          data,
          message: { message_id: 9, chat: { id: from, type: "private" } },
        },
      }),
    );
  assert.equal((await hook({ message: {} }, "wrong")).status, 401);
  await text("/start");
  const welcome = (await messages(731))[0];
  assert.deepEqual(
    welcome.reply_markup.keyboard.flat().map((b: any) => b.text),
    ["➕ Добавить в вишлист", "📋 Мои желания", "🎁 Открыть вишлист"],
  );
  await text("🎁 Открыть вишлист");
  assert.equal(
    (await messages(731, 2))[1].reply_markup.inline_keyboard[0][0].web_app.url,
    "https://family.example/app/",
  );
  // The user now exists and the bot can reach them.
  assert.equal((await call("/me", 731)).body.notifications.bot_connected, true);
  await text("➕ Добавить в вишлист");
  await text("Настольная игра");
  const card = (await messages(731, 4))[3];
  assert.match(card.text, /Добавлено в вишлист/);
  const row: any = await db
    .prepare("SELECT id,title,priority FROM gifts WHERE owner_id='731'")
    .first();
  assert.equal(row.title, "Настольная игра");
  // Price, then priority, through the buttons.
  await press(`e:price:${row.id}`);
  await text("1000-3000");
  await press(`p:3:${row.id}`);
  const saved: any = await db
    .prepare(
      "SELECT price_minor,price_max_minor,price_range,hearts AS priority FROM gifts WHERE id=?",
    )
    .bind(row.id)
    .first();
  assert.deepEqual(
    { ...saved },
    {
      price_minor: 100000,
      price_max_minor: 300000,
      price_range: 1,
      priority: 3,
    },
  );
  // Somebody else's wish cannot be edited by guessing its ID.
  const other = await gift(1);
  await press(`p:1:${other}`, 731);
  assert.equal(
    (
      await db
        .prepare("SELECT hearts AS priority FROM gifts WHERE id=?")
        .bind(other)
        .first()
    )?.priority,
    3,
  );
  await press(`xx:${row.id}`);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM gifts WHERE owner_id='731'")
        .first()
    )?.n,
    0,
  );
  // Answering a friend request from the bot.
  await call("/me", 732);
  await replied(731, () =>
    call("/friends/requests", 732, "POST", { user_id: "731" }),
  );
  await press("fa:732");
  assert.equal(
    (await call("/friends", 731)).body.friends.some((f: any) => f.id === "732"),
    true,
  );
});

test("notifications can be switched off and a blocked chat is not retried", async () => {
  await befriend(741, 742);
  await befriend(741, 403403);
  await call("/subscriptions/741", 742, "PUT");
  await call("/subscriptions/741", 403403, "PUT");
  assert.equal(
    (await call("/me", 742, "PATCH", { notify: false })).body.notifications
      .enabled,
    false,
  );
  await gift(741);
  await settle();
  assert.equal((await messages(742, 0)).length, 0);
  assert.ok(
    (
      await db
        .prepare("SELECT bot_blocked_at FROM users WHERE id='403403'")
        .first()
    )?.bot_blocked_at,
  );
  const tries = telegram.filter((c) => c.body.chat_id === "403403").length;
  await gift(741);
  await settle();
  assert.equal(
    telegram.filter((c) => c.body.chat_id === "403403").length,
    tries,
  );
});

test("birthday reminders reach friends a week and a day before, once, with a wishlist link", async () => {
  await befriend(751, 752);
  await befriend(753, 752);
  await call("/me", 754);
  const inDays = (n: number) =>
    new Date(Date.now() + n * 86400000).toISOString().slice(5, 10);
  await call("/me", 751, "PATCH", { birthday: inDays(7) });
  await call("/me", 753, "PATCH", { birthday: inDays(3) });
  await gift(751, { title: "Плед" });
  await settle();
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: "17 3 * * *" });
  await worker.scheduled({ cron: "17 3 * * *" });
  const sent = await messages(752);
  await settle();
  const reminders = (await messages(752, 0)).filter((m) =>
    m.text.includes("день рождения"),
  );
  assert.equal(reminders.length, 1, JSON.stringify(sent));
  assert.match(
    reminders[0].text,
    /Через 7 дней.*день рождения у .*User 751.*В вишлисте 1 желание/s,
  );
  assert.equal(
    reminders[0].reply_markup.inline_keyboard[0][0].web_app.url,
    "https://family.example/app/?open=l_751",
  );
  // Not a friend, and the person themself: nothing.
  assert.equal((await messages(754, 0)).length, 0);
  assert.equal(
    (await messages(751, 0)).filter((m) => m.text.includes("день рождения"))
      .length,
    0,
  );
});

test("bot setup sets the webhook, commands and the welcome text shown before Start", async () => {
  const r = await call(
    "/telegram/setup",
    undefined,
    "GET",
    undefined,
    undefined,
    {
      Origin: "",
    },
  );
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.webhook, "https://api.example/api/telegram/webhook");
  const last = (method: string) =>
    telegram.filter((c) => c.method === method).at(-1)!.body;
  assert.equal(
    last("setWebhook").secret_token,
    createHash("sha256").update(`webhook:${BOT}`).digest("hex"),
  );
  const description = last("setMyDescription").description;
  assert.match(description, /Нажмите «Запустить»/);
  assert.ok(description.length <= 512);
  assert.ok(last("setMyShortDescription").short_description.length <= 120);
});

test("priority is 1–5 hearts, kept in sync with the old column; the wishlist has a description", async () => {
  const g = await gift(761, { priority: 5 });
  assert.equal(
    (await call("/lists/761", 761)).body.gifts.find((x: any) => x.id === g)
      .priority,
    5,
  );
  const row: any = await db
    .prepare("SELECT hearts,priority FROM gifts WHERE id=?")
    .bind(g)
    .first();
  assert.deepEqual({ ...row }, { hearts: 5, priority: 3 });
  assert.equal(
    (await call(`/gifts/${g}`, 761, "PUT", { ...input, priority: 1 })).status,
    200,
  );
  assert.equal(
    (await call("/lists/761", 761)).body.gifts.find((x: any) => x.id === g)
      .priority,
    1,
  );
  assert.equal(
    (await call("/gifts", 761, "POST", { ...input, priority: 6 })).status,
    400,
  );
  // The description is shown to friends with the list.
  assert.equal(
    (
      await call("/me", 761, "PATCH", {
        about: "  Люблю книги и всё фиолетовое  ",
      })
    ).body.user.about,
    "Люблю книги и всё фиолетовое",
  );
  await befriend(761, 762);
  assert.equal(
    (await call("/lists/761", 762)).body.owner.about,
    "Люблю книги и всё фиолетовое",
  );
  assert.equal(
    (await call("/me", 761, "PATCH", { about: "x".repeat(501) })).status,
    400,
  );
  assert.equal(
    (await call("/me", 761, "PATCH", { about: "" })).body.user.about,
    null,
  );
});

const isoIn = (n: number) =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
test("events: gender only for oneself, one own event replaces the last, subscribers hear days left", async () => {
  await befriend(801, 802);
  await call("/subscriptions/801", 802, "PUT");
  assert.equal(
    (await call("/me", 801, "PATCH", { gender: "other" })).status,
    400,
  );
  const me = await call("/me", 801, "PATCH", {
    gender: "female",
    birthday: isoIn(20).slice(5),
  });
  assert.equal(me.body.user.gender, "female");
  assert.deepEqual(
    me.body.user.events.map((e: any) => e.key),
    ["birthday", "new_year", "march8"],
  );
  // A friend sees the events (8 March included) but not the gender field.
  const seen = await call("/lists/801", 802);
  assert.equal(seen.body.owner.gender, undefined);
  assert.ok(seen.body.owner.events.some((e: any) => e.key === "march8"));
  for (const bad of [
    { title: "", date: isoIn(5) },
    { title: "Новоселье", date: isoIn(-3) },
    { title: "Новоселье", date: "2026-02-30" },
    { title: "Новоселье", date: isoIn(2000) },
  ])
    assert.equal((await call("/events/custom", 801, "PUT", bad)).status, 400);
  assert.equal(
    (
      await call("/events/custom", 801, "PUT", {
        title: "Новоселье",
        date: isoIn(10),
      })
    ).status,
    200,
  );
  const sent = await messages(802);
  assert.match(
    sent[0].text,
    /добавил\(а\) мероприятие «Новоселье»: .*, осталось 10 дней/,
  );
  await call("/events/custom", 801, "PUT", {
    title: "Юбилей",
    date: isoIn(30),
  });
  const events = (await call("/lists/801", 802)).body.owner.events;
  assert.deepEqual(
    events.filter((e: any) => e.key === "custom"),
    [{ key: "custom", title: "Юбилей", on: isoIn(30) }],
  );
  assert.equal((await call("/events/custom", 801, "DELETE")).status, 200);
  assert.ok(
    !(await call("/lists/801", 802)).body.owner.events.some(
      (e: any) => e.key === "custom",
    ),
  );
  await settle();
  assert.equal((await messages(801, 0)).length, 0);
});
test("event guests see each other and who of them booked; the hero never learns it", async () => {
  // 811 celebrates; 812 and 813 are invited, 814 is a friend who is not.
  for (const id of [812, 813, 814]) await befriend(811, id);
  await call("/events/custom", 811, "PUT", {
    title: "Юбилей",
    date: isoIn(12),
  });
  const [a, b, c, d] = [
    await gift(811, { title: "Книга" }),
    await gift(811, { title: "Плед" }),
    await gift(811, { title: "Ваза" }),
    await gift(811, { title: "Чай" }),
  ];
  // Only an upcoming event of the owner's own, only the owner's friends.
  assert.equal(
    (
      await call("/events/guests", 811, "PUT", {
        key: "custom",
        date: isoIn(13),
        friends: ["812"],
      })
    ).status,
    404,
  );
  const ownerBefore = await call("/lists/811", 811);
  const inv = await call("/events/guests", 811, "PUT", {
    key: "custom",
    date: isoIn(12),
    mode: "hero",
    friends: ["812", "813", "899"],
  });
  assert.equal(inv.status, 200, inv.raw);
  assert.deepEqual(
    inv.body.invitations[0].guests.map((g: any) => g.id),
    ["812", "813"],
  );
  assert.match(
    (await messages(812))[0].text,
    /приглашает вас на «Юбилей»: .*, осталось 12 дней/,
  );
  // Guests see the guest list; a friend who is not invited does not.
  assert.equal((await call("/lists/811", 813)).body.invitations.length, 1);
  assert.equal((await call("/lists/811", 814)).body.invitations.length, 0);
  // 812 (guest) books a; 814 (not a guest) books b; a link guest books c.
  await call(`/gifts/${a}/reservation`, 812, "POST");
  await call(`/gifts/${b}/reservation`, 814, "POST");
  const link = await call("/guest-links", 811, "POST");
  assert.equal(
    (
      await call(
        `/guest-reservations/${c}`,
        undefined,
        "POST",
        { name: "Тётя Галя" },
        link.body.token,
      )
    ).status,
    200,
  );
  const guestView = await call("/lists/811", 813);
  const byId = (id: string) =>
    guestView.body.gifts.find((g: any) => g.id === id);
  assert.deepEqual(byId(a).booked_by, ["User 812"]);
  assert.equal(byId(b).reservation, "reserved");
  assert.equal(byId(b).booked_by, undefined);
  assert.deepEqual(byId(c).booked_by, ["Тётя Галя"]);
  assert.equal(byId(d).booked_by, undefined);
  assert.ok(!guestView.raw.includes("user_814"));
  // A friend outside the event sees plain bookings.
  assert.ok(!(await call("/lists/811", 814)).raw.includes("booked_by"));
  // The owner: same answer as before any booking, no names.
  const ownerAfter = await call("/lists/811", 811);
  assert.deepEqual(
    { ...ownerBefore.body, invitations: null },
    { ...ownerAfter.body, invitations: null },
  );
  assert.ok(!ownerAfter.raw.includes("booked_by"));
  assert.ok(!ownerAfter.raw.includes("reservation"));
  assert.ok(!ownerAfter.raw.includes("Тётя Галя"));
  assert.deepEqual(
    ownerAfter.body.invitations[0].guests.map((g: any) => g.id),
    ["812", "813"],
  );
  // Removing a guest takes the names away from them.
  await call("/events/guests", 811, "PUT", {
    key: "custom",
    date: isoIn(12),
    friends: ["812"],
  });
  assert.ok(!(await call("/lists/811", 813)).raw.includes("booked_by"));
  // A new event of one's own drops the old guest list.
  await call("/events/custom", 811, "PUT", { title: "Ужин", date: isoIn(40) });
  assert.equal((await call("/lists/811", 811)).body.invitations.length, 0);
});
test("«праздник для всех»: guests see names in each other's lists, never in their own", async () => {
  // 821 invites 822 and 823 to New Year; everyone is friends.
  for (const [x, y] of [
    [821, 822],
    [821, 823],
    [822, 823],
  ])
    await befriend(x, y);
  const ny = (await call("/me", 821)).body.user.events.find(
    (e: any) => e.key === "new_year",
  );
  assert.ok(ny);
  const year = new Date().getUTCFullYear();
  const date =
    new Date().toISOString().slice(0, 10) === `${year}-01-01`
      ? `${year}-01-01`
      : `${year + 1}-01-01`;
  const set = (mode: string) =>
    call("/events/guests", 821, "PUT", {
      key: "new_year",
      date,
      mode,
      friends: ["822", "823"],
    });
  assert.equal((await set("hero")).status, 200);
  const g822 = await gift(822, { title: "Шарф" });
  await call(`/gifts/${g822}/reservation`, 823, "POST");
  // Hero mode: only the hero's list shows names.
  assert.ok(!(await call("/lists/822", 821)).raw.includes("booked_by"));
  assert.equal((await set("everyone")).status, 200);
  const hostView = await call("/lists/822", 821);
  assert.deepEqual(
    hostView.body.gifts.find((g: any) => g.id === g822).booked_by,
    ["User 823"],
  );
  // The guest whose list it is still sees nothing.
  const own = await call("/lists/822", 822);
  assert.ok(!own.raw.includes("booked_by"));
  assert.ok(!own.raw.includes("User 823"));
  assert.equal(
    (
      await call("/events/guests", 821, "PUT", {
        key: "new_year",
        date,
        mode: "all",
        friends: [],
      })
    ).status,
    400,
  );
});
test("«Мои брони» carry the owner's events and prices for sharing", async () => {
  await befriend(831, 832);
  await call("/me", 831, "PATCH", { gender: "male" });
  await call("/events/custom", 831, "PUT", {
    title: "Защита диплома",
    date: isoIn(4),
  });
  const g = await gift(831, { price_minor: 900000, currency: "RUB" });
  await call(`/gifts/${g}/reservation`, 832, "POST");
  const r = (await call("/reservations", 832)).body.reservations[0];
  assert.equal(r.price_minor, 900000);
  assert.deepEqual(
    r.owner_events.map((e: any) => e.key),
    ["new_year", "feb23", "custom"],
  );
  assert.equal(r.gender, undefined);
  assert.equal(r.birthday, undefined);
});
