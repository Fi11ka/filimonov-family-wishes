import { ACCOUNT_ID_PART, isAccountId } from "../shared/account-id";
import { validBirthday } from "../shared/birthday";
import { legacyPriority } from "../shared/hearts";
import {
  ApiError,
  fail,
  giftInput,
  hash,
  https,
  text,
  token,
  usernameOf,
  validateInitData,
  type Identity,
} from "./security";
import { fetchBytes, imageType, publicHttpsUrl } from "./net";
import { JWKS_URL, liveJwks, verifyIdToken, type Jwk } from "./oidc";
import { liveContext, lookupProduct } from "./shops";
import { cartKind, readCart } from "./shops/carts";
import { aiNamer } from "./shops/naming";
import { isQuotaError, readScreenshot, screenshotBytes } from "./screenshot";
import { cleanupHelperJobs, helperRoute, homeHelper } from "./helper";
import {
  FRIEND_OF,
  bookers,
  friendship,
  giftInfo,
  now,
  pair,
  saveUser,
  stmt,
  telegramIdOf,
  type Env,
} from "./core";
import { Outbox, telegramCall } from "./notify";
import { firstPhoto, photoInput, telegramAvatar } from "./avatar";
import {
  archiveGift,
  archiveReasons,
  createGift,
  deleteGift,
  restoreGift,
  type ArchiveReason,
} from "./gifts";
import { botRoute, cleanupBotStates } from "./bot";
import { birthdayReminders } from "./birthdays";
import {
  PARTY_PEER,
  bookerNames,
  eventRoute,
  invitations,
  myParties,
} from "./events";
import { eventSpecs, isGender } from "../shared/events";
export type { Env } from "./core";
interface Gift {
  id: string;
  owner_id: string;
  title: string;
  price_minor: number | null;
  price_max_minor: number | null;
  price_range: number;
  currency: string;
  shop_url: string;
  description: string;
  priority: number;
  photo: string;
  created_at: number;
  updated_at: number;
}
const BOT_LINK = "https://t.me/FilimonovFamilyWishes_bot";
const giftColumns =
  "g.id,g.owner_id,g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.shop_url,g.description,g.hearts AS priority,CASE WHEN g.photo='' THEN 0 ELSE 1 END AS has_photo,g.created_at,g.updated_at";
function missing(): never {
  return fail(404, "NOT_FOUND", "Список или подарок недоступен.");
}
async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    fail(415, "CONTENT_TYPE", "Ожидаются JSON-данные.");
  if (Number(req.headers.get("content-length") || 0) > 240000)
    fail(413, "TOO_LARGE", "Фотография слишком большая.");
  // Read with a hard byte bound, including chunked requests without Content-Length.
  const reader = req.body?.getReader();
  if (!reader) fail(400, "VALIDATION", "Пустой запрос.");
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 240000) {
      await reader.cancel();
      fail(413, "TOO_LARGE", "Фотография слишком большая.");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    const b = JSON.parse(new TextDecoder().decode(bytes));
    if (!b || Array.isArray(b) || typeof b !== "object") throw 0;
    return b;
  } catch {
    fail(400, "VALIDATION", "Некорректный JSON.");
  }
}
/** "5006: Error: oneOf at '/' not met…" → "5006"; otherwise a short excerpt. */
function aiErrorCode(e: unknown) {
  const m = String((e as Error)?.message ?? e);
  return (
    m.match(/\b\d{4}\b/)?.[0] ||
    m.replace(/\s+/g, " ").slice(0, 60) ||
    "без кода"
  );
}
async function rate(db: D1Database, key: string, max: number) {
  const window = Math.floor(now() / 60);
  const r = await stmt(
    db,
    `INSERT INTO rate_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count`,
    key,
    window,
  ).first<{ count: number }>();
  if ((r?.count || 0) > max)
    fail(429, "RATE_LIMIT", "Слишком много запросов. Подождите минуту.");
}
async function canView(
  db: D1Database,
  owner: string,
  user: Identity | null,
  guest: string | null,
) {
  if (user?.id === owner) return true;
  if (user && (await friendship(db, user.id, owner))?.status === "accepted")
    return true;
  if (
    user &&
    (await stmt(
      db,
      `SELECT 1 AS ok WHERE ${PARTY_PEER("?1", "?2")}`,
      user.id,
      owner,
    ).first())
  )
    return true;
  if (guest && /^[A-Za-z0-9_-]{43}$/.test(guest))
    return !!(await stmt(
      db,
      "SELECT 1 AS ok FROM guest_links WHERE owner_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>? AND (kind='guest' OR ? IS NOT NULL) AND (created_by=owner_id OR EXISTS(SELECT 1 FROM users share_owner WHERE share_owner.id=owner_id AND share_owner.allow_resharing=1))",
      owner,
      await hash(guest),
      now(),
      user?.id || null,
    ).first());
  return false;
}
async function list(
  db: D1Database,
  owner: string,
  user: Identity | null,
  guestView = false,
) {
  // The normal owner list never reads reservations; guest links explicitly expose statuses.
  if (!guestView && (!user || user.id === owner))
    return (
      await stmt(
        db,
        `SELECT ${giftColumns} FROM gifts g WHERE g.owner_id=? AND g.archived_at IS NULL ORDER BY g.hearts DESC,g.created_at DESC,g.id`,
        owner,
      ).all<Gift>()
    ).results;
  const r = await stmt(
    db,
    `SELECT ${giftColumns},CASE WHEN r.gift_id IS NULL THEN 'available'
      WHEN r.user_id=?1 OR EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=g.id AND m.user_id=?1 AND m.status='joined') THEN 'mine'
      WHEN EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=g.id AND m.user_id=?1) THEN 'invited'
      ELSE 'reserved' END AS reservation,
      CASE WHEN r.user_id=?1 OR EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=g.id AND m.user_id=?1) THEN (SELECT COUNT(*) FROM reservation_members m WHERE m.gift_id=g.id AND m.status='joined') END AS group_joined
      FROM gifts g LEFT JOIN reservations r ON r.gift_id=g.id WHERE g.owner_id=?2 AND g.archived_at IS NULL ORDER BY g.hearts DESC,g.created_at DESC,g.id`,
    guestView ? "" : user?.id || "",
    owner,
  ).all();
  // Guests of an event see who booked; the owner returned above and never does.
  const names =
    guestView || !user ? null : await bookerNames(db, owner, user.id);
  return names?.size
    ? r.results.map((g) =>
        g.reservation === "reserved" && names.has(g.id as string)
          ? { ...g, booked_by: names.get(g.id as string) }
          : g,
      )
    : r.results;
}
/** Whether the bot can write to the user: they pressed Start and did not block it. */
async function notifications(db: D1Database, uid: string) {
  const r = await stmt(
    db,
    "SELECT notify,bot_chat_at,bot_blocked_at FROM users WHERE id=?",
    uid,
  ).first<{
    notify: number;
    bot_chat_at: number | null;
    bot_blocked_at: number | null;
  }>();
  return {
    enabled: r?.notify === 1,
    bot_connected: !!r?.bot_chat_at && !r.bot_blocked_at,
    bot_url: `${BOT_LINK}?start=notify`,
  };
}
const GROUP_LIMIT = 10;
/** Invites the organizer's friends (never the owner) to share a booked gift. */
async function inviteFriends(
  db: D1Database,
  out: Outbox,
  user: Identity,
  giftId: string,
  value: unknown,
) {
  if (
    !Array.isArray(value) ||
    value.length > GROUP_LIMIT ||
    !value.every(isAccountId)
  )
    fail(400, "VALIDATION", `Выберите до ${GROUP_LIMIT} друзей.`);
  const info = await giftInfo(db, giftId);
  if (!info) missing();
  const wanted = [...new Set(value as string[])].filter(
    (id) => id !== user.id && id !== info.owner.id,
  );
  if (!wanted.length) return [];
  const present =
    (
      await stmt(
        db,
        "SELECT COUNT(*) AS n FROM reservation_members WHERE gift_id=?",
        giftId,
      ).first<{ n: number }>()
    )?.n || 0;
  if (present + wanted.length > GROUP_LIMIT)
    fail(
      400,
      "VALIDATION",
      `В совместном подарке может быть до ${GROUP_LIMIT} друзей.`,
    );
  // Only accepted friends of the organizer; the insert itself checks friendship.
  const inserted = await db.batch(
    wanted.map((id) =>
      stmt(
        db,
        `INSERT INTO reservation_members(gift_id,user_id,status)
        SELECT ?2,?3,'invited' WHERE ${FRIEND_OF("?3")} ON CONFLICT DO NOTHING RETURNING user_id`,
        user.id,
        giftId,
        id,
      ),
    ),
  );
  const invited = inserted.flatMap((r) =>
    (r.results as { user_id: string }[]).map((x) => x.user_id),
  );
  out.groupInvite(user, info.owner, info.gift, invited);
  return invited;
}
/** Profile photo of an account: Telegram (digits) or other sign-in (a_<uuid>) IDs. */
const AVATAR_PATH = new RegExp(`^/api/users/(${ACCOUNT_ID_PART})/photo$`);
const SESSION_DAYS = 30,
  SESSION_LIMIT = 10;
