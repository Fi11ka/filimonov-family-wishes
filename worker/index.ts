import { ACCOUNT_ID_PART, isAccountId } from "../shared/account-id";
import { validBirthday } from "../shared/birthday";
import { legacyPriority } from "../shared/hearts";
import { isId, isToken } from "../shared/token";
import { siteProfileLink } from "../shared/site-link";
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
import { PHOTO_DATA_URL } from "./photo-data";
import { JWKS_URL, liveJwks, verifyIdToken, type Jwk } from "./oidc";
import { liveContext, lookupProduct } from "./shops";
import { cartKind, readCart } from "./shops/carts";
import { aiNamer } from "./shops/naming";
import { isQuotaError, readScreenshot, screenshotBytes } from "./screenshot";
import { cleanupHelperJobs, helperRoute, homeHelper } from "./helper";
import {
  CONNECTED,
  LINK_ACTIVE,
  SEES,
  addFriend,
  bookers,
  follow,
  giftInfo,
  now,
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
  giftChanged,
  ownGift,
  restoreGift,
  type ArchiveReason,
} from "./gifts";
import { botRoute, cleanupBotStates } from "./bot";
import { birthdayReminders } from "./birthdays";
import {
  PARTY_PEER,
  EVENT_GIFT,
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
  // One query: an open profile or an approved follower of a closed one, a fellow
  // guest of an upcoming party, or the guest link (the Telegram «Поделиться»
  // links now lead to the profile only). Without signing in only the guest link
  // shows wishes, even of an open profile. A guest link counts here only when it
  // opens the whole personal list; other links work through the guest routes,
  // which keep to their list and set.
  return !!(await stmt(
    db,
    `SELECT 1 AS ok WHERE (?1<>'' AND ${SEES("?2")})
    OR (?1<>'' AND ${PARTY_PEER("?1", "?2")})
    OR (?3<>'' AND EXISTS(SELECT 1 FROM guest_links WHERE owner_id=?2 AND token_hash=?3 AND ${LINK_ACTIVE("guest_links", "?4")} AND kind='guest' AND list_id IS NULL AND picked=0))`,
    user?.id || "",
    owner,
    isToken(guest) ? await hash(guest) : "",
    now(),
  ).first());
}
/**
 * Which wishes of an owner a view shows: one list (null: the personal one) and,
 * for a guest link with picked wishes, only those.
 */
type Scope = { list: string | null; link?: string; event?: string };
async function list(
  db: D1Database,
  owner: string,
  user: Identity | null,
  guestView = false,
  scope: Scope = { list: null },
) {
  // A picked guest link or a picked event shows only its wishes.
  const where = `g.list_id IS ?3 AND (?4='' OR EXISTS(SELECT 1 FROM guest_link_gifts lg WHERE lg.link_id=?4 AND lg.gift_id=g.id))
    AND (?5='' OR EXISTS(SELECT 1 FROM event_wishes ew WHERE ew.event_id=?5 AND ew.gift_id=g.id))`;
  // The owner's list never reads reservations; others (a guest link without
  // signing in too) see only whether a gift is free.
  if (!guestView && user?.id === owner)
    return (
      await stmt(
        db,
        `SELECT ${giftColumns} FROM gifts g WHERE g.owner_id=?2 AND g.archived_at IS NULL AND ${where} ORDER BY g.hearts DESC,g.created_at DESC,g.id`,
        "",
        owner,
        scope.list,
        scope.link || "",
        scope.event || "",
      ).all<Gift>()
    ).results;
  // Guests of an event see who booked; the owner returned above and never does.
  // Both queries go to the database at once.
  const [r, names] = await Promise.all([
    stmt(
      db,
      `SELECT ${giftColumns},CASE WHEN r.gift_id IS NULL THEN 'available'
      WHEN r.user_id=?1 OR EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=g.id AND m.user_id=?1 AND m.status='joined') THEN 'mine'
      WHEN EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=g.id AND m.user_id=?1) THEN 'invited'
      ELSE 'reserved' END AS reservation,
      CASE WHEN r.user_id=?1 OR EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=g.id AND m.user_id=?1) THEN (SELECT COUNT(*) FROM reservation_members m WHERE m.gift_id=g.id AND m.status='joined') END AS group_joined
      FROM gifts g LEFT JOIN reservations r ON r.gift_id=g.id WHERE g.owner_id=?2 AND g.archived_at IS NULL AND ${where} ORDER BY g.hearts DESC,g.created_at DESC,g.id`,
      guestView ? "" : user?.id || "",
      owner,
      scope.list,
      scope.link || "",
      scope.event || "",
    ).all(),
    guestView || !user ? null : bookerNames(db, owner, user.id),
  ]);
  return names?.size
    ? r.results.map((g) =>
        g.reservation === "reserved" && names.has(g.id as string)
          ? { ...g, booked_by: names.get(g.id as string) }
          : g,
      )
    : r.results;
}
/** The lists someone keeps for people close to them, oldest first. */
async function managedLists(db: D1Database, manager: string) {
  return (
    await stmt(
      db,
      "SELECT id,name,checked_at FROM wishlists WHERE manager_id=? ORDER BY created_at,id",
      manager,
    ).all<{ id: string; name: string; checked_at: number | null }>()
  ).results;
}
/** ?list=<id>: one of the owner's lists kept for someone, or null for the personal one. */
async function pickList(db: D1Database, owner: string, raw: unknown) {
  if (raw === null || raw === undefined || raw === "") return null;
  const l = isId(raw)
    ? await stmt(
        db,
        "SELECT id,name,checked_at FROM wishlists WHERE id=? AND manager_id=?",
        raw,
        owner,
      ).first<{ id: string; name: string; checked_at: number | null }>()
    : null;
  if (!l) missing();
  return l;
}
/**
 * A wish a guest link opens: the link works, the wish is in its list and, for a
 * picked set, in the set. Checked again whenever a guest books or loads a photo.
 */
