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
// A tiny JPEG: what Telegram serves for profile photos.
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1,
  0, 0, 0xff, 0xd9,
]);
// User 7103 has no photo the bot can see, but signs in with a photo_url on t.me.
fetchMock
  .get("https://t.me")
  .intercept({ path: "/i/userpic/320/u7103.jpg" })
  .reply(200, JPEG, { headers: { "content-type": "image/jpeg" } })
  .persist();
// Telegram Bot API: a local server records every call; chat 403403 has blocked the bot.
type TelegramCall = { method: string; body: any };
const telegram: TelegramCall[] = [];
const telegramServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    // Profile photo files: only user 7101's photo exists.
    if (String(req.url).startsWith("/file/")) {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(JPEG);
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    const method = String(req.url).split("/").pop()!;
    if (method === "getUserProfilePhotos" || method === "getFile") {
      telegram.push({ method, body });
      const has = body.user_id === 7101;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result:
            method === "getFile"
              ? { file_path: "photos/file_7101.jpg" }
              : {
                  total_count: has ? 1 : 0,
                  photos: has
                    ? [
                        [
                          { file_id: "small", file_size: 900, width: 160 },
                          { file_id: "big", file_size: 900_000, width: 640 },
                        ],
                      ]
                    : [],
                },
        }),
      );
      return;
    }
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
/** Two people who follow each other with approval: what former friends became. */
async function befriend(x: number, y: number) {
  for (const id of [x, y]) await call("/me", id);
  for (const [a, b] of [
    [x, y],
    [y, x],
  ])
    await db
      .prepare(
        "INSERT OR REPLACE INTO follows(follower_id,target_id,status,approved_at) VALUES(?,?,'approved',unixepoch())",
      )
      .bind(String(a), String(b))
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
/**
 * YYYY-MM-DD n days from today as the worker counts days: from the calendar
 * date where it runs (shared/events.ts dayOf). That is UTC on Cloudflare and
 * in CI, but the computer's time zone under Miniflare, so a UTC date would be
 * a day behind after midnight in Moscow.
 */
const isoIn = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + n))
    .toISOString()
    .slice(0, 10);
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
  await migrate("migrations/0013_event_page.sql");
  await migrate("migrations/0014_profile_photo.sql");
  // A friend request still waiting when followers replace friends.
  await db.batch([
    db.prepare(
      "INSERT INTO users(id,name) VALUES('999201','Asker'),('999202','Asked')",
    ),
    db.prepare(
      "INSERT INTO friendships(user_a,user_b,status,requested_by) VALUES('999201','999202','pending','999202')",
    ),
  ]);
  await migrate("migrations/0015_identities.sql");
  await migrate("migrations/0016_login_handoff.sql");
  await migrate("migrations/0017_welcome.sql");
  await migrate("migrations/0018_followers.sql");
  await migrate("migrations/0019_open_profile_follows.sql");
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
test("former family members, then friends, follow each other; profiles stay closed", async () => {
  const p = (await call("/people", 1)).body;
  assert.deepEqual(
    p.friends.map((x: any) => [x.id, x.follows_you]),
    [
      ["2", true],
      ["3", true],
    ],
  );
  assert.equal(p.added_me.length, 0);
  assert.equal(p.friends[0].username, "user_2");
  assert.equal((await call("/people", 4)).body.friends.length, 0);
  assert.equal((await call("/me", 1)).body.user.is_private, true);
  // A waiting friend request became a request to follow from its sender.
  const pending = await db
    .prepare(
      "SELECT follower_id,target_id,status FROM follows WHERE '999201' IN (follower_id,target_id)",
    )
    .all();
  assert.deepEqual(pending.results, [
    { follower_id: "999202", target_id: "999201", status: "pending" },
  ]);
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
    (await call("/people", 4, "GET", undefined, raw)).body.friends.length,
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
test("a closed profile shows its card, and its list after the owner approves; one way only", async () => {
  await call("/me", 6);
  // Anyone with the link sees the card, signed in or not; never the list.
  const anon = await call("/profiles/6");
  assert.equal(anon.status, 200);
  assert.equal(anon.body.card.name, "User 6");
  assert.equal(anon.body.card.username, "user_6");
  assert.equal(anon.body.card.is_private, true);
  assert.equal(anon.body.card.gift_count, 0);
  assert.equal(anon.body.card.follower_count, undefined);
  assert.equal(anon.body.can_view, false);
  assert.equal(anon.body.card.about, undefined);
  assert.equal(anon.body.card.birthday, undefined);
  assert.equal((await call("/lists/6")).status, 404);
  assert.equal((await call("/lists/6", 5)).status, 404);
  assert.equal((await call("/follows/5", 5, "POST")).status, 400);
  assert.equal((await call("/follows/999999999", 5, "POST")).status, 404);
  // A request: still no list.
  assert.deepEqual((await call("/follows/6", 5, "POST")).body, {
    follow: "pending",
  });
  assert.equal((await call("/profiles/6", 5)).body.card.follow, "pending");
  assert.equal((await call("/lists/6", 5)).status, 404);
  assert.deepEqual(
    (await call("/people", 6)).body.requests.map((x: any) => x.id),
    ["5"],
  );
  assert.deepEqual(
    (await call("/people", 5)).body.outgoing.map((x: any) => x.id),
    ["6"],
  );
  // The requester cannot approve themself.
  assert.equal((await call("/followers/6/approve", 5, "POST")).status, 404);
  assert.equal((await call("/followers/5/approve", 6, "POST")).status, 200);
  assert.equal((await call("/lists/6", 5)).status, 200);
  assert.equal((await call("/profiles/6", 5)).body.can_view, true);
  assert.deepEqual(
    (await call("/people", 6)).body.added_me.map((x: any) => x.id),
    ["5"],
  );
  // Approving 5 does not open 5's closed list to 6.
  assert.equal((await call("/lists/5", 6)).status, 404);
  assert.equal((await call("/profiles/5", 6)).body.card.follows_you, true);
  // Removing a follower closes the list again.
  assert.equal((await call("/followers/5", 6, "DELETE")).status, 200);
  assert.equal((await call("/lists/6", 5)).status, 404);
  // Declining a request works the same way; unfollowing cancels one.
  await call("/follows/6", 5, "POST");
  assert.equal((await call("/follows/6", 5, "DELETE")).status, 200);
  assert.equal((await call("/people", 6)).body.requests.length, 0);
});
test("an open profile is seen by everyone and followed at once; opening approves waiting requests", async () => {
  await call("/me", 8);
  await call("/follows/7", 8, "POST");
  assert.equal((await call("/lists/7", 9)).status, 404);
  const g = await gift(7, { title: "Открытый подарок" });
  const opened = await call("/me", 7, "PATCH", { is_private: false });
  assert.equal(opened.body.user.is_private, false);
  assert.equal((await call("/profiles/8", 7)).body.card.follows_you, true);
  // Without signing in: the list with free and booked gifts, no booking.
  const anon = await call("/lists/7");
  assert.equal(anon.status, 200);
  assert.equal(anon.body.can_reserve, false);
  assert.equal(anon.body.gifts[0].reservation, "available");
  // Signed in, a stranger books without following, and others see it as taken.
  assert.equal((await call(`/gifts/${g}/reservation`, 9, "POST")).status, 200);
  assert.equal((await call("/lists/7")).body.gifts[0].reservation, "reserved");
  assert.deepEqual((await call("/follows/7", 9, "POST")).body, {
    follow: "approved",
  });
  assert.deepEqual(
    (await call("/people", 7)).body.added_me.map((x: any) => x.id),
    ["8", "9"],
  );
  // Closing again keeps approved followers and hides the list from others.
  await call("/me", 7, "PATCH", { is_private: true });
  assert.equal((await call("/lists/7")).status, 404);
  assert.equal((await call("/lists/7", 9)).status, 200);
  assert.equal(
    (await call("/me", 7, "PATCH", { is_private: "yes" })).status,
    400,
  );
});
test("a request left waiting when a profile became open counts as a follow", async () => {
  for (const id of [9501, 9502, 9503]) await call("/me", id);
  await call("/follows/9501", 9502, "POST");
  await call("/follows/9501", 9503, "POST");
  // Opened without the usual approval of waiting requests (an older version, a direct change).
  await db.prepare("UPDATE users SET is_private=0 WHERE id='9501'").run();
  const card = (await call("/profiles/9501", 9502)).body.card;
  assert.equal(card.follow, "approved");
  // Pressing «Добавить в друзья» again finishes it, and so does opening «Друзья».
  assert.deepEqual((await call("/follows/9501", 9502, "POST")).body, {
    follow: "approved",
  });
  const people = (await call("/people", 9503)).body;
  assert.equal(people.outgoing.length, 0);
  assert.deepEqual(
    people.friends.map((p: any) => p.id),
    ["9501"],
  );
  assert.deepEqual(
    (await call("/people", 9501)).body.added_me.map((p: any) => p.id).sort(),
    ["9502", "9503"],
  );
});
test("friends: approve and add back, add back who added me, remove with or without my list", async () => {
  for (const id of [9601, 9602, 9603, 9604]) await call("/me", id);
  // 9602 asks 9601 (closed); approving with add_back makes them friends both ways.
  await call("/follows/9601", 9602, "POST");
  assert.equal(
    (await call("/followers/9602/approve", 9601, "POST", { add_back: true }))
      .status,
    200,
  );
  assert.equal((await call("/lists/9602", 9601)).status, 200);
  assert.equal((await call("/lists/9601", 9602)).status, 200);
  let p = (await call("/people", 9601)).body;
  assert.deepEqual(
    p.friends.map((x: any) => [x.id, x.follows_you]),
    [["9602", true]],
  );
  assert.equal(p.requests.length, 0);
  assert.equal(
    (await call("/followers/9602/approve", 9601, "POST", { add_back: true }))
      .status,
    404,
  );
  // 9603 is open; 9604 adds it, and 9603 sees 9604 only under «Добавили вас».
  await call("/me", 9603, "PATCH", { is_private: false });
  await call("/follows/9603", 9604, "POST");
  p = (await call("/people", 9603)).body;
  assert.equal(p.friends.length, 0);
  assert.deepEqual(
    p.added_me.map((x: any) => x.id),
    ["9604"],
  );
  // Adding back someone who added me needs no approval, though 9604 is closed.
  assert.deepEqual((await call("/follows/9604", 9603, "POST")).body, {
    follow: "approved",
  });
  assert.equal((await call("/lists/9604", 9603)).status, 200);
  assert.equal((await call("/people", 9603)).body.added_me.length, 0);
  // A closed stranger still gets a request.
  assert.deepEqual((await call("/follows/9601", 9604, "POST")).body, {
    follow: "pending",
  });
  // Adding someone who asked me approves their request too.
  assert.deepEqual((await call("/follows/9604", 9601, "POST")).body, {
    follow: "approved",
  });
  assert.equal((await call("/lists/9601", 9604)).status, 200);
  // Removing from friends keeps my list open to them, unless asked otherwise.
  await call("/follows/9602", 9601, "DELETE");
  assert.equal((await call("/lists/9601", 9602)).status, 200);
  assert.deepEqual(
    (await call("/people", 9601)).body.added_me.map((x: any) => x.id),
    ["9602"],
  );
  await call("/follows/9604?revoke=1", 9601, "DELETE");
  assert.equal((await call("/lists/9601", 9604)).status, 404);
  assert.equal((await call("/lists/9604", 9601)).status, 404);
  p = (await call("/people", 9601)).body;
  assert.deepEqual(
    p.added_me.map((x: any) => x.id),
    ["9602"],
  );
});
test("old «Поделиться» and friend invitation links only lead to the profile", async () => {
  await call("/me", 9101);
  const share = "s".repeat(43),
    invite = "f".repeat(43),
    guestRaw = (await call("/guest-links", 9101, "POST")).body.token;
  const hashOf = async (v: string) =>
    Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    ).toString("hex");
  await db.batch([
    db
      .prepare(
        "INSERT INTO guest_links(id,owner_id,created_by,token_hash,expires_at,kind,token_value) VALUES('old-share','9101','9101',?,253402300799,'telegram',?)",
      )
      .bind(await hashOf(share), share),
    db
      .prepare(
        "INSERT INTO friend_invites(id,owner_id,token_hash,expires_at) VALUES('old-invite','9101',?,?)",
      )
      .bind(await hashOf(invite), Math.floor(Date.now() / 1000) + 86400),
  ]);
  for (const token of [share, invite])
    assert.deepEqual(
      (await call("/links/resolve", undefined, "POST", { token })).body,
      { owner_id: "9101" },
    );
  assert.equal(
    (await call("/links/resolve", 9102, "POST", { token: guestRaw })).status,
    404,
  );
  // The old Telegram link no longer opens the closed list.
  assert.equal((await call("/guest", 9102, "GET", undefined, share)).status, 404);
  assert.equal(
    (await call("/lists/9101", 9102, "GET", undefined, share)).status,
    404,
  );
  // «Поделиться» now gives the profile link and the guest link only.
  const links = (await call("/guest-links", 9101)).body;
  assert.equal(
    links.profile_url,
    "https://t.me/FilimonovFamilyWishes_bot?startapp=p_9101",
  );
  assert.deepEqual(
    links.links.map((l: any) => l.kind),
    ["guest"],
  );
});
test("the first-visit welcome shows once, until it is saved or skipped", async () => {
  assert.equal((await call("/me", 9201)).body.welcome, true);
  assert.equal(
    (await call("/me", 9201, "PATCH", { welcomed: false })).status,
    400,
  );
  const saved = await call("/me", 9201, "PATCH", {
    birthday: "03-14",
    gender: "female",
    welcomed: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.user.birthday, "03-14");
  assert.equal((await call("/me", 9201)).body.welcome, false);
  // Skipping without data also counts.
  await call("/me", 9202);
  assert.equal((await call("/me", 9202, "PATCH", { welcomed: true })).status, 200);
  assert.equal((await call("/me", 9202)).body.welcome, false);
});
test("a removed follower loses list access and can cancel their own reservation", async () => {
  const g = await gift();
  assert.equal((await call(`/gifts/${g}/reservation`, 3, "POST")).status, 200);
  assert.equal((await call("/followers/3", 1, "DELETE")).status, 200);
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
test("following guessed profiles and link creation have per-user rate limits", async () => {
  // Limits count per calendar minute: start well inside one, or the counter
  // may reset halfway through and the 429 never comes.
  const second = Math.floor(Date.now() / 1000) % 60;
  if (second > 50)
    await new Promise((r) => setTimeout(r, (61 - second) * 1000));
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await call(`/follows/${880000 + i}`, 9301, "POST")).status,
      404,
    );
  assert.equal((await call("/follows/880099", 9301, "POST")).status, 429);
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
    is_private,
    gender: _gender,
    events: _events,
    photo_at,
    ...identity
  } = profile.body.user;
  assert.equal(photo_at, null);
  assert.equal(birthday, null);
  assert.equal(about, null);
  assert.equal(allow_resharing, 1);
  assert.equal(is_private, true);
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

test("«Поделиться» returns the same links again and a stranger can request to follow by the profile", async () => {
  await call("/me", 21);
  const shared = await call("/guest-links", 21, "POST");
  const again = await call("/guest-links", 21);
  assert.deepEqual(again.body.links, shared.body.links);
  assert.equal(again.body.profile_url, shared.body.profile_url);
  assert.deepEqual((await call("/follows/21", 22, "POST")).body, {
    follow: "pending",
  });
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

test("guest links made by viewers before followers no longer open the list; only the owner's do", async () => {
  const g = await gift(48);
  const original = (await call("/guest-links", 48, "POST")).body.token;
  await call("/me", 49);
  const delegated = "d".repeat(43);
  const digest = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(delegated)),
  ).toString("hex");
  await db
    .prepare(
      "INSERT INTO guest_links(id,owner_id,created_by,token_hash,expires_at,kind,token_value) VALUES('delegated','48','49',?,253402300799,'guest',?)",
    )
    .bind(digest, delegated)
    .run();
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, delegated)).status,
    404,
  );
  assert.equal(
    (await call(`/gifts/${g}/photo`, undefined, "GET", undefined, delegated))
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        `/guest-reservations/${g}`,
        undefined,
        "POST",
        { name: "Гость" },
        delegated,
      )
    ).status,
    409,
  );
  // Viewers can no longer make links for someone else's list.
  assert.equal(
    (await call("/lists/48/share-links", 49, "POST", undefined, original))
      .status,
    404,
  );
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, original)).status,
    200,
  );
});
test("friends with the bell on hear about added and removed wishes; bookers learn their gift is gone", async () => {
  await befriend(701, 702);
  await befriend(701, 703);
  await call("/me", 704);
  assert.equal((await call("/subscriptions/701", 704, "PUT")).status, 403);
  const sub = await call("/subscriptions/701", 702, "PUT");
  assert.equal(sub.status, 200);
  assert.equal(sub.body.subscribed, true);
  assert.equal(
    (await call("/people", 702)).body.friends.find((f: any) => f.id === "701")
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
  // Unfollowing turns the bell off too.
  await call("/follows/701", 702, "DELETE");
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

test("friend requests, approvals and new friends of an open profile are announced in the bot", async () => {
  for (const id of [711, 712, 713]) await call("/me", id);
  await call("/follows/712", 711, "POST");
  const request = (await messages(712))[0];
  assert.match(request.text, /User 711.*хочет добавить вас в друзья/);
  assert.equal(
    request.reply_markup.inline_keyboard[0][0].callback_data,
    "fa:711",
  );
  await call("/followers/711/approve", 712, "POST");
  assert.match(
    (await messages(711))[0].text,
    /User 712.*принимает вас в друзья\. Теперь вам виден вишлист/,
  );
  // An open profile has nothing to approve: its owner just hears about it.
  await call("/me", 713, "PATCH", { is_private: false });
  await call("/follows/713", 711, "POST");
  const added = (await messages(713))[0];
  assert.match(added.text, /User 711.*добавляет вас в друзья/);
  assert.equal(
    added.reply_markup.inline_keyboard[0][0].callback_data,
    "fb:711",
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

test("group gifts: the organizer buys alone, everyone else leaves and is told", async () => {
  await befriend(961, 962);
  await befriend(961, 963);
  await befriend(962, 963);
  await befriend(962, 964);
  const g = await gift(961, { title: "Велосипед" });
  await call(`/gifts/${g}/reservation`, 962, "POST", {
    friends: ["963", "964"],
  });
  await call(`/gifts/${g}/reservation/join`, 963, "POST");
  // Only the organizer can call the shared gift off.
  assert.equal(
    (await call(`/gifts/${g}/reservation/members`, 963, "DELETE")).status,
    403,
  );
  const r = await call(`/gifts/${g}/reservation/members`, 962, "DELETE");
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.removed, 2);
  // The joined friend and the one who has not answered yet both hear about it.
  assert.match(
    (await messages(963, 2))[1].text,
    /купит «Велосипед» сам\(а\): совместный подарок отменён/,
  );
  assert.match((await messages(964, 2))[1].text, /купит «Велосипед» сам\(а\)/);
  assert.equal((await call("/reservations", 963)).body.reservations.length, 0);
  assert.equal((await call("/reservations", 964)).body.reservations.length, 0);
  // The booking itself stays with the organizer, now without members.
  const own = (await call("/reservations", 962)).body.reservations[0];
  assert.equal(own.role, "organizer");
  assert.deepEqual(own.members, []);
  assert.equal(
    (await call("/lists/961", 963)).body.gifts.find((x: any) => x.id === g)
      .reservation,
    "reserved",
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
  // Approving a friend request from the bot adds the person back.
  await call("/me", 732);
  await replied(731, () => call("/follows/731", 732, "POST"));
  await press("fa:732");
  const people = (await call("/people", 731)).body;
  assert.deepEqual(
    people.friends.map((f: any) => [f.id, f.follows_you]),
    [["732", true]],
  );
  assert.equal(people.requests.length, 0);
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

test("birthday reminders reach friends with the bell on a week and a day before, once, with a wishlist link", async () => {
  await befriend(751, 752);
  await befriend(753, 752);
  await befriend(751, 755);
  await call("/me", 754);
  // 752 turned the bell on about 751; 755 follows 751 without it.
  assert.equal((await call("/subscriptions/751", 752, "PUT")).status, 200);
  await call("/me", 751, "PATCH", { birthday: isoIn(7).slice(5) });
  await call("/me", 753, "PATCH", { birthday: isoIn(3).slice(5) });
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
  // A follower without the bell, a stranger, and the person themself: nothing.
  for (const id of [754, 755])
    assert.equal(
      (await messages(id, 0)).filter((m) => m.text.includes("день рождения"))
        .length,
      0,
    );
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
  const today = isoIn(0);
  const year = Number(today.slice(0, 4));
  const date =
    today === `${year}-01-01` ? `${year}-01-01` : `${year + 1}-01-01`;
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

test("event page: owner edits guests and the description, cancels the party, the event stays", async () => {
  for (const id of [842, 843, 844]) await befriend(841, id);
  await call("/me", 841, "PATCH", { birthday: isoIn(9).slice(5) });
  const date = isoIn(9);
  // The owner opens the page before inviting anyone.
  const empty = await call(`/events/841/birthday/${date}`, 841);
  assert.equal(empty.status, 200, empty.raw);
  assert.equal(empty.body.event.title, "День рождения");
  assert.deepEqual(empty.body.guests, []);
  assert.equal(empty.body.is_owner, true);
  const party = (v: object) =>
    call("/events/party", 841, "PUT", { key: "birthday", date, ...v });
  assert.equal(
    (await party({ description: "Кафе «Ромашка», 19:00" })).status,
    200,
  );
  await party({ friends: ["842", "843"] });
  assert.equal((await messages(842)).length, 1);
  // Edit: add 844, drop 843. Only 844 gets a message; the description stays.
  await party({ friends: ["842", "844"] });
  assert.equal((await messages(844)).length, 1);
  await settle();
  assert.equal((await messages(842, 0)).length, 1);
  const page = await call(`/events/841/birthday/${date}`, 842);
  assert.equal(page.status, 200);
  assert.equal(page.body.description, "Кафе «Ромашка», 19:00");
  assert.deepEqual(
    page.body.guests.map((g: any) => g.id),
    ["842", "844"],
  );
  assert.equal(page.body.is_owner, false);
  // Not invited (any more): the page shows the event only — no guests, no text.
  const outside = await call(`/events/841/birthday/${date}`, 843);
  assert.equal(outside.status, 200);
  assert.equal(outside.body.invited, false);
  assert.deepEqual(outside.body.guests, []);
  assert.equal(outside.body.description, "");
  // Someone who cannot see the wishlist gets nothing.
  await call("/me", 849);
  assert.equal((await call(`/events/841/birthday/${date}`, 849)).status, 404);
  // «Передумал справлять»: guests are told, the event and its text remain.
  const cancelled = await call("/events/cancel", 841, "POST", {
    key: "birthday",
    date,
  });
  assert.equal(cancelled.status, 200);
  assert.match(
    (await messages(842, 2))[1].text,
    /отменил\(а\) праздник «День рождения»/,
  );
  assert.equal(
    (await call(`/events/841/birthday/${date}`, 842)).body.invited,
    false,
  );
  const after = await call(`/events/841/birthday/${date}`, 841);
  assert.deepEqual(after.body.guests, []);
  assert.equal(after.body.description, "Кафе «Ромашка», 19:00");
  assert.ok(
    (await call("/lists/841", 842)).body.owner.events.some(
      (e: any) => e.key === "birthday",
    ),
  );
  // A moved birthday drops that party; saving the same one keeps it.
  await party({ friends: ["842"] });
  await call("/me", 841, "PATCH", { birthday: isoIn(9).slice(5) });
  assert.equal(
    (await call(`/events/841/birthday/${date}`, 842)).body.invited,
    true,
  );
  await call("/me", 841, "PATCH", { birthday: isoIn(10).slice(5) });
  assert.equal((await call(`/events/841/birthday/${date}`, 842)).status, 404);
});
test("«праздник для всех» opens guests' lists to each other even without friendship", async () => {
  // 851 hosts; 852 and 853 are friends of 851 but not of each other.
  await befriend(851, 852);
  await befriend(851, 853);
  await call("/me", 854);
  await call("/events/custom", 851, "PUT", { title: "Пикник", date: isoIn(6) });
  const g = await gift(852, { title: "Термос" });
  // 854 (a guest from a link of 852) and 851 (the host) book; 853 cannot see yet.
  assert.equal((await call("/lists/852", 853)).status, 404);
  const set = (mode: string, friends = ["852", "853"]) =>
    call("/events/party", 851, "PUT", {
      key: "custom",
      date: isoIn(6),
      mode,
      friends,
    });
  await set("hero");
  assert.equal((await call("/lists/852", 853)).status, 404);
  await set("everyone");
  const seen = await call("/lists/852", 853);
  assert.equal(seen.status, 200, seen.raw);
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 851, "POST")).status,
    200,
  );
  assert.deepEqual(
    (await call("/lists/852", 853)).body.gifts.find((x: any) => x.id === g)
      .booked_by,
    ["User 851"],
  );
  // 853 can book in 852's list too and sees it in «Мои брони».
  const other = await gift(852, { title: "Плед" });
  assert.equal(
    (await call(`/gifts/${other}/reservation`, 853, "POST")).status,
    200,
  );
  const mine = (await call("/reservations", 853)).body.reservations.find(
    (r: any) => r.gift_id === other,
  );
  assert.equal(mine.title, "Плед");
  // The list owner still sees no names; strangers outside the party see nothing.
  assert.ok(!(await call("/lists/852", 852)).raw.includes("User 851"));
  assert.equal((await call("/lists/852", 854)).status, 404);
  // Cancelling the party closes the lists again; the booking can still be cancelled.
  await call("/events/cancel", 851, "POST", { key: "custom", date: isoIn(6) });
  assert.equal((await call("/lists/852", 853)).status, 404);
  assert.equal(
    (await call(`/gifts/${other}/reservation`, 853, "DELETE")).status,
    200,
  );
});

test("people who are not friends are invited by username and see the event, the list and their bookings' event", async () => {
  await call("/me", 861);
  await call("/me", 862);
  await call("/me", 863);
  await call("/events/custom", 861, "PUT", {
    title: "Свадьба",
    date: isoIn(15),
  });
  const g = await gift(861, { title: "Сервиз" });
  const party = (v: object) =>
    call("/events/party", 861, "PUT", {
      key: "custom",
      date: isoIn(15),
      ...v,
    });
  // A user ID of a stranger is ignored; an unknown username is an error.
  await party({ friends: ["863"] });
  assert.equal((await call("/lists/861", 863)).status, 404);
  const unknown = await party({ usernames: ["@nobody_here_42"] });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error.message, /@nobody_here_42/);
  assert.equal((await party({ usernames: ["not a nick"] })).status, 400);
  // By username: invited, told by the bot, the list opens.
  const ok = await party({ usernames: ["@User_862"] });
  assert.equal(ok.status, 200, ok.raw);
  assert.deepEqual(
    ok.body.invitations[0].guests.map((x: any) => x.id),
    ["862"],
  );
  assert.match(
    (await messages(862))[0].reply_markup.inline_keyboard[0][0].web_app.url,
    /open=e_861_custom_/,
  );
  assert.equal((await call("/lists/861", 862)).status, 200);
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 862, "POST")).status,
    200,
  );
  // Saving the list again with the guest's ID keeps them (no friendship needed).
  await party({ friends: ["862"], mode: "hero" });
  assert.equal(
    (await call("/events", 861)).body.mine.find(
      (e: any) => e.event.key === "custom",
    ).guests,
    1,
  );
  // «Мероприятия» of the guest and the link from «Мои брони».
  const events = (await call("/events", 862)).body;
  assert.equal(events.invited.length, 1);
  assert.equal(events.invited[0].owner.id, "861");
  assert.equal(events.invited[0].event.title, "Свадьба");
  const booking = (await call("/reservations", 862)).body.reservations[0];
  assert.deepEqual(booking.my_events, [{ key: "custom", date: isoIn(15) }]);
  // Removed from the party: the list closes again.
  await party({ friends: [] });
  assert.equal((await call("/lists/861", 862)).status, 404);
});

// ---- Profile photos ----
const WEBP = `data:image/webp;base64,${Buffer.from("RIFF\x10\0\0\0WEBPVP8 ").toString("base64")}`;
async function storedPhoto(id: number, wait = false) {
  for (let i = 0; i < (wait ? 50 : 1); i++) {
    const row = await db
      .prepare("SELECT photo,photo_checked FROM users WHERE id=?")
      .bind(String(id))
      .first<{ photo: string; photo_checked: number }>();
    if (!wait || row?.photo) return row;
    await new Promise((r) => setTimeout(r, 40));
  }
  return db
    .prepare("SELECT photo,photo_checked FROM users WHERE id=?")
    .bind(String(id))
    .first<{ photo: string; photo_checked: number }>();
}
test("profile photo: own upload is checked and shown on the public card", async () => {
  const up = await call("/me/photo", 7001, "PUT", { photo: WEBP });
  assert.equal(up.status, 200, up.raw);
  assert.equal(typeof up.body.user.photo_at, "number");
  assert.equal(
    (await call("/me", 7001)).body.user.photo_at,
    up.body.user.photo_at,
  );
  assert.equal((await call("/users/7001/photo", 7001)).body.photo, WEBP);
  // Part of the card of even a closed profile: friends, strangers and visitors see it.
  await befriend(7001, 7002);
  assert.equal((await call("/users/7001/photo", 7002)).body.photo, WEBP);
  const friends = (await call("/people", 7002)).body.friends;
  assert.equal(
    friends.find((u: any) => u.id === "7001").photo_at,
    up.body.user.photo_at,
  );
  assert.equal((await call("/users/7001/photo", 7003)).body.photo, WEBP);
  assert.equal((await call("/users/7001/photo")).body.photo, WEBP);
  assert.equal(
    (await call("/profiles/7001")).body.card.photo_at,
    up.body.user.photo_at,
  );
  // No photo yet: 404, and photo_at stays empty.
  assert.equal((await call("/users/7002/photo", 7001)).status, 404);
  assert.equal(
    friends.find((u: any) => u.id === "7001") &&
      (await call("/me", 7002)).body.user.photo_at,
    null,
  );
  for (const photo of [
    WEBP.replace("image/webp", "image/png"), // declared type does not match the bytes
    "https://example.com/me.jpg",
    `data:image/webp;base64,${"A".repeat(120_001)}`,
    "data:image/svg+xml;base64,PHN2Zz4=",
    "",
    42,
  ])
    assert.equal(
      (await call("/me/photo", 7001, "PUT", { photo })).status,
      400,
      String(photo).slice(0, 40),
    );
  assert.equal((await call("/users/7001/photo", 7001)).body.photo, WEBP);
});
test("profile photo from Telegram: taken on the first sign-in only, later only on request", async () => {
  // First sign-in: the bot sees the photo, it is saved after the answer.
  assert.equal((await call("/me", 7101)).status, 200);
  const first = await storedPhoto(7101, true);
  assert.equal(
    first?.photo,
    `data:image/jpeg;base64,${JPEG.toString("base64")}`,
  );
  assert.equal(first?.photo_checked, 1);
  assert.ok(
    telegram.some((c) => c.method === "getFile" && c.body.file_id === "small"),
    "the smallest size that fits is downloaded",
  );
  // An own photo is never replaced by later sign-ins.
  assert.equal(
    (await call("/me/photo", 7101, "PUT", { photo: WEBP })).status,
    200,
  );
  await call("/me", 7101);
  await settle();
  assert.equal((await storedPhoto(7101))?.photo, WEBP);
  // «Взять из Telegram» brings it back on request.
  assert.deepEqual((await call("/me/photo/telegram", 7101)).body, {
    available: true,
  });
  const again = await call("/me/photo/telegram", 7101, "POST");
  assert.equal(again.status, 200, again.raw);
  assert.equal(
    (await storedPhoto(7101))?.photo.startsWith("data:image/jpeg"),
    true,
  );
  // Hidden or missing photo: nothing is set, the menu says so, the button explains.
  await call("/me", 7102);
  await settle();
  assert.deepEqual(await storedPhoto(7102), { photo: "", photo_checked: 1 });
  assert.deepEqual((await call("/me/photo/telegram", 7102)).body, {
    available: false,
  });
  const none = await call("/me/photo/telegram", 7102, "POST");
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, "PHOTO_UNAVAILABLE");
});
test("profile photo from Telegram: the signed photo_url is used when the bot cannot see the photo", async () => {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({
      id: 7103,
      first_name: "User 7103",
      photo_url: "https://t.me/i/userpic/320/u7103.jpg",
    }),
  });
  const data = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(BOT).digest();
  p.set("hash", createHmac("sha256", key).update(data).digest("hex"));
  const me = await call("/me", undefined, "GET", undefined, undefined, {
    Authorization: `tma ${p.toString()}`,
  });
  assert.equal(me.status, 200, me.raw);
  assert.equal(
    (await storedPhoto(7103, true))?.photo,
    `data:image/jpeg;base64,${JPEG.toString("base64")}`,
  );
  // Links outside Telegram are not even kept from the sign-in data.
  const identity = await validateInitData(
    (() => {
      const q = new URLSearchParams({
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({
          id: 7104,
          first_name: "User 7104",
          photo_url: "https://evil.example/x.jpg",
        }),
      });
      const d = [...q.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      q.set("hash", createHmac("sha256", key).update(d).digest("hex"));
      return q.toString();
    })(),
    BOT,
  );
  assert.equal(identity.photo_url, undefined);
});

// ---- Sign-in methods (identities) ----
const tma = (id: number, username: string | null = `user_${id}`) => ({
  Authorization: `tma ${signed(id, {}, username)}`,
});
const asTelegram = (
  path: string,
  id: number,
  method = "GET",
  value?: unknown,
  username: string | null = `user_${id}`,
) => call(path, undefined, method, value, undefined, tma(id, username));
const countUsers = async () =>
  (await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!
    .n;
const botSecret = createHash("sha256").update(`webhook:${BOT}`).digest("hex");
const botHook = (update: unknown) =>
  call("/telegram/webhook", undefined, "POST", update, undefined, {
    "X-Telegram-Bot-Api-Secret-Token": botSecret,
    Origin: "",
  });
test("identities: the migration gives every Telegram account its sign-in, and new sign-ins get one", async () => {
  const legacy = await db
    .prepare(
      "SELECT user_id,username,name FROM identities WHERE provider='telegram' AND subject='999100'",
    )
    .first();
  assert.deepEqual(legacy, {
    user_id: "999100",
    username: null,
    name: "Migration fixture",
  });
  await call("/me", 7300);
  // Every account with a Telegram ID has exactly its own Telegram sign-in.
  const missing = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u WHERE u.id NOT GLOB '*[^0-9]*' AND NOT EXISTS(
        SELECT 1 FROM identities i WHERE i.provider='telegram' AND i.subject=u.id AND i.user_id=u.id)`,
    )
    .first<{ n: number }>();
  assert.equal(missing?.n, 0);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT username FROM identities WHERE provider='telegram' AND subject='7300'",
        )
        .first<{ username: string }>()
    )?.username,
    "user_7300",
  );
});
test("identities: an account whose sign-in row is missing gets it back and is never duplicated", async () => {
  await befriend(7301, 7300);
  await gift(7301);
  await db
    .prepare(
      "DELETE FROM identities WHERE provider='telegram' AND subject='7301'",
    )
    .run();
  const before = await countUsers();
  const me = await call("/me", 7301);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, "7301");
  assert.equal(await countUsers(), before);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT user_id FROM identities WHERE provider='telegram' AND subject='7301'",
        )
        .first<{ user_id: string }>()
    )?.user_id,
    "7301",
  );
  // Gifts and friends are still there.
  assert.equal((await call("/lists/7301", 7301)).body.gifts.length, 1);
  assert.equal((await call("/lists/7301", 7300)).status, 200);
});
test("identities: a Telegram sign-in linked to another account works in the app, the bot and notifications", async () => {
  // Future case: the account was created another way (a_<uuid>) and Telegram 7302 was linked to it.
  const account = "a_7302aaaa-0000-4000-8000-000000007302";
  await db.batch([
    db
      .prepare("INSERT INTO users(id,name) VALUES(?,'Linked person')")
      .bind(account),
    db
      .prepare(
        "INSERT INTO identities(provider,subject,user_id) VALUES('telegram','7302',?)",
      )
      .bind(account),
  ]);
  const before = await countUsers();
  const me = await asTelegram("/me", 7302);
  assert.equal(me.status, 200, me.raw);
  assert.equal(me.body.user.id, account);
  assert.equal(me.body.user.username, "user_7302");
  assert.equal(
    await countUsers(),
    before,
    "no account with the Telegram ID is created",
  );
  // Own gifts belong to the account.
  const g = await asTelegram("/gifts", 7302, "POST", input);
  assert.equal(g.status, 200, g.raw);
  assert.equal(
    (
      await db
        .prepare("SELECT owner_id FROM gifts WHERE id=?")
        .bind(g.body.id)
        .first()
    )?.owner_id,
    account,
  );
  // A request to follow the a_ account; the notification goes to its Telegram chat.
  await call("/me", 7303);
  const req = await call(`/follows/${account}`, 7303, "POST");
  assert.equal(req.status, 200, req.raw);
  const note = (await messages(7302)).at(-1);
  assert.match(note.text, /User 7303/);
  assert.deepEqual(
    note.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data),
    ["fa:7303", "fd:7303"],
  );
  assert.ok(!telegram.some((c) => c.body.chat_id === account));
  // «Одобрить» in the chat works for the linked account.
  const sent = (await messages(7302)).length;
  await botHook({
    callback_query: {
      id: "q",
      from: { id: 7302, first_name: "Linked" },
      data: "fa:7303",
      message: { message_id: 9, chat: { id: 7302, type: "private" } },
    },
  });
  await messages(7302, sent + 1);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT status FROM follows WHERE follower_id='7303' AND target_id=?",
        )
        .bind(account)
        .first()
    )?.status,
    "approved",
  );
  // The new follower sees the list and the photo through the a_ account ID.
  const list = await call(`/lists/${account}`, 7303);
  assert.equal(list.status, 200, list.raw);
  assert.equal(list.body.gifts.length, 1);
  const webp = `data:image/webp;base64,${Buffer.from("RIFF\x10\0\0\0WEBPVP8 ").toString("base64")}`;
  assert.equal(
    (await asTelegram("/me/photo", 7302, "PUT", { photo: webp })).status,
    200,
  );
  assert.equal((await call(`/users/${account}/photo`, 7303)).body.photo, webp);
  // The bot finds the same account and answers in the Telegram chat.
  const replies = (await messages(7302)).length;
  await botHook({
    message: {
      message_id: 1,
      from: { id: 7302, first_name: "Linked", username: "user_7302" },
      chat: { id: 7302, type: "private" },
      text: "/start",
    },
  });
  await messages(7302, replies + 1);
  assert.equal(await countUsers(), before + 1, "only 7303 was added");
  assert.ok(
    (
      await db
        .prepare("SELECT bot_chat_at FROM users WHERE id=?")
        .bind(account)
        .first()
    )?.bot_chat_at,
  );
});
test("identities: a person without Telegram gets no messages and nothing breaks", async () => {
  const account = "a_7304bbbb-0000-4000-8000-000000007304";
  await db
    .prepare("INSERT INTO users(id,name) VALUES(?,'No Telegram')")
    .bind(account)
    .run();
  await call("/me", 7305);
  const calls = telegram.length;
  const r = await call(`/follows/${account}`, 7305, "POST");
  assert.equal(r.status, 200, r.raw);
  await settle();
  assert.ok(
    telegram.slice(calls).every((c) => c.method !== "sendMessage"),
    "nothing is sent for an account without Telegram",
  );
  // Invalid account IDs match no route.
  for (const bad of [
    "a_1",
    "7305x",
    "a_7304BBBB-0000-4000-8000-000000007304",
  ])
    assert.equal(
      (await call(`/follows/${bad}`, 7305, "POST")).status,
      404,
      bad,
    );
});
test("identities: a Telegram nickname moves to its newest owner in sign-ins and in the copy", async () => {
  await asTelegram("/me", 7306, "GET", undefined, "moving_nick");
  await asTelegram("/me", 7307, "GET", undefined, "moving_nick");
  const rows = (
    await db
      .prepare(
        "SELECT subject,username FROM identities WHERE provider='telegram' AND subject IN ('7306','7307') ORDER BY subject",
      )
      .all()
  ).results;
  assert.deepEqual(rows, [
    { subject: "7306", username: null },
    { subject: "7307", username: "moving_nick" },
  ]);
  assert.equal(
    (await db.prepare("SELECT username FROM users WHERE id='7306'").first())
      ?.username,
    null,
  );
  // The public card shows the nickname of its newest owner only.
  assert.equal(
    (await call("/profiles/7307", 7308)).body.card.username,
    "moving_nick",
  );
  assert.equal((await call("/profiles/7306", 7308)).body.card.username, null);
});

// ---- «В браузере»: one-time sign-in code from the Mini App ----
test("handoff: the Mini App makes a one-time code that signs the website in once", async () => {
  const made = await call("/auth/handoff", 7401, "POST", {});
  assert.equal(made.status, 200, made.raw);
  assert.match(made.body.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.body.expires_in, 120);
  // Only the hash is stored.
  const stored = await db
    .prepare(
      "SELECT code_hash,user_id FROM login_handoffs WHERE user_id='7401'",
    )
    .first<{ code_hash: string; user_id: string }>();
  assert.ok(stored);
  assert.notEqual(stored!.code_hash, made.body.code);
  // The website exchanges it without any other sign-in.
  const redeemed = await call("/auth/handoff/redeem", undefined, "POST", {
    code: made.body.code,
  });
  assert.equal(redeemed.status, 200, redeemed.raw);
  const me = await call("/me", undefined, "GET", undefined, undefined, {
    Authorization: `Session ${redeemed.body.token}`,
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, "7401");
  assert.equal(me.body.web_session, true);
  // Single use.
  const again = await call("/auth/handoff/redeem", undefined, "POST", {
    code: made.body.code,
  });
  assert.equal(again.status, 401);
  assert.equal(again.body.error.code, "HANDOFF_INVALID");
});
test("handoff: expired, made-up and malformed codes fail; only the Mini App can make one", async () => {
  const made = await call("/auth/handoff", 7402, "POST", {});
  await db
    .prepare("UPDATE login_handoffs SET expires_at=1 WHERE user_id='7402'")
    .run();
  for (const code of [made.body.code, "x".repeat(43), "short", "", 42, null])
    assert.equal(
      (
        await call(
          "/auth/handoff/redeem",
          undefined,
          "POST",
          { code },
          undefined,
          {
            "CF-Connecting-IP": "192.0.2.74",
          },
        )
      ).status,
      401,
      String(code),
    );
  // Without signed Telegram data there is nothing to hand off.
  assert.equal(
    (await call("/auth/handoff", undefined, "POST", {})).status,
    401,
  );
  // A website session cannot make a code: «В браузере» exists only in Telegram.
  const fresh = await call("/auth/handoff", 7402, "POST", {});
  const session = (
    await call("/auth/handoff/redeem", undefined, "POST", {
      code: fresh.body.code,
    })
  ).body.token;
  const fromSite = await call(
    "/auth/handoff",
    undefined,
    "POST",
    {},
    undefined,
    {
      Authorization: `Session ${session}`,
    },
  );
  assert.equal(fromSite.status, 400);
});
test("handoff: «Выйти на всех устройствах» also cancels unused «В браузере» codes", async () => {
  const made = await call("/auth/handoff", 7403, "POST", {});
  assert.equal(made.status, 200, made.raw);
  // Someone else's code must survive: only the person's own codes go.
  const other = await call("/auth/handoff", 7404, "POST", {});
  assert.equal((await call("/auth/logout-all", 7403, "POST", {})).status, 200);
  const late = await call(
    "/auth/handoff/redeem",
    undefined,
    "POST",
    { code: made.body.code },
    undefined,
    { "CF-Connecting-IP": "192.0.2.75" },
  );
  assert.equal(late.status, 401);
  assert.equal(late.body.error.code, "HANDOFF_INVALID");
  const fine = await call(
    "/auth/handoff/redeem",
    undefined,
    "POST",
    { code: other.body.code },
    undefined,
    { "CF-Connecting-IP": "192.0.2.75" },
  );
  assert.equal(fine.status, 200, fine.raw);
});

// ---- A shop photo the bot saved as a link becomes the photo itself ----
test("gift photo: the owner swaps a shop photo link for the photo, quietly and only once", async () => {
  await befriend(7701, 7702);
  const link = "https://shop.example/images/1.jpg";
  const photo = "data:image/webp;base64,UklGRg==";
  const g = await gift(7701, { photo: link });
  await db
    .prepare("UPDATE users SET wishlist_updated_at=1 WHERE id='7701'")
    .run();
  // Only the owner.
  assert.equal(
    (await call(`/gifts/${g}/photo`, 7702, "PUT", { photo, from: link }))
      .status,
    404,
  );
  // Only a photo in place of a link.
  for (const bad of [
    { photo: link, from: link },
    { photo: "data:image/svg+xml;base64,xxx", from: link },
    { photo, from: "data:image/png;base64,aGVsbG8=" },
  ])
    assert.equal(
      (await call(`/gifts/${g}/photo`, 7701, "PUT", bad)).status,
      400,
    );
  // The link changed meanwhile: nothing is replaced.
  const stale = await call(`/gifts/${g}/photo`, 7701, "PUT", {
    photo,
    from: "https://shop.example/images/old.jpg",
  });
  assert.equal(stale.body.replaced, false);
  assert.equal((await call(`/gifts/${g}/photo`, 7702)).body.photo, link);
  const done = await call(`/gifts/${g}/photo`, 7701, "PUT", {
    photo,
    from: link,
  });
  assert.equal(done.status, 200, done.raw);
  assert.equal(done.body.replaced, true);
  assert.equal((await call(`/gifts/${g}/photo`, 7702)).body.photo, photo);
  // The same picture: friends do not see «вишлист обновлён».
  assert.equal(
    (await call("/lists/7701", 7702)).body.owner.wishlist_updated_at,
    1,
  );
  assert.equal(
    (await call(`/gifts/${g}/photo`, 7701, "PUT", { photo, from: link })).body
      .replaced,
    false,
  );
});

// ---- Sign-in data: written only when Telegram sends something new ----
test("sign-in: a new name or @username from Telegram is saved, a taken @username moves", async () => {
  const as = (id: number, name: string, username: string) => ({
    Authorization: `tma ${signed(id, {
      user: JSON.stringify({ id, first_name: name, username }),
    })}`,
  });
  const me = async (id: number, name: string, username: string) =>
    (
      await call(
        "/me",
        undefined,
        "GET",
        undefined,
        undefined,
        as(id, name, username),
      )
    ).body.user;
  const stored = async (id: string) =>
    await db
      .prepare(
        "SELECT u.name,u.username,i.username AS sign_in FROM users u JOIN identities i ON i.user_id=u.id AND i.provider='telegram' WHERE u.id=?",
      )
      .bind(id)
      .first();
  assert.equal((await me(7901, "Маша", "masha_7901")).name, "Маша");
  // The same data again: nothing changes.
  assert.equal((await me(7901, "Маша", "masha_7901")).name, "Маша");
  assert.deepEqual(await stored("7901"), {
    name: "Маша",
    username: "masha_7901",
    sign_in: "masha_7901",
  });
  // A new name.
  assert.equal((await me(7901, "Мария", "masha_7901")).name, "Мария");
  assert.equal((await stored("7901"))?.name, "Мария");
  // The @username now belongs to someone else: it moves to them.
  assert.equal((await me(7902, "Петя", "masha_7901")).username, "masha_7901");
  assert.deepEqual(await stored("7901"), {
    name: "Мария",
    username: null,
    sign_in: null,
  });
  // A copy edited by hand gets fixed on the next request.
  await db.prepare("UPDATE users SET name='Старое' WHERE id='7902'").run();
  assert.equal((await me(7902, "Петя", "masha_7901")).name, "Петя");
  assert.equal((await stored("7902"))?.name, "Петя");
});
