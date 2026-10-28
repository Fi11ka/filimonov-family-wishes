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
  // A booking on an already archived wish: after 0021 it is the giver's record.
  await db.batch([
    db.prepare(
      "INSERT INTO users(id,name) VALUES('fixture-owner','Owner'),('fixture-giver','Giver')",
    ),
    db.prepare(
      "INSERT INTO gifts(id,owner_id,title,currency,priority,archived_at,archive_reason) VALUES('99930000-0000-4000-8000-000000000001','fixture-owner','Плед','RUB',2,unixepoch(),'changed_mind')",
    ),
    db.prepare(
      "INSERT INTO reservations(gift_id,user_id) VALUES('99930000-0000-4000-8000-000000000001','fixture-giver')",
    ),
  ]);
  await migrate("migrations/0020_drop_subscriptions.sql");
  await migrate("migrations/0021_giver_records.sql");
  await migrate("migrations/0022_wishlist_checked.sql");
  await migrate("migrations/0023_managed_lists_guest_sets.sql");
  // A party still ahead, with a guest, and one long past: 0024 moves only the first.
  await db.batch([
    db.prepare(
      "INSERT INTO users(id,name,event_title,event_date) VALUES('fixture-host','Host','Новоселье',date('now','+5 days')),('fixture-guest','Guest',NULL,NULL)",
    ),
    db.prepare(
      "INSERT INTO event_parties(owner_id,event_key,event_on,mode,description) VALUES('fixture-host','custom',date('now','+5 days'),'everyone','У нас дома'),('fixture-host','new_year','2020-01-01','hero',NULL)",
    ),
    db.prepare(
      "INSERT INTO event_guests(owner_id,event_key,event_on,user_id) VALUES('fixture-host','custom',date('now','+5 days'),'fixture-guest')",
    ),
  ]);
  await migrate("migrations/0024_events.sql");
  const moved = await db
    .prepare(
      "SELECT e.title,e.mode,e.place,e.actual_on=e.celebrate_on AS same,(SELECT COUNT(*) FROM event_members m WHERE m.event_id=e.id) AS guests FROM events e WHERE owner_id='fixture-host'",
    )
    .all();
  assert.deepEqual(
    moved.results.map((r) => ({ ...r })),
    [{ title: "Новоселье", mode: "everyone", place: "У нас дома", same: 1, guests: 1 }],
  );
  assert.deepEqual(
    {
      ...(await db
        .prepare(
          "SELECT title,reason FROM giver_records WHERE user_id='fixture-giver'",
        )
        .first()),
    },
    { title: "Плед", reason: "changed_mind" },
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM reservations").first())?.n,
    0,
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
  // The second one hears plainly that someone was quicker.
  const lost = r.find((x) => x.status === 409)!;
  assert.equal(lost.body.error.code, "TAKEN");
  assert.match(lost.body.error.message, /выбрал кто-то другой/);
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
  assert.equal((await call("/lists/6")).status, 401);
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
test("an open profile is seen by everyone signed in and followed at once; opening approves waiting requests", async () => {
  await call("/me", 8);
  await call("/follows/7", 8, "POST");
  assert.equal((await call("/lists/7", 9)).status, 404);
  const g = await gift(7, { title: "Открытый подарок" });
  const opened = await call("/me", 7, "PATCH", { is_private: false });
  assert.equal(opened.body.user.is_private, false);
  assert.equal((await call("/profiles/8", 7)).body.card.follows_you, true);
  // Without signing in: only the card, even of an open profile; no wishes, no photos.
  assert.equal((await call("/lists/7")).status, 401);
  const card = await call("/profiles/7");
  assert.equal(card.body.can_view, false);
  assert.equal(card.body.card.gifts, undefined);
  assert.equal((await call(`/gifts/${g}/photo`)).status, 404);
  // Signed in, a stranger books without following, and others see it as taken.
  assert.equal((await call(`/gifts/${g}/reservation`, 9, "POST")).status, 200);
  assert.equal((await call("/lists/7", 10)).body.gifts[0].reservation, "reserved");
  assert.deepEqual((await call("/follows/7", 9, "POST")).body, {
    follow: "approved",
  });
  assert.deepEqual(
    (await call("/people", 7)).body.added_me.map((x: any) => x.id),
    ["8", "9"],
  );
  // Closing again keeps approved followers and hides the list from others.
  await call("/me", 7, "PATCH", { is_private: true });
  assert.equal((await call("/lists/7", 10)).status, 404);
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
  // A link to the site, not to the Mini App, whichever app it is sent to.
  assert.equal(links.profile_url, "https://family.example/app/?p=9101");
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
    checked_at,
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
  assert.equal(checked_at, null);
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
  // Opening «Поделиться» reads only: no guest link until it is shared.
  assert.deepEqual((await call("/guest-links", 21)).body.links, []);
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
  assert.deepEqual(
    results.filter((r) => r.status === 409).map((r) => r.body.error.code),
    ["TAKEN", "TAKEN"],
  );
  // A dead link is not told whether the gift is taken.
  await call(`/guest-links/${(await call("/guest-links", 27)).body.id}`, 27, "DELETE");
  const dead = await call(
    `/guest-reservations/${g}`,
    undefined,
    "POST",
    { name: "Тётя" },
    link,
  );
  assert.equal(dead.body.error.code, "UNAVAILABLE");
});
test("a cancelled booking can be returned while the gift is free, never twice", async () => {
  const g = await gift(29);
  await call("/me", 30);
  await db
    .prepare(
      "INSERT INTO follows(follower_id,target_id,status,approved_at) VALUES('30','29','approved',unixepoch())",
    )
    .run();
  assert.equal((await call(`/gifts/${g}/reservation`, 30, "POST")).status, 200);
  assert.equal((await call(`/gifts/${g}/reservation`, 30, "DELETE")).status, 200);
  // «Вернуть» is a new booking: two quick taps still leave one.
  const back = await Promise.all([
    call(`/gifts/${g}/reservation`, 30, "POST", {}),
    call(`/gifts/${g}/reservation`, 30, "POST", {}),
  ]);
  assert.deepEqual(back.map((x) => x.status).sort(), [200, 409]);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM reservations WHERE gift_id=?")
        .bind(g)
        .first()
    )?.n,
    1,
  );
});