const GUEST_SEES = `SELECT 1 FROM gifts g JOIN guest_links l ON l.owner_id=g.owner_id
  WHERE g.id=?1 AND g.archived_at IS NULL AND l.token_hash=?2 AND l.kind='guest' AND ${LINK_ACTIVE("l", "?3")}
  AND g.list_id IS l.list_id AND (l.picked=0 OR EXISTS(SELECT 1 FROM guest_link_gifts lg WHERE lg.link_id=l.id AND lg.gift_id=g.id))`;
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
  // Only the organizer's own people (followers, people followed); the insert itself checks it.
  const inserted = await db.batch(
    wanted.map((id) =>
      stmt(
        db,
        `INSERT INTO reservation_members(gift_id,user_id,status)
        SELECT ?2,?3,'invited' WHERE ${CONNECTED("?3")} ON CONFLICT DO NOTHING RETURNING user_id`,
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
/** Two people booked at once: the one who was second hears this, not a generic error. */
const TAKEN = "Пока вы смотрели, этот подарок выбрал кто-то другой.";
/** Lists one can keep for people close to them. */
const LIST_LIMIT = 10;
const LIST_PATH = new RegExp(`^/api/lists/(${ACCOUNT_ID_PART})$`);
const PROFILE_PATH = new RegExp(`^/api/profiles/(${ACCOUNT_ID_PART})$`);
const SESSION_DAYS = 30,
  SESSION_LIMIT = 10;
async function sessionUser(db: D1Database, raw: string): Promise<Identity> {
  const u = isToken(raw)
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
    "SELECT id,name,username,birthday,gender,event_title,event_date,allow_resharing,is_private,wishlist_updated_at,checked_at,about,CASE WHEN photo='' THEN NULL ELSE photo_at END AS photo_at FROM users WHERE id=?",
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
    is_private: number;
    wishlist_updated_at: number | null;
    checked_at: number | null;
    about: string | null;
    photo_at: number | null;
  }>();
  if (!p) return null;
  const { gender, event_title: _, event_date: __, is_private, ...rest } = p;
  return {
    ...rest,
    is_private: !!is_private,
    ...(self ? { gender } : {}),
    events: eventSpecs(p),
  };
}
/**
 * What anyone with the profile link sees, even of a closed profile: name, photo,
 * @nick, how many wishes. Plus whether the viewer and this person added each other.
 */
async function card(db: D1Database, id: string, viewer: string | null) {
  const c = await stmt(
    db,
    `SELECT u.id,u.name,u.username,u.is_private,CASE WHEN u.photo='' THEN NULL ELSE u.photo_at END AS photo_at,
      (SELECT COUNT(*) FROM gifts g WHERE g.owner_id=u.id AND g.archived_at IS NULL) AS gift_count,
      (SELECT CASE WHEN u.is_private=0 THEN 'approved' ELSE f.status END FROM follows f WHERE f.follower_id=?2 AND f.target_id=u.id) AS follow,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=u.id AND f.target_id=?2 AND f.status='approved') AS follows_you
    FROM users u WHERE u.id=?1`,
    id,
    viewer || "",
  ).first<PersonRow>();
  return c ? person(c) : null;
}
type PersonRow = {
  id: string;
  name: string;
  username: string | null;
  is_private: number;
  photo_at: number | null;
  gift_count: number;
  follow?: "pending" | "approved" | null;
  follows_you?: number;
};
const person = (r: PersonRow) => ({
  ...r,
  is_private: !!r.is_private,
  follow: r.follow ?? null,
  follows_you: !!r.follows_you,
});
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
    const row = isToken(code)
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
      (method === "POST" && path === "/api/links/resolve") ||
      (method === "GET" &&
        (path === "/api/guest" ||
          /^\/api\/gifts\/[a-f0-9-]{36}\/photo$/.test(path) ||
          AVATAR_PATH.test(path) ||
          // Any profile shows only its card until the person signs in.
          PROFILE_PATH.test(path)))
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
  // A profile photo is part of the public card, like the name.
  const avatar = path.match(AVATAR_PATH);
  if (avatar && method === "GET") {
    const id = avatar[1];
    const p = await stmt(db, "SELECT photo FROM users WHERE id=?", id).first<{
      photo: string;
    }>();
    if (!p?.photo) missing();
    return { photo: p.photo };
  }
  if (path === "/api/guest" && method === "GET") {
    if (!isToken(guest)) missing();
    const link = await stmt(
      db,
      `SELECT l.id,l.owner_id,l.list_id,l.picked,w.name AS list_name,w.checked_at AS list_checked_at
      FROM guest_links l LEFT JOIN wishlists w ON w.id=l.list_id
      WHERE l.token_hash=? AND ${LINK_ACTIVE("l", "?")} AND l.kind='guest'`,
      await hash(guest),
      now(),
    ).first<{
      id: string;
      owner_id: string;
      list_id: string | null;
      picked: number;
      list_name: string | null;
      list_checked_at: number | null;
    }>();
    if (!link) missing();
    // Only this list, and for a picked set only those wishes; never the others.
    const [owner, gifts] = await Promise.all([
      profile(db, link.owner_id, user?.id === link.owner_id),
      list(db, link.owner_id, user, true, {
        list: link.list_id,
        link: link.picked ? link.id : "",
      }),
    ]);
    return {
      owner,
      list: link.list_id
        ? {
            id: link.list_id,
            name: link.list_name,
            checked_at: link.list_checked_at,
          }
        : null,
      gifts,
      invitations: [],
      can_reserve: true,
      is_owner: user?.id === link.owner_id,
    };
  }
  if (path === "/api/links/resolve" && method === "POST") {
    // Old «Поделиться» (s_) and friend invitation (f_) links lead to the owner's profile only.
    await rate(db, `resolve:${user?.id || (await ipKey())}`, 20);
    const raw = (await body(req)).token;
    const valid = isToken(raw);
    const owner = valid
      ? await stmt(
          db,
          `SELECT owner_id FROM guest_links WHERE token_hash=?1 AND kind='telegram' AND revoked_at IS NULL
          UNION ALL SELECT owner_id FROM friend_invites WHERE token_hash=?1 AND revoked_at IS NULL AND expires_at>?2 LIMIT 1`,
          await hash(raw),
          now(),
        ).first<{ owner_id: string }>()
      : null;
    if (!owner) fail(404, "NOT_FOUND", "Ссылка не найдена или отозвана.");
    return { owner_id: owner.owner_id };
  }
  const profileMatch = path.match(PROFILE_PATH);
  if (profileMatch && method === "GET") {
    const c = await card(db, profileMatch[1], user?.id || null);
    if (!c) missing();
    return {
      card: c,
      can_view: await canView(db, c.id, user, guest),
      is_owner: c.id === user?.id,
    };
  }
  const listMatch = path.match(LIST_PATH);
  if (listMatch && method === "GET") {
    const owner = listMatch[1];
    if (!(await canView(db, owner, user, guest))) missing();
    // Whoever sees the owner's list sees every list they keep for someone (П35).
    const chosen = await pickList(db, owner, url.searchParams.get("list"));
    // Access is settled; the reads do not depend on each other.
    const [p, gifts, invited, lists] = await Promise.all([
      profile(db, owner, owner === user?.id),
      list(db, owner, user, false, { list: chosen?.id ?? null }),
      chosen ? [] : invitations(db, owner, user?.id || null),
      managedLists(db, owner),
    ]);
    if (!p) missing();
    return {
      owner: p,
      lists: lists.map(({ id, name }) => ({ id, name })),
      list: chosen,
      gifts,
      invitations: invited,
      is_owner: owner === user?.id,
      can_reserve: !!user && owner !== user.id,
    };
  }
  const guestReservation = path.match(
    /^\/api\/guest-reservations\/([a-f0-9-]{36})(\/cancel)?$/,
  );
  if (guestReservation?.[2] && method === "POST") {
    // Guests cancel with the code their browser got when booking; the owner never manages guest bookings.
    const b = await body(req);
    const code = typeof b.code === "string" ? b.code : "";
    if (!isToken(code)) missing();
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
    if (!isToken(guest)) missing();
    const code = token();
    // The link, its list and its set are checked inside the write itself.
    const result = await stmt(
      db,
      `INSERT INTO reservations(gift_id,guest_name,guest_code_hash)
      SELECT ?1,?4,?5 WHERE EXISTS(${GUEST_SEES}) ON CONFLICT(gift_id) DO NOTHING RETURNING gift_id`,
      guestReservation[1],
      await hash(guest),
      now(),
      name,
      await hash(code),
    ).first();
    if (!result) {
      // Someone was quicker: say so, but only to a holder of a working link.
      const taken = await stmt(
        db,
        `SELECT 1 FROM reservations WHERE gift_id=?1 AND EXISTS(${GUEST_SEES})`,
        guestReservation[1],
        await hash(guest),
        now(),
      ).first();
      if (taken) fail(409, "TAKEN", TAKEN);
      fail(409, "UNAVAILABLE", "Подарок недоступен или ссылка больше не работает.");
    }
    return { ok: true, code };
  }
  if (!user && method === "GET" && path.endsWith("/photo")) {
    const match = path.match(/^\/api\/gifts\/([a-f0-9-]{36})\/photo$/);
    const g =
      match && isToken(guest)
        ? await stmt(
            db,
            `SELECT photo FROM gifts WHERE id=?1 AND EXISTS(${GUEST_SEES})`,
            match[1],
            await hash(guest),
            now(),
          ).first<{ photo: string }>()
        : null;
    if (!g) missing();
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
      // The first-visit tour, until the person fills it in or skips it.
      welcome: !(await stmt(
        db,
        "SELECT welcomed_at FROM users WHERE id=?",
        uid,
      ).first<{ welcomed_at: number | null }>())?.welcomed_at,
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
  if (path === "/api/me/checked" && method === "POST") {
    // «Подтвердить актуальность»: only a list of one's own, and it tells nobody.
    // The list is the one the button belonged to, sent with the request.
    const b = req.headers.get("content-type")?.startsWith("application/json")
      ? await body(req)
      : {};
    const chosen = await pickList(db, uid, b.list_id);
    const at = now();
    if (chosen)
      await stmt(
        db,
        "UPDATE wishlists SET checked_at=? WHERE id=?",
        at,
        chosen.id,
      ).run();
    else await stmt(db, "UPDATE users SET checked_at=? WHERE id=?", at, uid).run();
    return { checked_at: at };
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
    if (b.is_private !== undefined && typeof b.is_private !== "boolean")
      fail(400, "VALIDATION", "Выберите, открытый профиль или закрытый.");
    if (b.welcomed !== undefined && b.welcomed !== true)
      fail(400, "VALIDATION", "Проверьте настройку приветствия.");
    const about =
      b.about === undefined || b.about === null ? b.about : text(b.about, 500);
    const updates = [];
    if (b.is_private !== undefined)
      updates.push(
        stmt(
          db,
          "UPDATE users SET is_private=? WHERE id=?",
          b.is_private ? 1 : 0,
          uid,
        ),
      );
    // An open profile has nothing to approve: waiting requests become followers.
    const approved =
      b.is_private === false
        ? (
            await stmt(
              db,
              "UPDATE follows SET status='approved',approved_at=unixepoch() WHERE target_id=? AND status='pending' RETURNING follower_id",
              uid,
            ).all<{ follower_id: string }>()
          ).results.map((r) => r.follower_id)
        : [];
    for (const id of approved) out.followApproved(user, id);
    if (b.welcomed)
      updates.push(
        stmt(
          db,
          "UPDATE users SET welcomed_at=COALESCE(welcomed_at,?) WHERE id=?",
          now(),
          uid,
        ),
      );
    if (about !== undefined)
      updates.push(
        stmt(db, "UPDATE users SET about=? WHERE id=?", about || null, uid),
      );
    if (b.notify !== undefined)
      updates.push(
        stmt(db, "UPDATE users SET notify=? WHERE id=?", b.notify ? 1 : 0, uid),
      );
    if (b.gender !== undefined)
      // Events already created keep their dates: the profile only feeds the occasions list.
      updates.push(
        stmt(db, "UPDATE users SET gender=? WHERE id=?", b.gender, uid),
      );
    if (b.birthday !== undefined)
      updates.push(
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
    // Every way into the website ends: sessions and unused «В браузере» codes.
    await db.batch([
      stmt(db, "DELETE FROM sessions WHERE user_id=?", uid),
      stmt(db, "DELETE FROM login_handoffs WHERE user_id=?", uid),
    ]);
    return { ok: true };
  }
  // ---- Friends (docs/FOLLOWERS.md) ----
  if (path === "/api/people" && method === "GET") {
    // An open profile has nothing to approve: a request to it is a follow.
    await stmt(
      db,
      `UPDATE follows SET status='approved',approved_at=unixepoch() WHERE status='pending' AND (follower_id=?1 OR target_id=?1)
      AND target_id IN (SELECT id FROM users WHERE is_private=0)`,
      uid,
    ).run();
    // Only the person sees their friends and who added them.
    const rows = (
      await stmt(
        db,
        `SELECT u.id,u.name,u.username,u.is_private,CASE WHEN u.photo='' THEN NULL ELSE u.photo_at END AS photo_at,
          (SELECT COUNT(*) FROM gifts g WHERE g.owner_id=u.id AND g.archived_at IS NULL) AS gift_count,
          (SELECT status FROM follows o WHERE o.follower_id=?1 AND o.target_id=u.id) AS follow,
          EXISTS(SELECT 1 FROM follows i WHERE i.follower_id=u.id AND i.target_id=?1 AND i.status='approved') AS follows_you,
          (SELECT status FROM follows i WHERE i.follower_id=u.id AND i.target_id=?1) AS theirs
        FROM users u WHERE u.id IN (SELECT target_id FROM follows WHERE follower_id=?1 UNION SELECT follower_id FROM follows WHERE target_id=?1)
        ORDER BY u.name,u.id`,
        uid,
      ).all<PersonRow & { theirs: string | null }>()
    ).results;
    const pick = (keep: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(keep).map(({ theirs: _, ...r }) => person(r));
    return {
      // Whom I added: their lists are open to me.
      friends: pick((r) => r.follow === "approved"),
      // Asking to see my closed list.
      requests: pick((r) => r.theirs === "pending"),
      // My requests to closed lists.
      outgoing: pick((r) => r.follow === "pending" && r.theirs !== "pending"),
      // Added me, and I have not added them.
      added_me: pick((r) => !r.follow && r.theirs === "approved"),
    };
  }
  const followMatch = path.match(
    new RegExp(`^/api/follows/(${ACCOUNT_ID_PART})$`),
  );
  if (followMatch && method === "POST") {
    // Add to friends: an open profile at once, a closed one after its owner approves.
    await rate(db, `follow:${uid}`, 20);
    if (followMatch[1] === uid)
      fail(400, "SELF_FOLLOW", "Нельзя добавить в друзья самого себя.");
    const status = await addFriend(db, out, user, followMatch[1]);
    if (status === null) missing();
    return { follow: status };
  }
  if (followMatch && method === "DELETE") {
    // Remove from friends or cancel a request; news about this person stops with it.
    // Bookings stay: the person can still cancel them in «Мои брони».
    // ?revoke=1 also takes my list away from them, silently.
    const them = followMatch[1],
      revoke = url.searchParams.get("revoke") === "1";
    await db.batch([
      stmt(
        db,
        "DELETE FROM follows WHERE follower_id=? AND target_id=?",
        uid,
        them,
      ),
      ...(revoke
        ? [
            stmt(
              db,
              "DELETE FROM follows WHERE follower_id=? AND target_id=?",
              them,
              uid,
            ),
          ]
        : []),
    ]);
    return { follow: null };
  }
  const followerMatch = path.match(
    new RegExp(`^/api/followers/(${ACCOUNT_ID_PART})(/approve)?$`),
  );
  if (followerMatch?.[2] && method === "POST") {
    // {add_back: true}: approve and add the person to my friends too.
    if (
      req.headers.get("content-type")?.startsWith("application/json") &&
      (await body(req)).add_back === true
    ) {
      if ((await follow(db, followerMatch[1], uid)) !== "pending")
        fail(404, "NOT_FOUND", "Запрос не найден.");
      await addFriend(db, out, user, followerMatch[1]);
      return { ok: true };
    }
    const r = await stmt(
      db,
      "UPDATE follows SET status='approved',approved_at=unixepoch() WHERE follower_id=? AND target_id=? AND status='pending' RETURNING follower_id",
      followerMatch[1],
      uid,
    ).first();
    if (!r) fail(404, "NOT_FOUND", "Запрос не найден.");
    out.followApproved(user, followerMatch[1]);
    return { ok: true };
  }
  if (followerMatch && !followerMatch[2] && method === "DELETE") {
    // Decline a request or remove a follower, silently.
    await stmt(
      db,
      "DELETE FROM follows WHERE follower_id=? AND target_id=?",
      followerMatch[1],
      uid,
    ).run();
    return { ok: true };
  }
  // ---- Lists and gifts ----
  if (path === "/api/archive" && method === "GET") {
    const chosen = await pickList(db, uid, url.searchParams.get("list"));
    return {
      owner: await profile(db, uid, true),
      list: chosen,
      gifts: (
        await stmt(
          db,
          `SELECT ${giftColumns},g.archived_at,g.archive_reason FROM gifts g WHERE g.owner_id=? AND g.list_id IS ? AND g.archived_at IS NOT NULL ORDER BY g.archived_at DESC,g.id`,
          uid,
          chosen?.id ?? null,
        ).all()
      ).results,
    };
  }
  if (path === "/api/wishlists" && method === "POST") {
    // «Добавить вишлист близкого»: a name is all it takes; access is the same as mine.
    await rate(db, `wishlists:${uid}`, 10);
    const name = text((await body(req)).name, 60).trim();
    if (!name) fail(400, "VALIDATION", "Введите имя.");
    if ((await managedLists(db, uid)).length >= LIST_LIMIT)
      fail(409, "LIST_LIMIT", `Можно вести до ${LIST_LIMIT} вишлистов близких.`);
    const id = crypto.randomUUID();
    await stmt(
      db,
      "INSERT INTO wishlists(id,manager_id,name) VALUES(?,?,?)",
      id,
      uid,
      name,
    ).run();
    return { list: { id, name, checked_at: null } };
  }
  if (path === "/api/gifts" && method === "POST") {
    const b = await body(req);
    // A wish goes to the list chosen when the form opened, mine or one I keep.
    const chosen = await pickList(db, uid, b.list_id);
    return {
      id: await createGift(db, user, giftInput(b), {
        archived: b.archived === true,
        list: chosen?.id ?? null,
      }),
    };
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
    // The whole list, or this wish as one an event picked for its guests.
    const seesGift = async () =>
      (await canView(db, g.owner_id, user, guest)) ||
      !!(await stmt(
        db,
        `SELECT 1 WHERE ${EVENT_GIFT("?1", "?2", "?3")}`,
        uid,
        g.id,
        g.owner_id,
      ).first());
    if (giftMatch[2] === "/photo" && method === "GET") {
      if (g.owner_id !== uid && g.archived_at !== null) missing();
      if (!(await seesGift())) missing();
      return {
        photo:
          (
            await stmt(db, "SELECT photo FROM gifts WHERE id=?", id).first<{
              photo: string;
            }>()
          )?.photo || "",
      };
    }
    if (giftMatch[2] === "/photo" && method === "PUT") {
      // The bot saves a shop's photo as a link (the server cannot shrink it); the
      // owner's app swaps it for the photo itself, compressed in the browser.
      if (g.owner_id !== uid) missing();
      const b = await body(req);
      const photo = text(b.photo, 220000),
        from = text(b.from, 2048);
      if (!PHOTO_DATA_URL.test(photo) || !/^https:\/\//.test(from))
        fail(400, "VALIDATION", "Некорректное фото.");
      const before = await stmt(
        db,
        "SELECT wishlist_updated_at FROM users WHERE id=?",
        uid,
      ).first<{ wishlist_updated_at: number | null }>();
      // Only while the link is still there: an edit made meanwhile wins.
      // The same picture, so «вишлист обновлён» keeps its date.
      const [swap] = await db.batch([
        stmt(
          db,
          "UPDATE gifts SET photo=? WHERE id=? AND owner_id=? AND photo=?",
          photo,
          id,
          uid,
          from,
        ),
        stmt(
          db,
          "UPDATE users SET wishlist_updated_at=? WHERE id=?",
          before?.wishlist_updated_at ?? null,
          uid,
        ),
      ]);
      return { replaced: swap.meta.changes > 0 };
    }
    if (giftMatch[2] === "/restore" && method === "POST") {
      if (g.owner_id !== uid) missing();
      await restoreGift(db, user, id);
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
        const b = await body(req);
        const v = giftInput(b);
        // keep_photo: the form saved before the photo it had finished loading.
        const keepPhoto = b.keep_photo === true ? 1 : 0;
        const before = await ownGift(db, uid, id);
        await stmt(
          db,
          "UPDATE gifts SET title=?1,price_minor=?2,price_max_minor=?3,price_range=?4,currency=?5,shop_url=?6,description=?7,hearts=?8,priority=?9,photo=CASE WHEN ?13 THEN photo ELSE ?10 END,updated_at=unixepoch() WHERE id=?11 AND owner_id=?12",
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
          keepPhoto,
        ).run();
        if (before)
          await giftChanged(db, out, user, before, await ownGift(db, uid, id));
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
      if (g.archived_at !== null || !(await seesGift())) missing();
      const b = req.headers.get("content-type")?.startsWith("application/json")
        ? await body(req)
        : {};
      // Access is rechecked INSIDE the atomic write; revocation/unfollowing cannot race this insert.
      const guestHash = isToken(guest) ? await hash(guest) : "";
      const r = await stmt(
        db,
        `INSERT INTO reservations(gift_id,user_id)
        SELECT id,?1 FROM gifts WHERE id=?2 AND owner_id<>?1 AND archived_at IS NULL AND (
          ${SEES("gifts.owner_id")}
          OR ${PARTY_PEER("?1", "gifts.owner_id")}
          OR ${EVENT_GIFT("?1", "gifts.id", "gifts.owner_id")}
          OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=gifts.owner_id AND l.token_hash=?3 AND ${LINK_ACTIVE("l", "?4")})
        ) ON CONFLICT(gift_id) DO NOTHING RETURNING gift_id`,
        uid,
        id,
        guestHash,
        now(),
      ).first();
      if (!r) {
        // Access was checked just above; a booking in the way means someone was quicker.
        const taken = await stmt(
          db,
          "SELECT 1 FROM reservations WHERE gift_id=?",
          id,
        ).first();
        if (taken) fail(409, "TAKEN", TAKEN);
        fail(409, "UNAVAILABLE", "Подарок больше недоступен. Обновите список.");
      }
      // «Подарить вместе»: invite friends right away.
      const invited = b.friends
        ? await inviteFriends(db, out, user, id, b.friends)
        : [];
      return { ok: true, invited };
    }
  }
  const recordMatch = path.match(
    /^\/api\/reservations\/([a-f0-9-]{36})\/(gifted|seen|photo|hide)$/,
  );
  if (recordMatch) {
    const [, id, action] = recordMatch;
    if (action === "photo" && method === "GET") {
      // The photo kept with my own record, after the wish itself is gone.
      const r = await stmt(
        db,
        "SELECT photo FROM giver_records WHERE user_id=? AND gift_id=? AND photo<>''",
        uid,
        id,
      ).first<{ photo: string }>();
      if (!r) missing();
      return { photo: r.photo };
    }
    if (method !== "POST") missing();
    if (action === "seen") {
      // «Понятно» after the owner changed the gift.
      await stmt(
        db,
        `UPDATE reservations SET changed_at=NULL,changed_fields=NULL WHERE gift_id=?1
        AND (user_id=?2 OR EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=?1 AND m.user_id=?2 AND m.status='joined'))`,
        id,
        uid,
      ).run();
      return { ok: true };
    }
    if (action === "hide") {
      // «Удалить у меня»: only my closed card; the wish and other givers stay as they are.
      const r = await stmt(
        db,
        "UPDATE giver_records SET hidden_at=? WHERE user_id=? AND gift_id=? AND gifted_at IS NULL AND hidden_at IS NULL RETURNING gift_id",
        now(),
        uid,
        id,
      ).first();
      if (!r) missing();
      return { ok: true };
    }
    // «Подарено» / «Это подарил я»: only the giver moves it to «Подаренные». From an
    // active booking the wish stays taken; it is not archived for the owner.
    const r = await stmt(
      db,
      `INSERT INTO giver_records(user_id,gift_id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,photo,gifted_at)
      SELECT ?1,g.id,g.owner_id,g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.shop_url,g.photo,?3
      FROM gifts g JOIN reservations r ON r.gift_id=g.id WHERE g.id=?2 AND g.archived_at IS NULL
        AND (r.user_id=?1 OR EXISTS(SELECT 1 FROM reservation_members m WHERE m.gift_id=g.id AND m.user_id=?1 AND m.status='joined'))
      ON CONFLICT(user_id,gift_id) DO UPDATE SET gifted_at=excluded.gifted_at WHERE giver_records.gifted_at IS NULL
      RETURNING gift_id`,
      uid,
      id,
      now(),
    ).first();
    const fromCard = r
      ? r
      : await stmt(
          db,
          "UPDATE giver_records SET gifted_at=? WHERE user_id=? AND gift_id=? AND reason='gifted' AND gifted_at IS NULL AND hidden_at IS NULL RETURNING gift_id",
          now(),
          uid,
          id,
        ).first();
    // Pressed twice: already in «Подаренные», nothing doubles.
    if (
      !fromCard &&
      !(await stmt(
        db,
        "SELECT 1 FROM giver_records WHERE user_id=? AND gift_id=? AND gifted_at IS NOT NULL",
        uid,
        id,
      ).first())
    )
      missing();
    return { ok: true };
  }
  if (path === "/api/reservations" && method === "GET") {
    // Metadata available only while the viewer still has access (or was invited). Cancellation needs only gift ID.
    const rows = (
      await stmt(
        db,
        `SELECT r.gift_id,
        CASE WHEN r.user_id=?1 THEN 'organizer' ELSE m.status END AS role,
        CASE WHEN m.user_id IS NOT NULL OR ${SEES("g.owner_id")} OR ${PARTY_PEER("?1", "g.owner_id")} OR ${EVENT_GIFT("?1", "g.id", "g.owner_id")} OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=g.owner_id AND ${LINK_ACTIVE("l", "?2")}) THEN 1 ELSE 0 END AS visible,
        g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.shop_url,g.owner_id,org.name AS organizer_name,
        COALESCE(wl.name,ou.name) AS owner_name,
        CASE WHEN ou.photo='' OR wl.id IS NOT NULL THEN NULL ELSE ou.photo_at END AS owner_photo_at,
        CASE WHEN g.photo='' THEN 0 ELSE 1 END AS has_photo,g.updated_at,r.changed_fields,
        ou.birthday,ou.gender,ou.event_title,ou.event_date,
        CASE WHEN g.archived_at IS NULL THEN 0 ELSE 1 END AS archived
      FROM reservations r JOIN gifts g ON g.id=r.gift_id JOIN users ou ON ou.id=g.owner_id
      LEFT JOIN wishlists wl ON wl.id=g.list_id
      LEFT JOIN users org ON org.id=r.user_id
      LEFT JOIN reservation_members m ON m.gift_id=r.gift_id AND m.user_id=?1
      WHERE (r.user_id=?1 OR m.user_id IS NOT NULL) AND g.owner_id<>?1
        AND NOT EXISTS(SELECT 1 FROM giver_records gr WHERE gr.user_id=?1 AND gr.gift_id=r.gift_id AND gr.gifted_at IS NOT NULL)
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
    // My own records: cards the owner closed («Требует внимания») and what I gave.
    const records = (
      await stmt(
        db,
        `SELECT gr.gift_id,gr.owner_id,COALESCE(gr.list_name,u.name) AS owner_name,
          CASE WHEN u.photo='' OR gr.list_name IS NOT NULL THEN NULL ELSE u.photo_at END AS owner_photo_at,
          gr.title,gr.price_minor,gr.price_max_minor,gr.price_range,gr.currency,gr.shop_url,
          CASE WHEN gr.photo='' THEN 0 ELSE 1 END AS has_photo,gr.reason,gr.changed_at,gr.gifted_at
        FROM giver_records gr JOIN users u ON u.id=gr.owner_id
        WHERE gr.user_id=? AND gr.hidden_at IS NULL
        ORDER BY COALESCE(gr.gifted_at,gr.changed_at) DESC`,
        uid,
      ).all<Record<string, unknown>>()
    ).results;
    return {
      attention: records.filter((r) => r.gifted_at === null),
      given: records.filter((r) => r.gifted_at !== null),
      reservations: rows.map(
        ({ visible, birthday, gender, event_title, event_date, ...r }) => ({
          ...r,
          my_events: visible
            ? mine
                .filter((e) => e.owner_id === r.owner_id)
                .map(({ id, title, date }) => ({ id, title, date }))
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
                shop_url: "",
                has_photo: 0,
                changed_fields: null,
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
  if (path === "/api/guest-links" && (method === "GET" || method === "POST")) {
    // «Поделиться»: the profile link (gives no access by itself) and the owner's
    // guest links, one per list or picked set (П30). GET only reads; a guest link
    // is made by POST, when the owner shares it.
    const b =
      method === "POST" &&
      req.headers.get("content-type")?.startsWith("application/json")
        ? await body(req)
        : {};
    const chosen = await pickList(
      db,
      uid,
      method === "POST" ? b.list_id : url.searchParams.get("list"),
    );
    const listId = chosen?.id ?? null;
    let made: { id: string; token_value: string } | null = null;
    const whole = () =>
      stmt(
        db,
        "SELECT id,token_value FROM guest_links WHERE owner_id=?1 AND created_by=?1 AND kind='guest' AND list_id IS ?2 AND picked=0 AND revoked_at IS NULL AND token_value IS NOT NULL LIMIT 1",
        uid,
        listId,
      ).first<{ id: string; token_value: string }>();
    if (method === "POST") {
      await rate(db, `links:${uid}`, 5);
      const raw = token();
      const id = crypto.randomUUID();
      if (Array.isArray(b.gift_ids)) {
        // A picked set: its own link. Only active wishes of this list count; an
        // empty set opens nothing rather than the whole list.
        const ids = b.gift_ids.filter(isId).slice(0, 100);
        await db.batch([
          stmt(
            db,
            `INSERT INTO guest_links(id,owner_id,created_by,token_hash,expires_at,kind,token_value,list_id,picked)
            VALUES(?1,?2,?2,?3,253402300799,'guest',?4,?5,1)`,
            id,
            uid,
            await hash(raw),
            raw,
            listId,
          ),
          ...ids.map((g: string) =>
            stmt(
              db,
              `INSERT OR IGNORE INTO guest_link_gifts(link_id,gift_id)
              SELECT ?1,id FROM gifts WHERE id=?2 AND owner_id=?3 AND list_id IS ?4 AND archived_at IS NULL`,
              id,
              g,
              uid,
              listId,
            ),
          ),
        ]);
        made = { id, token_value: raw };
      } else {
        await stmt(
          db,
          `INSERT OR IGNORE INTO guest_links(id,owner_id,created_by,token_hash,expires_at,kind,token_value,list_id)
          VALUES(?1,?2,?2,?3,253402300799,'guest',?4,?5)`,
          id,
          uid,
          await hash(raw),
          raw,
          listId,
        ).run();
        made = await whole();
      }
    }
    const site = https(env.APP_URL);
    const all = (
      await stmt(
        db,
        `SELECT l.id,l.token_value,l.list_id,l.picked,w.name AS list_name,
          (SELECT COUNT(*) FROM guest_link_gifts lg JOIN gifts g ON g.id=lg.gift_id WHERE lg.link_id=l.id AND g.archived_at IS NULL) AS count
        FROM guest_links l LEFT JOIN wishlists w ON w.id=l.list_id
        WHERE l.owner_id=?1 AND l.created_by=?1 AND l.kind='guest' AND l.revoked_at IS NULL AND l.token_value IS NOT NULL
        ORDER BY l.list_id IS NOT NULL,w.created_at,l.picked,l.created_at`,
        uid,
      ).all<{
        id: string;
        token_value: string;
        list_id: string | null;
        picked: number;
        list_name: string | null;
        count: number;
      }>()
    ).results.map((l) => ({
      id: l.id,
      kind: "guest",
      list_id: l.list_id,
      list_name: l.list_name,
      picked: !!l.picked,
      count: l.picked ? l.count : null,
      web_url: `${site}#guest=${l.token_value}`,
    }));
    const current = made || (await whole());
    return {
      // A link to the site; without signing in it shows only the card.
      profile_url: siteProfileLink(site, uid, listId),
      links: all,
      legacy_links: (
        await stmt(
          db,
          "SELECT id FROM guest_links WHERE owner_id=? AND kind='guest' AND token_value IS NULL AND revoked_at IS NULL AND expires_at>?",
          uid,
          now(),
        ).all()
      ).results,
      // The link this answer is about: just made, or the whole list's one.
      id: current?.id,
      token: current?.token_value,
      web_url: current ? `${site}#guest=${current.token_value}` : undefined,
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
    (owner, viewer, event) =>
      list(db, owner, viewer, false, { list: null, event: event || "" }),
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
        // Long past events go; bookings never depended on them.
        "DELETE FROM events WHERE MAX(actual_on,celebrate_on)<date('now','-30 days')",
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