async function sessionUser(db: D1Database, raw: string): Promise<Identity> {
  const u = /^[A-Za-z0-9_-]{43}$/.test(raw)
    ? await stmt(
        db,
        "SELECT u.id,u.name,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
        await hash(raw),
        now(),
      ).first<Identity>()
    : null;
  if (!u)
    fail(401, "SESSION_EXPIRED", "Вход истёк. Войдите через Telegram ещё раз.");
  return u;
}
async function createSession(db: D1Database, identity: Identity) {
  const raw = token(),
    expires = now() + SESSION_DAYS * 86400;
  await db.batch([
    // Keep the newest sessions only; a forgotten browser does not stay signed in forever.
    stmt(
      db,
      `DELETE FROM sessions WHERE user_id=?1 AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=?1 ORDER BY created_at DESC LIMIT ${SESSION_LIMIT - 1})`,
      identity.id,
    ),
    stmt(
      db,
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      await hash(raw),
      identity.id,
      expires,
    ),
  ]);
  return { token: raw, expires_at: expires, user: identity };
}
// Telegram's signing keys, cached per Worker instance (see oidc.ts).
const telegramKeys = liveJwks(async () => {
  const f = await fetchBytes(new URL(JWKS_URL), {
    timeoutMs: 5000,
    maxBytes: 65536,
    accept: "application/json",
    allowHost: (h) => h === "oauth.telegram.org",
  });
  if (f.status !== 200) throw new Error(`JWKS HTTP ${f.status}`);
  const keys = (
    JSON.parse(new TextDecoder().decode(f.bytes)) as { keys?: Jwk[] }
  ).keys;
  if (!Array.isArray(keys)) throw new Error("JWKS without keys");
  return keys;
});
const NONCE_TTL = 600;
/** «Открыть в браузере»: the one-time code from the Mini App lives 2 minutes. */
const HANDOFF_TTL = 120;
/** A user's card with their events; gender is shown only to the person themself. */
async function profile(db: D1Database, id: string, self = false) {
  const p = await stmt(
    db,
    "SELECT id,name,username,birthday,gender,event_title,event_date,allow_resharing,wishlist_updated_at,about,CASE WHEN photo='' THEN NULL ELSE photo_at END AS photo_at FROM users WHERE id=?",
    id,
  ).first<{
    id: string;
    name: string;
    username: string | null;
    birthday: string | null;
    gender: string | null;
    event_title: string | null;
    event_date: string | null;
    allow_resharing: number;
    wishlist_updated_at: number | null;
    about: string | null;
    photo_at: number | null;
  }>();
  if (!p) return null;
  const { gender, event_title: _, event_date: __, ...rest } = p;
  return { ...rest, ...(self ? { gender } : {}), events: eventSpecs(p) };
}
/** Binary passthrough for images and spreadsheets. Never rendered by the API origin. */
function binary(bytes: Uint8Array, type: string) {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
async function route(req: Request, env: Env, out: Outbox): Promise<unknown> {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method,
    db = env.DB;
  if (path === "/api/health" && method === "GET")
    return { ok: true, service: "Filimonov Family Wishes" };
  // The home helper authenticates with its own secret, not as a Telegram user.
  if (path.startsWith("/api/helper/"))
    return helperRoute(req, db, env.HELPER_TOKEN);
  if (!env.BOT_TOKEN)
    fail(503, "NOT_CONFIGURED", "Приложение ещё настраивается.");
  // Updates from Telegram (checked by the webhook secret) and the one-time webhook setup.
  if (path.startsWith("/api/telegram/")) return botRoute(req, env, out, rate);
  const auth = req.headers.get("authorization");
  // Mini App: signed initData on every request. Website: a session token issued
  // after Telegram Login (OpenID Connect), looked up by its SHA-256.
  const session = auth?.startsWith("Session ") ? auth.slice(8) : "";
  let user = !auth
    ? null
    : session
      ? await sessionUser(db, session)
      : await validateInitData(
          auth.startsWith("tma ") ? auth.slice(4) : "",
          env.BOT_TOKEN,
        );
  const guest = req.headers.get("x-guest-token");
  if (path === "/api/auth/config" && method === "GET")
    // The Client ID of Telegram Login is the bot ID (token prefix); it is public.
    return { bot_id: Number(env.BOT_TOKEN.split(":")[0]) || null };
  const ipKey = async () =>
    hash(req.headers.get("cf-connecting-ip") || "local");
  if (path === "/api/auth/nonce" && method === "POST") {
    // One-time value that Telegram puts into the id_token; it binds the token
    // to a login started from our site and makes a token single-use.
    await rate(db, `nonce:${await ipKey()}`, 30);
    const nonce = token();
    await stmt(
      db,
      "INSERT INTO login_nonces(nonce_hash,expires_at) VALUES(?,?)",
      await hash(nonce),
      now() + NONCE_TTL,
    ).run();
    return { nonce, expires_in: NONCE_TTL };
  }
  if (path === "/api/auth/telegram-oidc" && method === "POST") {
    const b = await body(req);
    await rate(db, `login:${await ipKey()}`, 10);
    const clientId = env.BOT_TOKEN.split(":")[0];
    const identity = await verifyIdToken(b.id_token, {
      clientId,
      jwks: telegramKeys,
      nonce: async (value) =>
        !!(await stmt(
          db,
          "DELETE FROM login_nonces WHERE nonce_hash=? AND expires_at>? RETURNING nonce_hash",
          await hash(value),
          now(),
        ).first()),
    });
    const account = await saveUser(db, identity);
    out.jobs.push(firstPhoto(env, account.id, identity).catch(() => {}));
    return createSession(db, account);
  }
  if (path === "/api/auth/handoff/redeem" && method === "POST") {
    // The website exchanges a one-time code made in the Mini App for a session.
    await rate(db, `handoff:${await ipKey()}`, 10);
    const code = (await body(req)).code;
    const row =
      typeof code === "string" && /^[A-Za-z0-9_-]{43}$/.test(code)
        ? await stmt(
            db,
            "DELETE FROM login_handoffs WHERE code_hash=? AND expires_at>? RETURNING user_id",
            await hash(code),
            now(),
          ).first<{ user_id: string }>()
        : null;
    const account = row
      ? await stmt(
          db,
          "SELECT id,name,username FROM users WHERE id=?",
          row.user_id,
        ).first<Identity>()
      : null;
    if (!account)
      fail(
        401,
        "HANDOFF_INVALID",
        "Ссылка для входа устарела. Нажмите «В браузере» в Telegram ещё раз или войдите через Telegram здесь.",
      );
    return createSession(db, account);
  }
  if (
    !user &&
    !(
      (method === "POST" &&
        /^\/api\/guest-reservations\/[a-f0-9-]{36}(\/cancel)?$/.test(path)) ||
      (method === "GET" &&
        (path === "/api/guest" ||
          /^\/api\/gifts\/[a-f0-9-]{36}\/photo$/.test(path) ||
          AVATAR_PATH.test(path)))
    )
  )
    fail(401, "AUTH_REQUIRED", "Откройте приложение через Telegram.");
  // No raw auth data, guest token, IP, or reservation identity in logs.
  const rateKey = user
    ? `u:${user.id}`
    : `ip:${await hash(req.headers.get("cf-connecting-ip") || "local")}`;
  await rate(db, rateKey, user ? 240 : 120);
  // Session identities come from the users table; only signed Telegram data updates it.
  if (user && !session) {
    // Signed Telegram data carries the Telegram ID; from here on user.id is the account ID.
    const telegram = user;
    user = await saveUser(db, telegram);
    // The Telegram photo is taken once, after the answer, so the app never waits for it.
    out.jobs.push(firstPhoto(env, user.id, telegram).catch(() => {}));
  }
  // A profile photo is visible to whoever may see this person: friends, requests, events, list links.
  const avatar = path.match(AVATAR_PATH);
  if (avatar && method === "GET") {
    const id = avatar[1];
    if (!(
      user?.id === id ||
      (user && (await friendship(db, user.id, id))) ||
      (await canView(db, id, user, guest))
    ))
      missing();
    const p = await stmt(db, "SELECT photo FROM users WHERE id=?", id).first<{
      photo: string;
    }>();
    if (!p?.photo) missing();
    return { photo: p.photo };
  }
  if (path === "/api/guest" && method === "GET") {
    if (!guest || !/^[A-Za-z0-9_-]{43}$/.test(guest)) missing();
    const link = await stmt(
      db,
      "SELECT owner_id,kind FROM guest_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND (kind='guest' OR ? IS NOT NULL) AND (created_by=owner_id OR EXISTS(SELECT 1 FROM users share_owner WHERE share_owner.id=owner_id AND share_owner.allow_resharing=1))",
      await hash(guest),
      now(),
      user?.id || null,
    ).first<{ owner_id: string; kind: string }>();
    if (!link) missing();
    return {
      owner: await profile(db, link.owner_id, user?.id === link.owner_id),
      gifts: await list(db, link.owner_id, user, link.kind === "guest"),
      invitations:
        link.kind === "guest"
          ? []
          : await invitations(db, link.owner_id, user?.id || null),
      can_reserve:
        link.kind === "guest" || (!!user && user.id !== link.owner_id),
      is_owner: user?.id === link.owner_id,
    };
  }
  const guestReservation = path.match(
    /^\/api\/guest-reservations\/([a-f0-9-]{36})(\/cancel)?$/,
  );
  if (guestReservation?.[2] && method === "POST") {
    // Guests cancel with the code their browser got when booking; the owner never manages guest bookings.
    const b = await body(req);
    const code = typeof b.code === "string" ? b.code : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) missing();
    const r = await stmt(
      db,
      "DELETE FROM reservations WHERE gift_id=? AND user_id IS NULL AND guest_code_hash=? RETURNING gift_id",
      guestReservation[1],
      await hash(code),
    ).first();
    if (!r) missing();
    return { ok: true };
  }
  if (guestReservation && method === "POST") {
    const b = await body(req);
    const name = text(b.name, 80);
    if (!name)
      fail(400, "VALIDATION", "Введите имя того, кто покупает подарок.");
    if (!guest || !/^[A-Za-z0-9_-]{43}$/.test(guest)) missing();
    const code = token();
    const result = await stmt(
      db,
      `INSERT INTO reservations(gift_id,guest_name,guest_code_hash)
      SELECT g.id,?,? FROM gifts g JOIN guest_links l ON l.owner_id=g.owner_id
      WHERE g.id=? AND g.archived_at IS NULL AND l.token_hash=? AND l.kind='guest'
      AND l.revoked_at IS NULL AND (l.created_by=l.owner_id OR EXISTS(SELECT 1 FROM users share_owner WHERE share_owner.id=l.owner_id AND share_owner.allow_resharing=1)) AND l.expires_at>? ON CONFLICT(gift_id) DO NOTHING RETURNING gift_id`,
      name,
      await hash(code),
      guestReservation[1],
      await hash(guest),
      now(),
    ).first();
    if (!result)
      fail(
        409,
        "UNAVAILABLE",
        "Подарок уже забронирован или ссылка недоступна.",
      );
    return { ok: true, code };
  }
  if (!user && method === "GET" && path.endsWith("/photo")) {
    const match = path.match(/^\/api\/gifts\/([a-f0-9-]{36})\/photo$/);
    const g = match
      ? await stmt(
          db,
          "SELECT owner_id,photo FROM gifts WHERE id=? AND archived_at IS NULL",
          match[1],
        ).first<{ owner_id: string; photo: string }>()
      : null;
    if (!g || !(await canView(db, g.owner_id, null, guest))) missing();
    return { photo: g.photo };
  }
  if (!user) fail(401, "AUTH_REQUIRED", "Откройте приложение через Telegram.");
  const uid = user.id;
  if (path === "/api/auth/handoff" && method === "POST") {
    // Only from the Mini App (signed Telegram data), not from a website session.
    if (session)
      fail(400, "VALIDATION", "Переход на сайт доступен из Telegram.");
    await rate(db, `handoff-make:${uid}`, 10);
    const code = token();
    await stmt(
      db,
      "INSERT INTO login_handoffs(code_hash,user_id,expires_at) VALUES(?,?,?)",
      await hash(code),
      uid,
      now() + HANDOFF_TTL,
    ).run();
    return { code, expires_in: HANDOFF_TTL };
  }
  if (path === "/api/me" && method === "GET")
    return {
      user: await profile(db, uid, true),
      web_session: !!session,
      notifications: await notifications(db, uid),
    };
  if (path === "/api/me/photo" && method === "PUT") {
    const photo = photoInput((await body(req)).photo);
    await stmt(
      db,
      "UPDATE users SET photo=?,photo_at=?,photo_checked=1 WHERE id=?",
      photo,
      now(),
      uid,
    ).run();
    return { user: await profile(db, uid, true) };
  }
  if (path === "/api/me/photo/telegram" && method === "GET") {
    // Cheap check for the menu: does Telegram show this person's photo at all?
    const telegramId = await telegramIdOf(db, uid);
    if (!telegramId) return { available: false };
    const r = await telegramCall(env, "getUserProfilePhotos", {
      user_id: Number(telegramId),
      limit: 1,
    });
    const count = (r.result as { total_count?: number } | undefined)
      ?.total_count;
    return { available: !!count || !!user.photo_url };
  }
  if (path === "/api/me/photo/telegram" && method === "POST") {
    await rate(db, `tg-photo:${uid}`, 10);
    const telegramId = await telegramIdOf(db, uid);
    const photo = telegramId
      ? await telegramAvatar(env, telegramId, user.photo_url)
      : null;
    if (!photo)
      fail(
        404,
        "PHOTO_UNAVAILABLE",
        "В Telegram фото скрыто настройками или не установлено.",
      );
    await stmt(
      db,
      "UPDATE users SET photo=?,photo_at=?,photo_checked=1 WHERE id=?",
      photo,
      now(),
      uid,
    ).run();
    return { user: await profile(db, uid, true) };
  }
  if (path === "/api/me" && method === "PATCH") {
    const b = await body(req);
    if (
      b.birthday !== undefined &&
      b.birthday !== null &&
      !validBirthday(b.birthday)
    )
      fail(400, "VALIDATION", "Укажите существующую дату рождения.");
    if (
      b.allow_resharing !== undefined &&
      typeof b.allow_resharing !== "boolean"
    )
      fail(400, "VALIDATION", "Проверьте настройку доступа.");
    if (b.gender !== undefined && b.gender !== null && !isGender(b.gender))
      fail(400, "VALIDATION", "Выберите пол.");
    if (b.notify !== undefined && typeof b.notify !== "boolean")
      fail(400, "VALIDATION", "Проверьте настройку уведомлений.");
    const about =
      b.about === undefined || b.about === null ? b.about : text(b.about, 500);
    const updates = [];
    if (about !== undefined)
      updates.push(
        stmt(db, "UPDATE users SET about=? WHERE id=?", about || null, uid),
      );
    if (b.notify !== undefined)
      updates.push(
        stmt(db, "UPDATE users SET notify=? WHERE id=?", b.notify ? 1 : 0, uid),
      );
    if (b.gender !== undefined)
      updates.push(
        // 8 March or 23 February that is no longer this person's event loses its guests.
        stmt(
          db,
          "DELETE FROM event_parties WHERE owner_id=? AND event_key IN ('march8','feb23') AND event_key<>?",
          uid,
          b.gender === "female" ? "march8" : b.gender === "male" ? "feb23" : "",
        ),
        stmt(db, "UPDATE users SET gender=? WHERE id=?", b.gender, uid),
      );
    if (b.birthday !== undefined)
      updates.push(
        // A changed birthday is another date: the old party's guests go.
        stmt(
          db,
          "DELETE FROM event_parties WHERE owner_id=?1 AND event_key='birthday' AND (SELECT birthday FROM users WHERE id=?1) IS NOT ?2",
          uid,
          b.birthday,
        ),
        stmt(db, "UPDATE users SET birthday=? WHERE id=?", b.birthday, uid),
      );
    if (b.allow_resharing !== undefined) {
      updates.push(
        stmt(
          db,
          "UPDATE users SET allow_resharing=? WHERE id=?",
          b.allow_resharing ? 1 : 0,
          uid,
        ),
      );
      if (!b.allow_resharing)
        updates.push(
          stmt(
            db,
            "UPDATE guest_links SET revoked_at=? WHERE owner_id=? AND created_by<>owner_id AND revoked_at IS NULL",
            now(),
            uid,
          ),
        );
    }
    if (updates.length) await db.batch(updates);
    return {
      user: await profile(db, uid, true),
      notifications: await notifications(db, uid),
    };
  }
  if (path === "/api/auth/logout" && method === "POST") {
    if (session)
      await stmt(
        db,
        "DELETE FROM sessions WHERE token_hash=?",
        await hash(session),
      ).run();
    return { ok: true };
  }
  if (path === "/api/auth/logout-all" && method === "POST") {
    await stmt(db, "DELETE FROM sessions WHERE user_id=?", uid).run();
    return { ok: true };
  }
  // ---- Friends ----
  if (path === "/api/friends" && method === "GET") {
    const rows = (
      await stmt(
        db,
        `SELECT u.id,u.name,u.username,f.status,f.requested_by,CASE WHEN u.photo='' THEN NULL ELSE u.photo_at END AS photo_at,
          (SELECT COUNT(*) FROM gifts g WHERE g.owner_id=u.id AND g.archived_at IS NULL) AS gift_count,
          EXISTS(SELECT 1 FROM subscriptions s WHERE s.subscriber_id=?1 AND s.target_id=u.id) AS subscribed
        FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=?1 THEN f.user_b ELSE f.user_a END
        WHERE f.user_a=?1 OR f.user_b=?1 ORDER BY u.name,u.id`,
        uid,
      ).all<{
        id: string;
        name: string;
        username: string | null;
        status: string;
        requested_by: string;
        photo_at: number | null;
        gift_count: number;
        subscribed: number;
      }>()
    ).results;
    const view = ({
      id,
      name,
      username,
      photo_at,
      gift_count,
      subscribed,
    }: (typeof rows)[number]) => ({
      id,
      name,
      username,
      photo_at,
      gift_count,
      subscribed: !!subscribed,
    });
    return {
      friends: rows.filter((r) => r.status === "accepted").map(view),
      incoming: rows
        .filter((r) => r.status === "pending" && r.requested_by !== uid)
        .map(({ id, name, username }) => ({ id, name, username })),
      outgoing: rows
        .filter((r) => r.status === "pending" && r.requested_by === uid)
        .map(({ id, name, username }) => ({ id, name, username })),
    };
  }
  if (path === "/api/friends/requests" && method === "POST") {
    const b = await body(req);
    await rate(db, `friendreq:${uid}`, 10);
    const username = usernameOf(b.username);
    if (!username && !isAccountId(b.user_id))
      fail(
        400,
        "VALIDATION",
        "Введите ник Telegram, например @anna_filimonova.",
      );
    // A nickname is looked up among Telegram sign-ins; an account ID directly.
    const target = await stmt(
      db,
      "SELECT user_id AS id FROM identities WHERE provider='telegram' AND username=? UNION SELECT id FROM users WHERE id=?",
      username,
      isAccountId(b.user_id) ? b.user_id : "",
    ).first<{ id: string }>();
    if (!target)
      fail(
        404,
        "USER_NOT_FOUND",
        "Пользователь не найден. Он должен хотя бы раз открыть приложение в Telegram.",
      );
    if (target.id === uid)
      fail(400, "SELF_FRIEND", "Нельзя добавить в друзья самого себя.");
    const existing = await friendship(db, uid, target.id);
    if (existing?.status === "accepted")
      fail(409, "ALREADY_FRIENDS", "Вы уже друзья.");
    const [a, bId] = pair(uid, target.id);
    if (existing && existing.requested_by !== uid) {
      // They already asked us: sending a request back means accepting it.
      await stmt(
        db,
        "UPDATE friendships SET status='accepted',accepted_at=unixepoch() WHERE user_a=? AND user_b=? AND status='pending'",
        a,
        bId,
      ).run();
      out.friendAdded(user, target.id);
      return { status: "accepted" };
    }
    const created = await stmt(
      db,
      "INSERT INTO friendships(user_a,user_b,status,requested_by) VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING RETURNING user_a",
      a,
      bId,
      uid,
    ).first();
    if (created) out.friendRequest(user, target.id);
    return { status: "pending" };
  }
  const friendMatch = path.match(
    new RegExp(`^/api/friends/(${ACCOUNT_ID_PART})(/accept)?$`),
  );
  if (friendMatch) {
    const [a, b] = pair(uid, friendMatch[1]);
    if (friendMatch[2] && method === "POST") {
      const r = await stmt(
        db,
        "UPDATE friendships SET status='accepted',accepted_at=unixepoch() WHERE user_a=? AND user_b=? AND status='pending' AND requested_by<>? RETURNING user_a",
        a,
        b,
        uid,
      ).first();
      if (!r) fail(404, "NOT_FOUND", "Заявка не найдена.");
      out.friendAdded(user, friendMatch[1]);
      return { ok: true };
    }
    if (!friendMatch[2] && method === "DELETE") {
      // Decline, cancel or unfriend. Their reservations stay; they can cancel them.
      await db.batch([
        stmt(db, "DELETE FROM friendships WHERE user_a=? AND user_b=?", a, b),
        stmt(
          db,
          "DELETE FROM subscriptions WHERE (subscriber_id=?1 AND target_id=?2) OR (subscriber_id=?2 AND target_id=?1)",
          a,
          b,
        ),
      ]);
      return { ok: true };
    }
  }
  // Subscriptions: news about a friend's wishlist in the bot.
  const subscriptionMatch = path.match(
    new RegExp(`^/api/subscriptions/(${ACCOUNT_ID_PART})$`),
  );
  if (subscriptionMatch && (method === "PUT" || method === "DELETE")) {
    const target = subscriptionMatch[1];
    if (method === "DELETE") {
      await stmt(
        db,
        "DELETE FROM subscriptions WHERE subscriber_id=? AND target_id=?",
        uid,
        target,
      ).run();
      return { subscribed: false, notifications: await notifications(db, uid) };
    }
    if ((await friendship(db, uid, target))?.status !== "accepted")
      fail(403, "NOT_FRIENDS", "Подписаться можно только на друзей.");
    await stmt(
      db,
      "INSERT OR IGNORE INTO subscriptions(subscriber_id,target_id) VALUES(?,?)",
      uid,
      target,
    ).run();
    return { subscribed: true, notifications: await notifications(db, uid) };
  }
  if (path === "/api/friend-invites" && method === "GET")
    return {
      invites: (
        await stmt(
          db,
          "SELECT id,expires_at FROM friend_invites WHERE owner_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC",
          uid,
          now(),
        ).all()
      ).results,
    };
  if (path === "/api/friend-invites" && method === "POST") {
    await rate(db, `finvite:${uid}`, 5);
    const raw = token(),
      id = crypto.randomUUID(),
      expires = now() + 30 * 86400;
    await db.batch([
      stmt(
        db,
        "UPDATE friend_invites SET revoked_at=? WHERE owner_id=? AND revoked_at IS NULL",
        now(),
        uid,
      ),
      stmt(
        db,
        "INSERT INTO friend_invites(id,owner_id,token_hash,expires_at) VALUES(?,?,?,?)",
        id,
        uid,
        await hash(raw),
        expires,
      ),
    ]);
    return {
      id,
      expires_at: expires,
      telegram_url: `${BOT_LINK}?startapp=f_${raw}`,
    };
  }
  const inviteMatch = path.match(/^\/api\/friend-invites\/([a-f0-9-]{36})$/);
  if (inviteMatch && method === "DELETE") {
    await stmt(
      db,
      "UPDATE friend_invites SET revoked_at=? WHERE id=? AND owner_id=?",
      now(),
      inviteMatch[1],
      uid,
    ).run();
    return { ok: true };
  }
  if (
    (path === "/api/friend-invites/preview" ||
      path === "/api/friend-invites/accept") &&
    method === "POST"
  ) {
    const b = await body(req);
    await rate(db, `fjoin:${uid}`, 10);
    const raw = typeof b.token === "string" ? b.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw))
      fail(404, "INVITE_INVALID", "Приглашение не найдено или устарело.");
    // The owner's own «Поделиться» link for Telegram doubles as a friend invitation.
    const invite =
      (await stmt(
        db,
        "SELECT owner_id FROM friend_invites WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
        await hash(raw),
        now(),
      ).first<{ owner_id: string }>()) ||
      (await stmt(
        db,
        "SELECT owner_id FROM guest_links WHERE token_hash=? AND kind='telegram' AND created_by=owner_id AND revoked_at IS NULL AND expires_at>?",
        await hash(raw),
        now(),
      ).first<{ owner_id: string }>());
    if (!invite)
      fail(404, "INVITE_INVALID", "Приглашение не найдено или устарело.");
    if (invite.owner_id === uid)
      fail(400, "SELF_FRIEND", "Это ваше собственное приглашение.");
    const existing = await friendship(db, uid, invite.owner_id);
    if (path.endsWith("/preview"))
      return {
        owner: await profile(db, invite.owner_id),
        already_friends: existing?.status === "accepted",
      };
    // The inviter agreed by creating the link; the visitor agrees by confirming.
    const [a, bId] = pair(uid, invite.owner_id);
    if (existing?.status !== "accepted") out.friendAdded(user, invite.owner_id);
    await stmt(
      db,
      `INSERT INTO friendships(user_a,user_b,status,requested_by,accepted_at) VALUES(?,?,'accepted',?,unixepoch())
      ON CONFLICT(user_a,user_b) DO UPDATE SET status='accepted',accepted_at=COALESCE(accepted_at,unixepoch())`,
      a,
      bId,
      invite.owner_id,
    ).run();
    return { ok: true, owner: await profile(db, invite.owner_id) };
  }
  // ---- Lists and gifts ----
  const listMatch = path.match(new RegExp(`^/api/lists/(${ACCOUNT_ID_PART})$`));
  if (listMatch && method === "GET") {
    const owner = listMatch[1];
    if (!(await canView(db, owner, user, guest))) missing();
    const p = await profile(db, owner, owner === uid);
    if (!p) missing();
    return {
      owner: p,
      gifts: await list(db, owner, user),
      invitations: await invitations(db, owner, uid),
      is_owner: owner === uid,
      can_reserve: owner !== uid,
    };
  }
  if (path === "/api/archive" && method === "GET")
    return {
      owner: await profile(db, uid, true),
      gifts: (
        await stmt(
          db,
          `SELECT ${giftColumns},g.archived_at,g.archive_reason FROM gifts g WHERE g.owner_id=? AND g.archived_at IS NOT NULL ORDER BY g.archived_at DESC,g.id`,
          uid,
        ).all()
      ).results,
    };
  if (path === "/api/gifts" && method === "POST") {
    const b = await body(req);
    return {
      id: await createGift(db, out, user, giftInput(b), {
        archived: b.archived === true,
        quiet: b.quiet === true,
      }),
    };
  }
  if (path === "/api/gifts/announce" && method === "POST") {
    // After an import: one message to subscribers about all wishes added quietly.
    const b = await body(req);
    const ids = Array.isArray(b.ids)
      ? b.ids
          .filter(
            (v): v is string =>
              typeof v === "string" && /^[a-f0-9-]{36}$/.test(v),
          )
          .slice(0, 100)
      : [];
    if (!ids.length) return { ok: true };
    await rate(db, `announce:${uid}`, 5);
    const rows = (
      await stmt(
        db,
        `SELECT id,title,price_minor,price_max_minor,price_range,currency FROM gifts WHERE owner_id=? AND archived_at IS NULL AND created_at>? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY hearts DESC,created_at`,
        uid,
        now() - 3600,
        ...ids,
      ).all<{
        id: string;
        title: string;
        price_minor: number | null;
        price_max_minor: number | null;
        price_range: number;
        currency: string;
      }>()
    ).results;
    await out.wishesAdded(user, rows);
    return { ok: true };
  }
  const giftMatch = path.match(
    /^\/api\/gifts\/([a-f0-9-]{36})(\/reservation(?:\/invite|\/join|\/decline|\/members)?|\/photo|\/archive|\/restore)?$/,
  );
  if (giftMatch) {
    const id = giftMatch[1];
    const g = await stmt(
      db,
      "SELECT id,owner_id,archived_at FROM gifts WHERE id=?",
      id,
    ).first<{ id: string; owner_id: string; archived_at: number | null }>();
    if (!g) missing();
    if (giftMatch[2] === "/photo" && method === "GET") {
      if (g.owner_id !== uid && g.archived_at !== null) missing();
      if (!(await canView(db, g.owner_id, user, guest))) missing();
      return {
        photo:
          (
            await stmt(db, "SELECT photo FROM gifts WHERE id=?", id).first<{
              photo: string;
            }>()
          )?.photo || "",
      };
    }
    if (giftMatch[2] === "/restore" && method === "POST") {
      if (g.owner_id !== uid) missing();
      await restoreGift(db, out, user, id);
      return { ok: true };
    }
    if (giftMatch[2] === "/archive" && method === "POST") {
      if (g.owner_id !== uid) missing();
      const b = req.headers.get("content-type")?.startsWith("application/json")
        ? await body(req)
        : {};
      const reason = b.reason ?? "bought_self";
      if (!archiveReasons.includes(reason as ArchiveReason))
        fail(400, "VALIDATION", "Выберите причину переноса в архив.");
      // Booked or not, the answer is the same: the owner never learns about bookings.
      await archiveGift(db, out, user, id, reason as ArchiveReason);
      return { ok: true };
    }
    if (!giftMatch[2] && (method === "PUT" || method === "DELETE")) {
      if (g.owner_id !== uid) missing();
      if (method === "PUT") {
        const v = giftInput(await body(req));
        await stmt(
          db,
          "UPDATE gifts SET title=?,price_minor=?,price_max_minor=?,price_range=?,currency=?,shop_url=?,description=?,hearts=?,priority=?,photo=?,updated_at=unixepoch() WHERE id=? AND owner_id=?",
          v.title,
          v.price_minor,
          v.price_max_minor,
          v.price_range,
          v.currency,
          v.shop_url,
          v.description,
          v.priority,
          legacyPriority(v.priority),
          v.photo,
          id,
          uid,
        ).run();
      } else await deleteGift(db, out, user, id);
      return { ok: true }; // Identical response whether reserved or available. No reservation-dependent errors.
    }
    if (giftMatch[2]?.startsWith("/reservation")) {
      // Reject owner BEFORE any reservation read, including cancel attempts.
      if (g.owner_id === uid)
        fail(
          403,
          "SELF_RESERVATION",
          "Нельзя бронировать собственные подарки.",
        );
      const action = giftMatch[2].slice("/reservation".length);
      const info = () => giftInfo(db, id);
      // Cancelling or leaving is allowed even after a link expires or unfriending.
      if (!action && method === "DELETE") {
        const organizer = await stmt(
          db,
          "SELECT 1 AS ok FROM reservations WHERE gift_id=? AND user_id=?",
          id,
          uid,
        ).first();
        if (organizer) {
          const members = (await bookers(db, id)).filter((m) => m !== uid);
          await stmt(
            db,
            "DELETE FROM reservations WHERE gift_id=? AND user_id=?",
            id,
            uid,
          ).run();
          if (members.length) {
            const i = await info();
            if (i) out.groupCancelled(user, i.gift, members);
          }
        } else {
          const left = await stmt(
            db,
            "DELETE FROM reservation_members WHERE gift_id=? AND user_id=? RETURNING status",
            id,
            uid,
          ).first<{ status: string }>();
          const i = left?.status === "joined" ? await info() : null;
          if (i?.organizer)
            out.memberAnswered(user, i.organizer, i.gift, false);
        }
        return { ok: true };
      }
      // «Куплю сам»: the organizer keeps the booking, everyone else leaves it.
      if (action === "/members" && method === "DELETE") {
        if (
          !(await stmt(
            db,
            "SELECT 1 AS ok FROM reservations WHERE gift_id=? AND user_id=?",
            id,
            uid,
          ).first())
        )
          fail(
            403,
            "NOT_ORGANIZER",
            "Отменить совместный подарок может только тот, кто его собирает.",
          );
        const removed = (
          await stmt(
            db,
            "DELETE FROM reservation_members WHERE gift_id=? RETURNING user_id",
            id,
          ).all<{ user_id: string }>()
        ).results.map((r) => r.user_id);
        if (removed.length) {
          const i = await info();
          if (i) out.groupDissolved(user, i.gift, removed);
        }
        return { ok: true, removed: removed.length };
      }
      if ((action === "/join" || action === "/decline") && method === "POST") {
        const r = await stmt(
          db,
          action === "/join"
            ? "UPDATE reservation_members SET status='joined' WHERE gift_id=? AND user_id=? AND status='invited' RETURNING status"
            : "DELETE FROM reservation_members WHERE gift_id=? AND user_id=? AND status='invited' RETURNING status",
          id,
          uid,
        ).first();
        if (!r) fail(404, "NOT_FOUND", "Приглашение уже неактуально.");
        const i = await info();
        if (i?.organizer)
          out.memberAnswered(user, i.organizer, i.gift, action === "/join");
        return { ok: true };
      }
      if (action === "/invite" && method === "POST") {
        const b = await body(req);
        await rate(db, `ginvite:${uid}`, 20);
        if (
          !(await stmt(
            db,
            "SELECT 1 AS ok FROM reservations WHERE gift_id=? AND user_id=?",
            id,
            uid,
          ).first())
        )
          fail(
            403,
            "NOT_ORGANIZER",
            "Приглашать может только тот, кто забронировал подарок.",
          );
        return { invited: await inviteFriends(db, out, user, id, b.friends) };
      }
      if (action || method !== "POST") missing();
      if (
        g.archived_at !== null ||
        !(await canView(db, g.owner_id, user, guest))
      )
        missing();
      const b = req.headers.get("content-type")?.startsWith("application/json")
        ? await body(req)
        : {};
      // Access is rechecked INSIDE the atomic write; revocation/unfriending cannot race this insert.
      const guestHash =
        guest && /^[A-Za-z0-9_-]{43}$/.test(guest) ? await hash(guest) : "";
      const r = await stmt(
        db,
        `INSERT INTO reservations(gift_id,user_id)
        SELECT id,?1 FROM gifts WHERE id=?2 AND owner_id<>?1 AND archived_at IS NULL AND (
          ${FRIEND_OF("gifts.owner_id")}
          OR ${PARTY_PEER("?1", "gifts.owner_id")}
          OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=gifts.owner_id AND l.token_hash=?3 AND l.revoked_at IS NULL AND (l.created_by=l.owner_id OR EXISTS(SELECT 1 FROM users share_owner WHERE share_owner.id=l.owner_id AND share_owner.allow_resharing=1)) AND l.expires_at>?4)
        ) ON CONFLICT(gift_id) DO NOTHING RETURNING gift_id`,
        uid,
        id,
        guestHash,
        now(),
      ).first();
      if (!r)
        fail(
          409,
          "UNAVAILABLE",
          "Подарок уже забронирован или доступ изменился. Обновите список.",
        );
      // «Подарить вместе»: invite friends right away.
      const invited = b.friends
        ? await inviteFriends(db, out, user, id, b.friends)
        : [];
      return { ok: true, invited };
    }
  }
  if (path === "/api/reservations" && method === "GET") {
    // Metadata available only while the viewer still has access (or was invited). Cancellation needs only gift ID.
    const rows = (
      await stmt(
        db,
        `SELECT r.gift_id,
        CASE WHEN r.user_id=?1 THEN 'organizer' ELSE m.status END AS role,
        CASE WHEN m.user_id IS NOT NULL OR ${FRIEND_OF("g.owner_id")} OR ${PARTY_PEER("?1", "g.owner_id")} OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=g.owner_id AND l.revoked_at IS NULL AND (l.created_by=l.owner_id OR EXISTS(SELECT 1 FROM users share_owner WHERE share_owner.id=l.owner_id AND share_owner.allow_resharing=1)) AND l.expires_at>?2) THEN 1 ELSE 0 END AS visible,
        g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.owner_id,ou.name AS owner_name,org.name AS organizer_name,
        ou.birthday,ou.gender,ou.event_title,ou.event_date,
        CASE WHEN g.archived_at IS NULL THEN 0 ELSE 1 END AS archived
      FROM reservations r JOIN gifts g ON g.id=r.gift_id JOIN users ou ON ou.id=g.owner_id
      LEFT JOIN users org ON org.id=r.user_id
      LEFT JOIN reservation_members m ON m.gift_id=r.gift_id AND m.user_id=?1
      WHERE (r.user_id=?1 OR m.user_id IS NOT NULL) AND g.owner_id<>?1
      ORDER BY role='invited' DESC,r.created_at DESC`,
        uid,
        now(),
      ).all<Record<string, unknown>>()
    ).results;
    const ids = rows.map((r) => r.gift_id as string);
    const members = ids.length
      ? (
          await stmt(
            db,
            `SELECT m.gift_id,m.user_id AS id,u.name,u.username,m.status FROM reservation_members m JOIN users u ON u.id=m.user_id WHERE m.gift_id IN (${ids.map(() => "?").join(",")}) ORDER BY m.created_at`,
            ...ids,
          ).all<{
            gift_id: string;
            id: string;
            name: string;
            username: string | null;
            status: string;
          }>()
        ).results
      : [];
    // Parties of these owners the user is invited to: the booking links there.
    const mine = await myParties(db, uid);
    return {
      reservations: rows.map(
        ({ visible, birthday, gender, event_title, event_date, ...r }) => ({
          ...r,
          my_events: visible
            ? mine
                .filter((e) => e.owner_id === r.owner_id)
                .map(({ key, date }) => ({ key, date }))
            : [],
          // When to buy by: the owner's events, while their list is visible.
          owner_events: visible
            ? eventSpecs({
                birthday: birthday as string | null,
                gender: gender as string | null,
                event_title: event_title as string | null,
                event_date: event_date as string | null,
              })
            : [],
          ...(visible
            ? {}
            : {
                title: "Подарок из закрытого списка",
                price_minor: null,
                price_max_minor: null,
              }),
          // Invitees see who organizes, not the other invitees.
          members:
            r.role === "invited"
              ? []
              : members
                  .filter((m) => m.gift_id === r.gift_id)
                  .map(({ gift_id: _, ...m }) => m),
        }),
      ),
    };
  }
  const shareList = path.match(
    new RegExp(`^/api/lists/(${ACCOUNT_ID_PART})/share-links$`),
  );
  if (
    (path === "/api/guest-links" || shareList) &&
    (method === "GET" || method === "POST")
  ) {
    const ownerId = shareList ? shareList[1] : uid;
    if (!(await canView(db, ownerId, user, guest))) missing();
    if (ownerId !== uid && !(await profile(db, ownerId))?.allow_resharing)
      fail(
        403,
        "SHARING_DISABLED",
        "Владелец запретил делиться этим вишлистом.",
      );
    if (method === "POST") await rate(db, `links:${uid}`, 5);
    const links = [];
    for (const kind of ["telegram", "guest"]) {
      let link = await stmt(
        db,
        "SELECT id,token_value FROM guest_links WHERE owner_id=? AND created_by=? AND kind=? AND revoked_at IS NULL AND token_value IS NOT NULL LIMIT 1",
        ownerId,
        uid,
        kind,
      ).first<{ id: string; token_value: string }>();
      if (!link && method === "GET") continue;
      if (!link) {
        const raw = token(),
          id = crypto.randomUUID();
        await stmt(
          db,
          `INSERT OR IGNORE INTO guest_links(id,owner_id,created_by,token_hash,expires_at,kind,token_value)
          SELECT ?,?,?,?,253402300799,?,? FROM users WHERE id=? AND (id=? OR allow_resharing=1)`,
          id,
          ownerId,
          uid,
          await hash(raw),
          kind,
          raw,
          ownerId,
          uid,
        ).run();
        link = await stmt(
          db,
          "SELECT id,token_value FROM guest_links WHERE owner_id=? AND created_by=? AND kind=? AND revoked_at IS NULL AND token_value IS NOT NULL",
          ownerId,
          uid,
          kind,
        ).first<{ id: string; token_value: string }>();
        if (!link)
          fail(
            403,
            "SHARING_DISABLED",
            "Владелец запретил делиться этим вишлистом.",
          );
      }
      links.push({
        id: link.id,
        kind,
        web_url:
          kind === "guest"
            ? `${https(env.APP_URL)}#guest=${link.token_value}`
            : `${BOT_LINK}?startapp=s_${link.token_value}`,
      });
    }
    const guestLink = links.find((l) => l.kind === "guest");
    return {
      links,
      legacy_links:
        ownerId === uid
          ? (
              await stmt(
                db,
                "SELECT id FROM guest_links WHERE owner_id=? AND token_value IS NULL AND revoked_at IS NULL AND expires_at>?",
                uid,
                now(),
              ).all()
            ).results
          : [],
      id: guestLink?.id,
      token: guestLink?.web_url.split("#guest=")[1],
    };
  }
  const linkMatch = path.match(/^\/api\/guest-links\/([a-f0-9-]{36})$/);
  if (linkMatch && method === "DELETE") {
    await stmt(
      db,
      "UPDATE guest_links SET revoked_at=? WHERE id=? AND (owner_id=? OR created_by=?)",
      now(),
      linkMatch[1],
      uid,
      uid,
    ).run();
    return { ok: true };
  }
  const events = await eventRoute(
    db,
    out,
    user,
    path,
    method,
    () => body(req),
    (key, max) => rate(db, key, max),
    (owner) => canView(db, owner, user, guest),
  );
  if (events) return events;
  // ---- Fetching from other sites (user-initiated, authenticated, rate-limited) ----
  if (path === "/api/fetch/cart" && method === "POST") {
    // Shared WB basket / WB wishlist / Ozon cart → product links for the import preview.
    const b = await body(req);
    await rate(db, `sheet:${uid}`, 5);
    const target = publicHttpsUrl(text(b.url, 2048, true));
    if (cartKind(target) === "chatgpt")
      fail(
        400,
        "CHATGPT_LINK",
        "Ссылки на ChatGPT не открываются с сервера. Скопируйте ответ ChatGPT и вставьте его на вкладке «Из текста».",
      );
    if (!cartKind(target))
      fail(
        400,
        "VALIDATION",
        "Вставьте ссылку «Поделиться» из корзины Wildberries или Ozon либо ссылку на вишлист Wildberries.",
      );
    let cart;
    try {
      cart = await readCart(
        target,
        liveContext(env.HELPER_TOKEN ? homeHelper(db) : null),
      );
    } catch {
      fail(
        502,
        "CART_UNAVAILABLE",
        "Магазин не отдал список товаров. Попробуйте позже или добавьте товары по одной ссылке.",
      );
    }
    if (!cart.items.length)
      fail(
        404,
        "CART_EMPTY",
        cart.shop === "Ozon"
          ? "Не удалось прочитать корзину Ozon: магазин закрылся от сервера. Если настроен домашний помощник, проверьте, что он запущен."
          : "В этой ссылке не нашлось товаров.",
      );
    return cart;
  }
  if (path === "/api/fetch/product" && method === "POST") {
    const b = await body(req);
    // Imports from a cart look up many products in a row; they get their own budget.
    if (b.bulk === true) await rate(db, `fetchbulk:${uid}`, 120);
    else await rate(db, `fetch:${uid}`, 30);
    return lookupProduct(
      text(b.url, 2048, true),
      liveContext(env.HELPER_TOKEN ? homeHelper(db) : null),
      env.AI ? aiNamer(env.AI) : undefined,
    );
  }
  if (path === "/api/fetch/screenshot" && method === "POST") {
    const b = await body(req);
    await rate(db, `screenshot:${uid}`, 6);
    if (!env.AI)
      fail(503, "AI_UNAVAILABLE", "Распознавание скриншотов не настроено.");
    const image = text(b.image, 235000, true);
    if (!screenshotBytes(image))
      fail(400, "VALIDATION", "Выберите скриншот JPEG, PNG или WebP.");
    let r;
    try {
      r = await readScreenshot(env.AI, image);
    } catch (e) {
      // Free Workers AI quota (10 000 neurons a day) is shared by the whole app.
      if (isQuotaError(e))
        fail(
          429,
          "AI_LIMIT",
          "Бесплатный лимит распознавания на сегодня закончился. Он обновится в 03:00 по Москве, а пока заполните поля вручную.",
        );
      fail(
        502,
        "AI_FAILED",
        // The model's error code (e.g. "5006") tells what Cloudflare refused.
        `Не удалось распознать скриншот (${aiErrorCode(e)}). Попробуйте ещё раз.`,
      );
    }
    if (!r)
      fail(
        422,
        "SCREENSHOT_UNREADABLE",
        "На скриншоте не нашлось названия или цены. Сделайте скриншот карточки товара целиком.",
      );
    return r;
  }
  if (path === "/api/fetch/image" && method === "POST") {
    const b = await body(req);
    await rate(db, `fetch:${uid}`, 30);
    const target = publicHttpsUrl(text(b.url, 4096, true));
    let bytes: Uint8Array = new Uint8Array(),
      type = "";
    try {
      const f = await fetchBytes(target, {
        timeoutMs: 10000,
        maxBytes: 12_000_000,
        accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
      });
      bytes = f.bytes;
      type = f.status === 200 ? imageType(f.bytes) : "";
    } catch (e) {
      if (!env.HELPER_TOKEN) throw e;
    }
    // Photo hosts of shops that block servers: ask the home helper instead.
    if (!type && env.HELPER_TOKEN) {
      const helper = homeHelper(db);
      const got = helper.handlesImage(target)
        ? await helper.image(target)
        : null;
      if (got?.status === 200 && imageType(got.bytes)) {
        bytes = got.bytes;
        type = imageType(got.bytes);
      }
    }
    if (!type)
      fail(
        422,
        "NOT_AN_IMAGE",
        "По ссылке не нашлось картинки. Загрузите фото вручную.",
      );
    return binary(bytes, type);
  }
  if (path === "/api/fetch/sheet" && method === "POST") {
    const b = await body(req);
    await rate(db, `sheet:${uid}`, 5);
    const id = text(b.url, 2048, true).match(
      /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:[/?#]|$)/,
    )?.[1];
    if (!id)
      fail(
        400,
        "VALIDATION",
        "Вставьте ссылку на Google Таблицу (docs.google.com/spreadsheets/…).",
      );
    const f = await fetchBytes(
      new URL(
        `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
      ),
      {
        timeoutMs: 25000,
        maxBytes: 40_000_000,
        accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        allowHost: (h) =>
          h === "docs.google.com" || h.endsWith(".googleusercontent.com"),
      },
    );
    // A private sheet answers with a sign-in page instead of a ZIP.
    if (f.status !== 200 || f.bytes[0] !== 0x50 || f.bytes[1] !== 0x4b)
      fail(
        403,
        "SHEET_PRIVATE",
        "Таблица недоступна. Откройте доступ «Все, у кого есть ссылка» или скачайте файл .xlsx и загрузите его.",
      );
    return binary(
      f.bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }
  fail(404, "NOT_FOUND", "Раздел не найден.");
}
export default {
  async fetch(
    req: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const out = new Outbox(env, env.DB);
    // Telegram messages go out after the answer; a failed send never fails the request.
    try {
      return await respond(req, env, out);
    } finally {
      if (out.jobs.length) ctx?.waitUntil(out.done());
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx?: ExecutionContext) {
    const out = new Outbox(env, env.DB);
    await birthdayReminders(env, out);
    ctx?.waitUntil(out.done());
    await env.DB.batch([
      stmt(
        env.DB,
        "DELETE FROM rate_limits WHERE window<?",
        Math.floor(now() / 60) - 1440,
      ),
      stmt(env.DB, "DELETE FROM sessions WHERE expires_at<?", now()),
      stmt(env.DB, "DELETE FROM login_nonces WHERE expires_at<?", now()),
      stmt(env.DB, "DELETE FROM login_handoffs WHERE expires_at<?", now()),
      cleanupHelperJobs(env.DB),
      cleanupBotStates(env.DB),
      stmt(
        env.DB,
        "DELETE FROM birthday_notices WHERE birthday_on<date('now','-30 days')",
      ),
      stmt(
        env.DB,
        "DELETE FROM event_parties WHERE event_on<date('now','-30 days')",
      ),
    ]);
  },
};
async function respond(req: Request, env: Env, out: Outbox): Promise<Response> {
  const origin = req.headers.get("origin");
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
  });
  if (origin && origin === env.APP_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    headers.set(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,X-Guest-Token",
    );
    headers.set("Access-Control-Max-Age", "600");
  }
  if (origin && origin !== env.APP_ORIGIN)
    return Response.json(
      {
        error: {
          code: "ORIGIN_DENIED",
          message: "Недопустимый источник запроса.",
        },
      },
      { status: 403, headers },
    );
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  try {
    const data = await route(req, env, out);
    if (data instanceof Response) {
      data.headers.forEach((v, k) => headers.set(k, v));
      return new Response(data.body, { status: 200, headers });
    }
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (e) {
    if (e instanceof ApiError)
      return Response.json(
        { error: { code: e.code, message: e.message } },
        { status: e.status, headers },
      );
    // Do not log exceptions: SQL error text can include private bindings.
    return Response.json(
      {
        error: {
          code: "INTERNAL",
          message: "Не удалось выполнить запрос. Попробуйте ещё раз.",
        },
      },
      { status: 500, headers },
    );
  }
}