test("PUT changes are allowed by browser CORS preflight", async () => {
  const result = await call(
    "/events/custom",
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
test("adding or removing wishes tells no friend; bookers learn their gift is gone", async () => {
  await befriend(701, 702);
  await befriend(701, 703);
  // The bell is gone along with its endpoint.
  assert.equal((await call("/subscriptions/701", 702, "PUT")).status, 404);
  assert.equal(
    "subscribed" in
      (await call("/people", 702)).body.friends.find(
        (f: any) => f.id === "701",
      ),
    false,
  );
  // Adding by hand, archived-then-restored, or by import: nobody hears about it.
  const g = await gift(701, {
    title: "Велосипед",
    price_minor: 1500000,
    currency: "RUB",
  });
  const other = await gift(701, { title: "Книга" });
  await call(`/gifts/${other}/archive`, 701, "POST", {
    reason: "changed_mind",
  });
  await call(`/gifts/${other}/restore`, 701, "POST");
  assert.equal(
    (await call("/gifts/announce", 701, "POST", { ids: [g] })).status,
    404,
  );
  await settle();
  for (const id of [701, 702, 703])
    assert.equal((await messages(id, 0)).length, 0);
  // 703 books it; the owner deletes it: only 703 is told, the same answer either way.
  assert.equal(
    (await call(`/gifts/${g}/reservation`, 703, "POST")).status,
    200,
  );
  const before = await call(`/gifts/${other}`, 701, "DELETE");
  const after = await call(`/gifts/${g}`, 701, "DELETE");
  assert.equal(before.raw, after.raw);
  const booker = await messages(703);
  assert.match(
    booker[0].text,
    /удалил\(а\) из вишлиста «Велосипед» — подарок, который вы выбрали/,
  );
  await settle();
  assert.equal((await messages(702, 0)).length, 0);
  assert.equal((await messages(701, 0)).length, 0);
  assert.equal((await call("/reservations", 703)).body.reservations.length, 0);
  // Archiving tells the booker too.
  const h = await gift(701, { title: "Самокат" });
  await call(`/gifts/${h}/reservation`, 703, "POST");
  await call(`/gifts/${h}/archive`, 701, "POST", { reason: "gifted" });
  assert.match(
    (await messages(703, 2))[1].text,
    /отметил\(а\), что получил\(а\) «Самокат»/,
  );
  await settle();
  assert.equal((await messages(702, 0)).length, 0);
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
  assert.equal(
    (await call("/me", 742, "PATCH", { notify: false })).body.notifications
      .enabled,
    false,
  );
  await call("/events", 741, "POST", {
    title: "Новоселье",
    actual_on: isoIn(9),
  });
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
  await call("/events", 741, "POST", {
    title: "Юбилей",
    actual_on: isoIn(9),
  });
  await settle();
  assert.equal(
    telegram.filter((c) => c.body.chat_id === "403403").length,
    tries,
  );
});

test("birthday reminders reach everyone who has the person in «Друзья» a week and a day before, once, with a wishlist link", async () => {
  await befriend(751, 752);
  await befriend(753, 752);
  for (const id of [751, 754, 755, 756, 757]) await call("/me", id);
  // 755 added 751 one-way; 751 added 756, so 751 is only in 756's «Добавили вас»;
  // 757 still waits for approval; 758 took 751 out of friends.
  for (const [from, to, status] of [
    ["755", "751", "approved"],
    ["751", "756", "approved"],
    ["757", "751", "pending"],
  ])
    await db
      .prepare(
        "INSERT INTO follows(follower_id,target_id,status) VALUES(?,?,?)",
      )
      .bind(from, to, status)
      .run();
  await befriend(751, 758);
  await call("/follows/751", 758, "DELETE");
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
  assert.equal(
    (await messages(755, 0)).filter((m) => m.text.includes("день рождения"))
      .length,
    1,
  );
  assert.match(
    reminders[0].text,
    /Через 7 дней.*день рождения у .*User 751.*В вишлисте 1 желание/s,
  );
  assert.equal(
    reminders[0].reply_markup.inline_keyboard[0][0].web_app.url,
    "https://family.example/app/?open=l_751",
  );
  // A stranger, «Добавили вас», a pending request, a removed friend and the person themself: nothing.
  for (const id of [754, 756, 757, 758])
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
test("«Мои брони»: the owner's actions leave the giver a card; only the giver moves it to «Подаренные»", async () => {
  await befriend(7701, 7702);
  await befriend(7701, 7703);
  const book = async (title: string, by = 7702) => {
    const id = await gift(7701, {
      title,
      price_minor: 250000,
      currency: "RUB",
      shop_url: "https://example.com/item",
    });
    assert.equal((await call(`/gifts/${id}/reservation`, by, "POST")).status, 200);
    return id;
  };
  const deleted = await book("Плед");
  const changed = await book("Книга");
  const gifted = await book("Самокат");
  const mine = await book("Лампа");
  const free = await gift(7701, { title: "Свободное" });
  // The owner's answers are the same, booked or not.
  const answers = [
    await call(`/gifts/${deleted}`, 7701, "DELETE"),
    await call(`/gifts/${free}`, 7701, "DELETE"),
  ];
  assert.equal(answers[0].raw, answers[1].raw);
  await call(`/gifts/${changed}/archive`, 7701, "POST", { reason: "changed_mind" });
  await call(`/gifts/${gifted}/archive`, 7701, "POST", { reason: "gifted" });
  let r = (await call("/reservations", 7702)).body;
  assert.deepEqual(
    r.reservations.map((b: any) => b.title),
    ["Лампа"],
  );
  assert.deepEqual(
    r.attention.map((c: any) => [c.title, c.reason]).sort(),
    [
      ["Книга", "changed_mind"],
      ["Плед", "deleted"],
      ["Самокат", "gifted"],
    ],
  );
  // The card keeps what the gift was: price, link, recipient.
  const plaid = r.attention.find((c: any) => c.title === "Плед");
  assert.equal(plaid.price_minor, 250000);
  assert.equal(plaid.shop_url, "https://example.com/item");
  assert.equal(plaid.owner_name, "User 7701");
  // The wish is free again after a restore, with no old booking.
  await call(`/gifts/${changed}/restore`, 7701, "POST");
  assert.equal(
    (await call("/lists/7701", 7703)).body.gifts.find((g: any) => g.id === changed)
      .reservation,
    "available",
  );
  // Deleting it later turns «Передумал» into «Удалил».
  await call(`/gifts/${changed}/archive`, 7701, "POST", { reason: "changed_mind" });
  await call(`/gifts/${changed}`, 7701, "DELETE");
  r = (await call("/reservations", 7702)).body;
  assert.equal(
    r.attention.find((c: any) => c.title === "Книга").reason,
    "deleted",
  );
  // «Удалить у меня» hides only my card, for good.
  assert.equal(
    (await call(`/reservations/${deleted}/hide`, 7702, "POST")).status,
    200,
  );
  // «Это подарил я» only where the owner marked it received.
  assert.equal(
    (await call(`/reservations/${changed}/gifted`, 7702, "POST")).status,
    404,
  );
  assert.equal(
    (await call(`/reservations/${gifted}/gifted`, 7702, "POST")).status,
    200,
  );
  // «Подарено» from an active booking: the wish stays taken for everyone else.
  assert.equal(
    (await call(`/reservations/${mine}/gifted`, 7702, "POST")).status,
    200,
  );
  assert.equal(
    (await call(`/reservations/${mine}/gifted`, 7702, "POST")).status,
    200,
  );
  r = (await call("/reservations", 7702)).body;
  assert.deepEqual(r.reservations, []);
  assert.deepEqual(
    r.attention.map((c: any) => c.title),
    ["Книга"],
  );
  assert.deepEqual(
    r.given.map((c: any) => c.title).sort(),
    ["Лампа", "Самокат"],
  );
  assert.equal(
    (await call("/lists/7701", 7703)).body.gifts.find((g: any) => g.id === mine)
      .reservation,
    "reserved",
  );
  // The photo kept with the record; nobody else can read it.
  assert.equal((await call(`/reservations/${mine}/photo`, 7703)).status, 404);
  // Another person's actions never touch my records.
  assert.equal((await call("/reservations", 7703)).body.attention.length, 0);
});
test("the giver hears when the title, price or link of their gift changes; the owner sees nothing", async () => {
  await befriend(7801, 7802);
  const g = await gift(7801, { title: "Чайник", price_minor: 300000, currency: "RUB" });
  await call(`/gifts/${g}/reservation`, 7802, "POST");
  await settle();
  const before = (await messages(7802, 0)).length;
  const edit = (v: object) =>
    call(`/gifts/${g}`, 7801, "PUT", {
      ...input,
      title: "Чайник",
      price_minor: 300000,
      currency: "RUB",
      ...v,
    });
  // Only the hint changed: no message.
  assert.equal((await edit({ description: "белый" })).status, 200);
  await settle();
  assert.equal((await messages(7802, 0)).length, before);
  await edit({ price_minor: 350000 });
  const sent = await messages(7802, before + 1);
  assert.match(sent[before].text, /изменил\(а\) цену у подарка «Чайник»/);
  let b = (await call("/reservations", 7802)).body.reservations[0];
  assert.equal(b.changed_fields, "price");
  await edit({ title: "Чайник стеклянный", price_minor: 350000 });
  b = (await call("/reservations", 7802)).body.reservations[0];
  assert.equal(b.changed_fields, "price,title");
  assert.equal((await call(`/reservations/${g}/seen`, 7802, "POST")).status, 200);
  b = (await call("/reservations", 7802)).body.reservations[0];
  assert.equal(b.changed_fields, null);
  await settle();
  assert.equal((await messages(7801, 0)).length, 0);
});
test("«Подтвердить актуальность»: only the owner, a date of its own, edits do not extend it, nobody is told", async () => {
  await befriend(7901, 7902);
  const g = await gift(7901, { title: "Плед" });
  // An existing list has no confirmation, whatever its last edit.
  let list = (await call("/lists/7901", 7902)).body.owner;
  assert.equal(list.checked_at, null);
  assert.ok(list.wishlist_updated_at);
  const r = await call("/me/checked", 7901, "POST");
  assert.equal(r.status, 200);
  const at = r.body.checked_at;
  list = (await call("/lists/7901", 7902)).body.owner;
  assert.equal(list.checked_at, at);
  // Editing, archiving and deleting wishes leave it as it was.
  await db.prepare("UPDATE users SET checked_at=100 WHERE id='7901'").run();
  await call(`/gifts/${g}`, 7901, "PUT", { ...input, title: "Плед большой" });
  await gift(7901, { title: "Книга" });
  await call(`/gifts/${g}/archive`, 7901, "POST", { reason: "changed_mind" });
  assert.equal((await call("/lists/7901", 7902)).body.owner.checked_at, 100);
  // A viewer confirms only their own list, never the owner's.
  await call("/me/checked", 7902, "POST");
  assert.equal((await call("/lists/7901", 7902)).body.owner.checked_at, 100);
  // Without access the status is not shown at all: the card has no date.
  await call("/me", 7903);
  assert.equal((await call("/profiles/7901", 7903)).body.card.checked_at, undefined);
  await settle();
  for (const id of [7901, 7902]) assert.equal((await messages(id, 0)).length, 0);
});
test("a wish saved before its photo loaded keeps the stored photo; a removed photo is removed", async () => {
  const g = await gift(7951);
  const photoOf = async () =>
    (await db.prepare("SELECT photo FROM gifts WHERE id=?").bind(g).first())
      ?.photo;
  const stored = await photoOf();
  assert.ok(stored);
  // keep_photo: the form had no photo in hand yet, the photo stays.
  assert.equal(
    (
      await call(`/gifts/${g}`, 7951, "PUT", {
        ...input,
        title: "Новое название",
        photo: "",
        keep_photo: true,
      })
    ).status,
    200,
  );
  assert.equal(await photoOf(), stored);
  // Without it an empty photo means «Удалить фото».
  await call(`/gifts/${g}`, 7951, "PUT", { ...input, photo: "" });
  assert.equal(await photoOf(), "");
});
test("lists kept for someone close: a name is enough, access is the manager's, wishes stay in their list", async () => {
  await befriend(8101, 8102);
  await call("/me", 8103);
  // A name only; an empty one creates nothing.
  assert.equal((await call("/wishlists", 8101, "POST", { name: " " })).status, 400);
  const masha = (await call("/wishlists", 8101, "POST", { name: "Маша" })).body
    .list;
  assert.equal(masha.name, "Маша");
  // A wish for Masha stays in her list; the personal list is untouched.
  const own = await gift(8101, { title: "Моё" });
  const hers = await gift(8101, { title: "Кукла", list_id: masha.id });
  let mine = (await call("/lists/8101", 8101)).body;
  assert.deepEqual(mine.gifts.map((g: any) => g.id), [own]);
  assert.deepEqual(mine.lists, [{ id: masha.id, name: "Маша" }]);
  const list = (await call(`/lists/8101?list=${masha.id}`, 8101)).body;
  assert.deepEqual(list.gifts.map((g: any) => g.id), [hers]);
  assert.equal(list.list.name, "Маша");
  // Nobody adds to a list they do not keep.
  assert.equal(
    (await call("/gifts", 8102, "POST", { ...input, list_id: masha.id })).status,
    404,
  );
  // A friend who sees my list sees Masha's too, including a list made later; and books there.
  const granny = (await call("/wishlists", 8101, "POST", { name: "Бабушка" }))
    .body.list;
  const friend = (await call(`/lists/8101?list=${granny.id}`, 8102)).body;
  assert.equal(friend.list.name, "Бабушка");
  assert.equal(
    (await call(`/gifts/${hers}/reservation`, 8102, "POST")).status,
    200,
  );
  // The giver's booking names Masha, not the manager.
  assert.equal(
    (await call("/reservations", 8102)).body.reservations[0].owner_name,
    "Маша",
  );
  // A stranger sees none of them, and closing access closes them all.
  assert.equal((await call(`/lists/8101?list=${masha.id}`, 8103)).status, 404);
  await call("/followers/8102", 8101, "DELETE");
  await call("/follows/8101", 8102, "DELETE");
  assert.equal((await call(`/lists/8101?list=${masha.id}`, 8102)).status, 404);
  // Archive and «актуальность» are per list.
  await call(`/gifts/${hers}/archive`, 8101, "POST", { reason: "changed_mind" });
  assert.deepEqual(
    (await call(`/archive?list=${masha.id}`, 8101)).body.gifts.map((g: any) => g.id),
    [hers],
  );
  assert.equal((await call("/archive", 8101)).body.gifts.length, 0);
  await call("/me/checked", 8101, "POST", { list_id: masha.id });
  mine = (await call("/lists/8101", 8101)).body;
  assert.equal(mine.owner.checked_at, null);
  assert.ok((await call(`/lists/8101?list=${masha.id}`, 8101)).body.list.checked_at);
  // Someone else's list id is not mine to confirm.
  assert.equal(
    (await call("/me/checked", 8102, "POST", { list_id: masha.id })).status,
    404,
  );
});
test("guest links open one list, whole or a picked set, and nothing else", async () => {
  const masha = (await call("/wishlists", 8201, "POST", { name: "Маша" })).body
    .list;
  const a = await gift(8201, { title: "Моё А" });
  const b = await gift(8201, { title: "Моё Б" });
  const m = await gift(8201, { title: "Машино", list_id: masha.id });
  // Opening «Поделиться» creates nothing.
  assert.equal((await call("/guest-links", 8201)).body.id, undefined);
  const whole = (await call("/guest-links", 8201, "POST", {})).body.token;
  const picked = (
    await call("/guest-links", 8201, "POST", { gift_ids: [a, m] })
  ).body.token;
  const empty = (await call("/guest-links", 8201, "POST", { gift_ids: [] }))
    .body.token;
  const hers = (
    await call("/guest-links", 8201, "POST", { list_id: masha.id })
  ).body.token;
  const seen = async (t: string) =>
    (await call("/guest", undefined, "GET", undefined, t)).body.gifts
      .map((g: any) => g.id)
      .sort();
  assert.deepEqual(await seen(whole), [a, b].sort());
  // A picked set keeps to itself: Masha's wish was not in this list, b was not picked.
  assert.deepEqual(await seen(picked), [a]);
  assert.deepEqual(await seen(empty), []);
  assert.deepEqual(await seen(hers), [m]);
  // A new wish shows on the whole link only.
  const c = await gift(8201, { title: "Новое" });
  assert.ok((await seen(whole)).includes(c));
  assert.ok(!(await seen(picked)).includes(c));
  // Booking and photos outside the set are refused, inside it work.
  assert.equal(
    (
      await call(`/guest-reservations/${b}`, undefined, "POST", { name: "Тётя" }, picked)
    ).status,
    409,
  );
  assert.equal(
    (await call(`/gifts/${b}/photo`, undefined, "GET", undefined, picked)).status,
    404,
  );
  assert.equal(
    (await call(`/gifts/${a}/photo`, undefined, "GET", undefined, picked)).status,
    200,
  );
  assert.equal(
    (
      await call(`/guest-reservations/${a}`, undefined, "POST", { name: "Тётя" }, picked)
    ).status,
    200,
  );
  // Each set is its own link; revoking one leaves the others.
  const links = (await call("/guest-links", 8201)).body.links;
  assert.equal(links.length, 4);
  // Masha's wish never joined the personal set: one wish in it.
  const pickedLink = links.find((l: any) => l.picked && l.count === 1);
  await call(`/guest-links/${pickedLink.id}`, 8201, "DELETE");
  assert.equal(
    (await call("/guest", undefined, "GET", undefined, picked)).status,
    404,
  );
  assert.deepEqual(await seen(hers), [m]);
  // The whole personal list's link is the same one again.
  assert.equal((await call("/guest-links", 8201, "POST", {})).body.token, whole);
});
test("events: many of one's own, two dates, standard occasions only as a list to start from", async () => {
  await befriend(8301, 8302);
  await call("/me", 8301, "PATCH", { birthday: isoIn(20).slice(5), gender: "female" });
  let list = (await call("/events", 8301)).body;
  // The occasions come from the profile and create nothing.
  assert.deepEqual(
    list.occasions.map((o: any) => o.key).sort(),
    ["birthday", "march8", "new_year"],
  );
  assert.equal(list.mine.length, 0);
  // From the birthday: celebrated two days later; the actual date stays.
  const bday = (
    await call("/events", 8301, "POST", {
      base: "birthday",
      actual_on: isoIn(20),
      celebrate_on: isoIn(22),
    })
  ).body.event;
  assert.equal(bday.title, "День рождения");
  assert.equal(bday.actual_on, isoIn(20));
  assert.equal(bday.celebrate_on, isoIn(22));
  // A second meeting for the same occasion with other people does not replace it.
  await call("/events", 8301, "POST", { base: "birthday", actual_on: isoIn(20) });
  await call("/events", 8301, "POST", { title: "Новоселье", actual_on: isoIn(5) });
  list = (await call("/events", 8301)).body;
  assert.equal(list.mine.length, 3);
  assert.deepEqual(list.mine.map((e: any) => e.title)[0], "Новоселье");
  // A custom event needs a title; dates must be real and not long past.
  assert.equal((await call("/events", 8301, "POST", { actual_on: isoIn(5) })).status, 400);
  assert.equal(
    (await call("/events", 8301, "POST", { title: "Х", actual_on: isoIn(-5) })).status,
    400,
  );
  // Moving the celebration changes neither the actual date nor the profile.
  const moved = (
    await call(`/events/${bday.id}`, 8301, "PATCH", { celebrate_on: isoIn(25) })
  ).body.event;
  assert.equal(moved.actual_on, isoIn(20));
  assert.equal((await call("/me", 8301)).body.user.birthday, isoIn(20).slice(5));
  // Only the organizer manages it.
  assert.equal(
    (await call(`/events/${bday.id}`, 8302, "PATCH", { place: "Кафе" })).status,
    404,
  );
});
test("event guests: from the four groups, take part at once, can decline; the set of wishes holds", async () => {
  // 8401 organizes. 8402 is a friend, 8403 added 8401 one way, 8404 waits for approval,
  // 8405 is a stranger. 8406 is a friend not invited.
  for (const id of [8401, 8402, 8403, 8404, 8405, 8406]) await call("/me", id);
  await befriend(8401, 8402);
  await befriend(8401, 8406);
  await db
    .prepare(
      "INSERT INTO follows(follower_id,target_id,status) VALUES('8403','8401','approved'),('8404','8401','pending')",
    )
    .run();
  const a = await gift(8401, { title: "Шарф" });
  const b = await gift(8401, { title: "Книга" });
  const e = (
    await call("/events", 8401, "POST", {
      title: "Юбилей",
      actual_on: isoIn(10),
      wishes: [a],
      guests: ["8402", "8403", "8404", "8405"],
      place: "Кафе «Ромашка»",
    })
  ).body.event;
  const page = (await call(`/events/${e.id}`, 8401)).body;
  // The stranger is not invited; inviting changes no friendship.
  assert.deepEqual(
    page.guests.map((g: any) => g.id).sort(),
    ["8402", "8403", "8404"],
  );
  assert.equal(
    (await db.prepare("SELECT status FROM follows WHERE follower_id='8404'").first())
      ?.status,
    "pending",
  );
  // Invited: a message, no accepting. The friend not invited hears about the event once.
  assert.match((await messages(8403))[0].text, /приглашает вас на «Юбилей»/);
  assert.match((await messages(8406))[0].text, /добавил\(а\) мероприятие «Юбилей»/);
  await settle();
  assert.equal(
    (await messages(8402, 0)).filter((m) => /мероприятие «Юбилей»/.test(m.text) && /добавил/.test(m.text)).length,
    0,
  );
  // A guest sees the place and only the picked wish; nothing else of the closed list.
  const guest = (await call(`/events/${e.id}`, 8403)).body;
  assert.equal(guest.place, "Кафе «Ромашка»");
  assert.deepEqual(guest.wishes.map((w: any) => w.id), [a]);
  // 8404 still waits for approval: the event opens only its wish, not the list.
  assert.deepEqual(
    (await call(`/events/${e.id}`, 8404)).body.wishes.map((w: any) => w.id),
    [a],
  );
  assert.equal((await call("/lists/8401", 8404)).status, 404);
  assert.equal((await call(`/gifts/${b}/reservation`, 8404, "POST")).status, 404);
  assert.equal((await call(`/gifts/${a}/reservation`, 8403, "POST")).status, 200);
  // A new wish appears only when picked explicitly.
  const c = await gift(8401, { title: "Новое" });
  assert.ok(!(await call(`/events/${e.id}`, 8403)).body.wishes.some((w: any) => w.id === c));
  // Declining closes access through the event and keeps the booking; it can be undone.
  assert.equal((await call(`/events/${e.id}/decline`, 8403, "POST")).status, 200);
  assert.equal((await call(`/events/${e.id}`, 8403)).body.wishes.length, 0);
  assert.equal((await call(`/events/${e.id}`, 8403)).body.member.declined, true);
  assert.equal((await call("/reservations", 8403)).body.reservations.length, 1);
  assert.deepEqual(
    (await call(`/events/${e.id}`, 8401)).body.guests.find((g: any) => g.id === "8403")
      .declined,
    true,
  );
  await call(`/events/${e.id}/decline`, 8403, "DELETE");
  assert.equal((await call(`/events/${e.id}`, 8403)).body.wishes.length, 1);
  // The whole wishlist: new wishes appear by themselves.
  await call(`/events/${e.id}`, 8401, "PATCH", { wishes: null });
  assert.ok((await call(`/events/${e.id}`, 8403)).body.wishes.some((w: any) => w.id === c));
  // Taking a guest off closes the event for them; their booking stays.
  await call(`/events/${e.id}`, 8401, "PATCH", { guests: ["8402"] });
  // 8403 still sees the organizer's list as before, but no longer takes part.
  assert.equal((await call(`/events/${e.id}`, 8403)).body.member, null);
  assert.equal((await call(`/events/${e.id}`, 8404)).status, 404);
  assert.equal((await call("/reservations", 8403)).body.reservations.length, 1);
  // A new date or place reaches those taking part.
  const before = (await messages(8402, 0)).length;
  await call(`/events/${e.id}`, 8401, "PATCH", { celebrate_on: isoIn(12) });
  assert.match(
    (await messages(8402, before + 1))[before].text,
    /изменилось: дата празднования/,
  );
  // An empty event asks the organizer through the bot, without naming anyone.
  const empty = (
    await call("/events", 8401, "POST", {
      title: "Пикник",
      actual_on: isoIn(15),
      wishes: [],
      guests: ["8402"],
    })
  ).body.event;
  assert.deepEqual((await call(`/events/${empty.id}`, 8402)).body.wishes, []);
  assert.equal((await call(`/events/${empty.id}/remind`, 8402, "POST")).status, 200);
  const asked = await messages(8401);
  assert.match(asked[asked.length - 1].text, /ждут ваших желаний/);
  assert.doesNotMatch(asked[asked.length - 1].text, /8402/);
  // Cancelling tells those taking part; bookings stay.
  await call(`/events/${e.id}`, 8401, "DELETE");
  assert.equal((await call(`/events/${e.id}`, 8402)).status, 404);
  assert.equal((await call("/reservations", 8403)).body.reservations.length, 1);
});
test("«для всех»: guests see each other's lists and who of them booked, never in their own", async () => {
  for (const id of [8501, 8502, 8503]) await call("/me", id);
  await befriend(8501, 8502);
  await befriend(8501, 8503);
  const g2 = await gift(8502, { title: "Подарок 8502" });
  const g1 = await gift(8501, { title: "Подарок 8501" });
  await call("/events", 8501, "POST", {
    title: "Ёлка",
    actual_on: isoIn(8),
    mode: "everyone",
    guests: ["8502", "8503"],
  });
  // 8502 and 8503 are not friends, yet see each other's lists through the event.
  assert.equal((await call("/lists/8502", 8503)).status, 200);
  await call(`/gifts/${g2}/reservation`, 8503, "POST");
  await call(`/gifts/${g1}/reservation`, 8502, "POST");
  const seen = (await call("/lists/8502", 8501)).body.gifts.find((g: any) => g.id === g2);
  assert.deepEqual(seen.booked_by, ["User 8503"]);
  // Nobody learns it about their own list.
  const own = (await call("/lists/8501", 8501)).body.gifts.find((g: any) => g.id === g1);
  assert.equal(own.booked_by, undefined);
  assert.equal(own.reservation, undefined);
  // «Мои брони» point to the event.
  const booking = (await call("/reservations", 8502)).body.reservations[0];
  assert.equal(booking.my_events[0].title, "Ёлка");
});
