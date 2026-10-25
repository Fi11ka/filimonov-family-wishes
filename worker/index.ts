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
import { lookupProduct } from "./shops";
export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  APP_ORIGIN: string;
  APP_URL: string;
}
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
const ACTIVE_LIMIT = 100,
  ARCHIVE_LIMIT = 300;
const giftColumns =
  "g.id,g.owner_id,g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.shop_url,g.description,g.priority,CASE WHEN g.photo='' THEN 0 ELSE 1 END AS has_photo,g.created_at,g.updated_at";
// Accepted friendship between ?1 and the gift owner column, in either order.
const FRIEND_OF = (owner: string) =>
  `EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.user_a=?1 AND f.user_b=${owner}) OR (f.user_b=?1 AND f.user_a=${owner})))`;
const now = () => Math.floor(Date.now() / 1000);
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
function stmt(db: D1Database, sql: string, ...args: unknown[]) {
  return db.prepare(sql).bind(...args);
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
/** Friendship rows store the pair ordered (user_a < user_b). */
const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
async function friendship(db: D1Database, x: string, y: string) {
  const [a, b] = pair(x, y);
  return stmt(
    db,
    "SELECT status,requested_by FROM friendships WHERE user_a=? AND user_b=?",
    a,
    b,
  ).first<{ status: "pending" | "accepted"; requested_by: string }>();
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
  if (guest && /^[A-Za-z0-9_-]{43}$/.test(guest))
    return !!(await stmt(
      db,
      "SELECT 1 AS ok FROM guest_links WHERE owner_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>? AND (kind='guest' OR ? IS NOT NULL)",
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
        `SELECT ${giftColumns} FROM gifts g WHERE g.owner_id=? AND g.archived_at IS NULL ORDER BY g.priority DESC,g.created_at DESC,g.id`,
        owner,
      ).all<Gift>()
    ).results;
  const r = await stmt(
    db,
    `SELECT ${giftColumns},CASE WHEN r.gift_id IS NULL THEN 'available' WHEN r.user_id=? THEN 'mine' ELSE 'reserved' END AS reservation FROM gifts g LEFT JOIN reservations r ON r.gift_id=g.id WHERE g.owner_id=? AND g.archived_at IS NULL ORDER BY g.priority DESC,g.created_at DESC,g.id`,
    guestView ? "" : user?.id || "",
    owner,
  ).all();
  return r.results;
}
async function reservationDetails(db: D1Database, id: string) {
  return stmt(
    db,
    `SELECT r.user_id,r.guest_name,r.created_at,COALESCE(u.name,r.guest_name) AS name,u.username FROM reservations r LEFT JOIN users u ON u.id=r.user_id WHERE r.gift_id=?`,
    id,
  ).first<{
    user_id: string | null;
    guest_name: string | null;
    created_at: number;
    name: string;
    username: string | null;
  }>();
}
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
async function saveUser(db: D1Database, user: Identity) {
  await db.batch([
    // A Telegram username can move to another account; the newest owner keeps it.
    ...(user.username
      ? [
          stmt(
            db,
            "UPDATE users SET username=NULL WHERE username=? AND id<>?",
            user.username,
            user.id,
          ),
        ]
      : []),
    stmt(
      db,
      `INSERT INTO users(id,name,username) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username WHERE name<>excluded.name OR username IS NOT excluded.username`,
      user.id,
      user.name,
      user.username,
    ),
  ]);
}
function profile(db: D1Database, id: string) {
  return stmt(db, "SELECT id,name,username FROM users WHERE id=?", id).first<{
    id: string;
    name: string;
    username: string | null;
  }>();
}
async function activeCount(db: D1Database, uid: string, archived: boolean) {
  return (
    (
      await stmt(
        db,
        `SELECT COUNT(*) AS n FROM gifts WHERE owner_id=? AND archived_at IS ${archived ? "NOT " : ""}NULL`,
        uid,
      ).first<{ n: number }>()
    )?.n || 0
  );
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
async function route(req: Request, env: Env): Promise<unknown> {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method,
    db = env.DB;
  if (path === "/api/health" && method === "GET")
    return { ok: true, service: "Filimonov Family Wishes" };
  if (!env.BOT_TOKEN)
    fail(503, "NOT_CONFIGURED", "Приложение ещё настраивается.");
  const auth = req.headers.get("authorization");
  // Mini App: signed initData on every request. Website: a session token issued
  // after Telegram Login (OpenID Connect), looked up by its SHA-256.
  const session = auth?.startsWith("Session ") ? auth.slice(8) : "";
  const user = !auth
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
    await saveUser(db, identity);
    return createSession(db, identity);
  }
  if (
    !user &&
    !(
      (method === "POST" &&
        /^\/api\/guest-reservations\/[a-f0-9-]{36}$/.test(path)) ||
      (method === "GET" &&
        (path === "/api/guest" ||
          /^\/api\/gifts\/[a-f0-9-]{36}\/photo$/.test(path)))
    )
  )
    fail(401, "AUTH_REQUIRED", "Откройте приложение через Telegram.");
  // No raw auth data, guest token, IP, or reservation identity in logs.
  const rateKey = user
    ? `u:${user.id}`
    : `ip:${await hash(req.headers.get("cf-connecting-ip") || "local")}`;
  await rate(db, rateKey, user ? 240 : 120);
  // Session identities come from the users table; only signed Telegram data updates it.
  if (user && !session) await saveUser(db, user);
  if (path === "/api/guest" && method === "GET") {
    if (!guest || !/^[A-Za-z0-9_-]{43}$/.test(guest)) missing();
    const link = await stmt(
      db,
      "SELECT owner_id,kind FROM guest_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND (kind='guest' OR ? IS NOT NULL)",
      await hash(guest),
      now(),
      user?.id || null,
    ).first<{ owner_id: string; kind: string }>();
    if (!link) missing();
    return {
      owner: await profile(db, link.owner_id),
      gifts: await list(db, link.owner_id, user, link.kind === "guest"),
      can_reserve:
        link.kind === "guest" || (!!user && user.id !== link.owner_id),
      is_owner: user?.id === link.owner_id,
    };
  }
  const guestReservation = path.match(
    /^\/api\/guest-reservations\/([a-f0-9-]{36})$/,
  );
  if (guestReservation && method === "POST") {
    const b = await body(req);
    const name = text(b.name, 80);
    if (!name)
      fail(400, "VALIDATION", "Введите имя того, кто покупает подарок.");
    if (!guest || !/^[A-Za-z0-9_-]{43}$/.test(guest)) missing();
    const result = await stmt(
      db,
      `INSERT INTO reservations(gift_id,guest_name)
      SELECT g.id,? FROM gifts g JOIN guest_links l ON l.owner_id=g.owner_id
      WHERE g.id=? AND g.archived_at IS NULL AND l.token_hash=? AND l.kind='guest'
      AND l.revoked_at IS NULL AND l.expires_at>? ON CONFLICT(gift_id) DO NOTHING RETURNING gift_id`,
      name,
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
    return { ok: true };
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
  if (path === "/api/me" && method === "GET")
    return {
      user: { id: uid, name: user.name, username: user.username },
      web_session: !!session,
    };
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
        `SELECT u.id,u.name,u.username,f.status,f.requested_by,
          (SELECT COUNT(*) FROM gifts g WHERE g.owner_id=u.id AND g.archived_at IS NULL) AS gift_count
        FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=?1 THEN f.user_b ELSE f.user_a END
        WHERE f.user_a=?1 OR f.user_b=?1 ORDER BY u.name,u.id`,
        uid,
      ).all<{
        id: string;
        name: string;
        username: string | null;
        status: string;
        requested_by: string;
        gift_count: number;
      }>()
    ).results;
    const view = ({
      id,
      name,
      username,
      gift_count,
    }: (typeof rows)[number]) => ({
      id,
      name,
      username,
      gift_count,
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
    if (
      !username &&
      !(typeof b.user_id === "string" && /^\d+$/.test(b.user_id))
    )
      fail(
        400,
        "VALIDATION",
        "Введите ник Telegram, например @anna_filimonova.",
      );
    const target = await stmt(
      db,
      "SELECT id FROM users WHERE username=? OR id=?",
      username,
      typeof b.user_id === "string" ? b.user_id : "",
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
      return { status: "accepted" };
    }
    await stmt(
      db,
      "INSERT INTO friendships(user_a,user_b,status,requested_by) VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING",
      a,
      bId,
      uid,
    ).run();
    return { status: "pending" };
  }
  const friendMatch = path.match(/^\/api\/friends\/(\d+)(\/accept)?$/);
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
      return { ok: true };
    }
    if (!friendMatch[2] && method === "DELETE") {
      // Decline, cancel or unfriend. Their reservations stay; they can cancel them.
      await stmt(
        db,
        "DELETE FROM friendships WHERE user_a=? AND user_b=?",
        a,
        b,
      ).run();
      return { ok: true };
    }
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
    const invite = await stmt(
      db,
      "SELECT owner_id FROM friend_invites WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
      await hash(raw),
      now(),
    ).first<{ owner_id: string }>();
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
  const listMatch = path.match(/^\/api\/lists\/(\d+)$/);
  if (listMatch && method === "GET") {
    const owner = listMatch[1];
    if (!(await canView(db, owner, user, guest))) missing();
    const p = await profile(db, owner);
    if (!p) missing();
    return {
      owner: p,
      gifts: await list(db, owner, user),
      is_owner: owner === uid,
      can_reserve: owner !== uid,
    };
  }
  if (path === "/api/archive" && method === "GET")
    return {
      gifts: (
        await stmt(
          db,
          `SELECT ${giftColumns},g.archived_at,g.archive_reason,g.gifted_by_name,g.gifted_by_username FROM gifts g WHERE g.owner_id=? AND g.archived_at IS NOT NULL ORDER BY g.archived_at DESC,g.id`,
          uid,
        ).all()
      ).results,
    };
  if (path === "/api/gifts" && method === "POST") {
    const b = await body(req);
    const g = giftInput(b),
      archived = b.archived === true;
    if (
      (await activeCount(db, uid, archived)) >=
      (archived ? ARCHIVE_LIMIT : ACTIVE_LIMIT)
    )
      fail(
        409,
        "GIFT_LIMIT",
        archived
          ? `В архиве может быть не больше ${ARCHIVE_LIMIT} подарков.`
          : `В списке может быть не больше ${ACTIVE_LIMIT} желаний.`,
      );
    const id = crypto.randomUUID();
    await stmt(
      db,
      "INSERT INTO gifts(id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,description,priority,photo,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      uid,
      g.title,
      g.price_minor,
      g.price_max_minor,
      g.price_range,
      g.currency,
      g.shop_url,
      g.description,
      g.priority,
      g.photo,
      archived ? now() : null,
    ).run();
    return { id };
  }
  const giftMatch = path.match(
    /^\/api\/gifts\/([a-f0-9-]{36})(\/reservation|\/photo|\/archive|\/restore|\/archive-status|\/archive-donor)?$/,
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
    if (
      (giftMatch[2] === "/archive-status" ||
        giftMatch[2] === "/archive-donor") &&
      method === "GET"
    ) {
      if (g.owner_id !== uid || g.archived_at !== null) missing();
      const reservation = await reservationDetails(db, id);
      if (giftMatch[2] === "/archive-status")
        return { reserved: !!reservation };
      return {
        donor: reservation
          ? {
              name: reservation.name,
              username: reservation.username,
              is_guest: reservation.user_id === null,
            }
          : null,
        confirmation: reservation
          ? await hash(JSON.stringify({ gift_id: id, ...reservation }))
          : null,
      };
    }
    if (
      (giftMatch[2] === "/archive" || giftMatch[2] === "/restore") &&
      method === "POST"
    ) {
      if (g.owner_id !== uid) missing();
      const toArchive = giftMatch[2] === "/archive";
      if (
        (g.archived_at !== null) !== toArchive &&
        (await activeCount(db, uid, toArchive)) >=
          (toArchive ? ARCHIVE_LIMIT : ACTIVE_LIMIT)
      )
        fail(
          409,
          "GIFT_LIMIT",
          toArchive
            ? `В архиве может быть не больше ${ARCHIVE_LIMIT} подарков.`
            : `В списке может быть не больше ${ACTIVE_LIMIT} желаний.`,
        );
      if (!toArchive) {
        await stmt(
          db,
          "UPDATE gifts SET archived_at=NULL,archive_reason=NULL,gifted_by_name=NULL,gifted_by_username=NULL,updated_at=unixepoch() WHERE id=? AND owner_id=?",
          id,
          uid,
        ).run();
        return { ok: true };
      }
      const b = req.headers.get("content-type")?.startsWith("application/json")
        ? await body(req)
        : {};
      const reason = b.reason ?? "bought_self";
      if (!["changed_mind", "gifted", "bought_self"].includes(String(reason)))
        fail(400, "VALIDATION", "Выберите причину переноса в архив.");
      if (g.archived_at !== null) return { ok: true };
      const reservation = await reservationDetails(db, id);
      if (reservation && reason !== "gifted")
        fail(
          409,
          "ARCHIVE_RESERVED",
          "Этот подарок уже выбран. Подтвердите получение в варианте «Подарили» или сначала попросите отменить бронь.",
        );
      if (
        reservation &&
        b.confirmation !==
          (await hash(JSON.stringify({ gift_id: id, ...reservation })))
      )
        fail(
          409,
          "DONOR_CONFIRMATION",
          "Подтвердите имя дарителя. Если данные изменились, откройте подтверждение заново.",
        );
      // Recheck the exact reservation inside the archive write so a new booking cannot race it.
      const filter = reservation
        ? "EXISTS(SELECT 1 FROM reservations WHERE gift_id=gifts.id AND user_id IS ? AND guest_name IS ? AND created_at=?)"
        : "NOT EXISTS(SELECT 1 FROM reservations WHERE gift_id=gifts.id)";
      const result = await stmt(
        db,
        `UPDATE gifts SET archived_at=unixepoch(),archive_reason=?,gifted_by_name=?,gifted_by_username=?,updated_at=unixepoch() WHERE id=? AND owner_id=? AND archived_at IS NULL AND ${filter} RETURNING id`,
        reason,
        reason === "gifted" ? reservation?.name || null : null,
        reason === "gifted" ? reservation?.username || null : null,
        id,
        uid,
        ...(reservation
          ? [
              reservation.user_id,
              reservation.guest_name,
              reservation.created_at,
            ]
          : []),
      ).first();
      if (!result)
        fail(
          409,
          "ARCHIVE_CHANGED",
          "Бронь изменилась. Откройте перенос в архив заново.",
        );
      return { ok: true };
    }

    if (!giftMatch[2] && (method === "PUT" || method === "DELETE")) {
      if (g.owner_id !== uid) missing();
      if (method === "PUT") {
        const v = giftInput(await body(req));
        await stmt(
          db,
          "UPDATE gifts SET title=?,price_minor=?,price_max_minor=?,price_range=?,currency=?,shop_url=?,description=?,priority=?,photo=?,updated_at=unixepoch() WHERE id=? AND owner_id=?",
          v.title,
          v.price_minor,
          v.price_max_minor,
          v.price_range,
          v.currency,
          v.shop_url,
          v.description,
          v.priority,
          v.photo,
          id,
          uid,
        ).run();
      } else
        await stmt(
          db,
          "DELETE FROM gifts WHERE id=? AND owner_id=?",
          id,
          uid,
        ).run();
      return { ok: true }; // Identical response whether reserved or available. No reservation-dependent errors.
    }
    if (
      giftMatch[2] === "/reservation" &&
      (method === "POST" || method === "DELETE")
    ) {
      // Reject owner BEFORE any reservation read, including cancel attempts.
      if (g.owner_id === uid)
        fail(
          403,
          "SELF_RESERVATION",
          "Нельзя бронировать собственные подарки.",
        );
      // Cancelling one's own reservation is allowed even after a link expires or unfriending.
      if (method === "DELETE") {
        await stmt(
          db,
          "DELETE FROM reservations WHERE gift_id=? AND user_id=?",
          id,
          uid,
        ).run();
        return { ok: true };
      }
      if (
        g.archived_at !== null ||
        !(await canView(db, g.owner_id, user, guest))
      )
        missing();
      // Access is rechecked INSIDE the atomic write; revocation/unfriending cannot race this insert.
      const guestHash =
        guest && /^[A-Za-z0-9_-]{43}$/.test(guest) ? await hash(guest) : "";
      const r = await stmt(
        db,
        `INSERT INTO reservations(gift_id,user_id)
        SELECT id,?1 FROM gifts WHERE id=?2 AND owner_id<>?1 AND archived_at IS NULL AND (
          ${FRIEND_OF("gifts.owner_id")}
          OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=gifts.owner_id AND l.token_hash=?3 AND l.revoked_at IS NULL AND l.expires_at>?4)
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
      return { ok: true };
    }
  }
  if (path === "/api/reservations" && method === "GET") {
    // Metadata available only while the viewer still has access. Cancellation needs only gift ID.
    const r = await stmt(
      db,
      `SELECT r.gift_id,
        CASE WHEN ${FRIEND_OF("g.owner_id")} OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=g.owner_id AND l.revoked_at IS NULL AND l.expires_at>?2) THEN g.title ELSE 'Подарок из закрытого списка' END AS title,
        CASE WHEN g.archived_at IS NULL THEN 0 ELSE 1 END AS archived
      FROM reservations r JOIN gifts g ON g.id=r.gift_id WHERE r.user_id=?1 AND g.owner_id<>?1`,
      uid,
      now(),
    ).all();
    return { reservations: r.results };
  }
  if (path === "/api/guest-bookings" && method === "GET") {
    return {
      reservations: (
        await stmt(
          db,
          `SELECT r.gift_id,r.guest_name,g.title FROM reservations r JOIN gifts g ON g.id=r.gift_id WHERE g.owner_id=? AND r.user_id IS NULL ORDER BY r.created_at DESC`,
          uid,
        ).all()
      ).results,
    };
  }
  const manageGuest = path.match(/^\/api\/guest-bookings\/([a-f0-9-]{36})$/);
  if (manageGuest && (method === "PATCH" || method === "DELETE")) {
    const filter =
      "gift_id=? AND user_id IS NULL AND EXISTS(SELECT 1 FROM gifts WHERE id=reservations.gift_id AND owner_id=?)";
    if (method === "DELETE")
      await stmt(
        db,
        `DELETE FROM reservations WHERE ${filter}`,
        manageGuest[1],
        uid,
      ).run();
    else {
      const name = text((await body(req)).name, 80);
      if (!name) fail(400, "VALIDATION", "Введите имя.");
      await stmt(
        db,
        `UPDATE reservations SET guest_name=? WHERE ${filter}`,
        name,
        manageGuest[1],
        uid,
      ).run();
    }
    return { ok: true };
  }
  if (path === "/api/guest-links" && (method === "GET" || method === "POST")) {
    if (method === "POST") await rate(db, `links:${uid}`, 5);
    const links = [];
    for (const kind of ["telegram", "guest"]) {
      let link = await stmt(
        db,
        "SELECT id,token_value FROM guest_links WHERE owner_id=? AND kind=? AND revoked_at IS NULL AND token_value IS NOT NULL LIMIT 1",
        uid,
        kind,
      ).first<{ id: string; token_value: string }>();
      if (!link && method === "GET") continue;
      if (!link) {
        const raw = token(),
          id = crypto.randomUUID();
        await stmt(
          db,
          "INSERT OR IGNORE INTO guest_links(id,owner_id,token_hash,expires_at,kind,token_value) VALUES(?,?,?,253402300799,?,?)",
          id,
          uid,
          await hash(raw),
          kind,
          raw,
        ).run();
        link = await stmt(
          db,
          "SELECT id,token_value FROM guest_links WHERE owner_id=? AND kind=? AND revoked_at IS NULL AND token_value IS NOT NULL",
          uid,
          kind,
        ).first<{ id: string; token_value: string }>();
        if (!link) missing();
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
    const guestLink = links.find((l) => l.kind === "guest")!;
    return {
      links,
      legacy_links: (
        await stmt(
          db,
          "SELECT id FROM guest_links WHERE owner_id=? AND token_value IS NULL AND revoked_at IS NULL AND expires_at>?",
          uid,
          now(),
        ).all()
      ).results,
      id: guestLink?.id,
      token: guestLink?.web_url.split("#guest=")[1],
    };
  }
  const linkMatch = path.match(/^\/api\/guest-links\/([a-f0-9-]{36})$/);
  if (linkMatch && method === "DELETE") {
    await stmt(
      db,
      "UPDATE guest_links SET revoked_at=? WHERE id=? AND owner_id=?",
      now(),
      linkMatch[1],
      uid,
    ).run();
    return { ok: true };
  }
  // ---- Fetching from other sites (user-initiated, authenticated, rate-limited) ----
  if (path === "/api/fetch/product" && method === "POST") {
    const b = await body(req);
    await rate(db, `fetch:${uid}`, 30);
    return lookupProduct(text(b.url, 2048, true));
  }
  if (path === "/api/fetch/image" && method === "POST") {
    const b = await body(req);
    await rate(db, `fetch:${uid}`, 30);
    const f = await fetchBytes(publicHttpsUrl(text(b.url, 4096, true)), {
      timeoutMs: 10000,
      maxBytes: 12_000_000,
      accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
    });
    const type = f.status === 200 ? imageType(f.bytes) : "";
    if (!type)
      fail(
        422,
        "NOT_AN_IMAGE",
        "По ссылке не нашлось картинки. Загрузите фото вручную.",
      );
    return binary(f.bytes, type);
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
  async fetch(req: Request, env: Env): Promise<Response> {
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
      const data = await route(req, env);
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
  },
  async scheduled(_event: ScheduledEvent, env: Env) {
    await env.DB.batch([
      stmt(
        env.DB,
        "DELETE FROM rate_limits WHERE window<?",
        Math.floor(now() / 60) - 1440,
      ),
      stmt(env.DB, "DELETE FROM sessions WHERE expires_at<?", now()),
      stmt(env.DB, "DELETE FROM login_nonces WHERE expires_at<?", now()),
    ]);
  },
};
