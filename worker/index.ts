import {
  ApiError,
  fail,
  giftInput,
  hash,
  https,
  text,
  token,
  validateInitData,
  type Identity,
} from "./security";
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
  currency: string;
  shop_url: string;
  description: string;
  priority: number;
  photo: string;
  created_at: number;
  updated_at: number;
}
interface Family {
  id: string;
  name: string;
  owner_id: string;
}
const giftColumns =
  "g.id,g.owner_id,g.title,g.price_minor,g.currency,g.shop_url,g.description,g.priority,CASE WHEN g.photo='' THEN 0 ELSE 1 END AS has_photo,g.created_at,g.updated_at";
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
async function family(db: D1Database, id: string) {
  return stmt(
    db,
    "SELECT f.id,f.name,f.owner_id FROM families f JOIN members m ON m.family_id=f.id WHERE m.user_id=?",
    id,
  ).first<Family>();
}
async function canView(
  db: D1Database,
  owner: string,
  user: Identity | null,
  guest: string | null,
) {
  if (user?.id === owner) return true;
  if (
    user &&
    (await stmt(
      db,
      "SELECT 1 AS ok FROM members a JOIN members b ON a.family_id=b.family_id WHERE a.user_id=? AND b.user_id=?",
      user.id,
      owner,
    ).first())
  )
    return true;
  if (guest && /^[A-Za-z0-9_-]{43}$/.test(guest))
    return !!(await stmt(
      db,
      "SELECT 1 AS ok FROM guest_links WHERE owner_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?",
      owner,
      await hash(guest),
      now(),
    ).first());
  return false;
}
async function list(db: D1Database, owner: string, user: Identity | null) {
  // Owner/anonymous query NEVER reads reservation table, even its row count or timestamp.
  if (!user || user.id === owner)
    return (
      await stmt(
        db,
        `SELECT ${giftColumns} FROM gifts g WHERE g.owner_id=? ORDER BY g.priority DESC,g.created_at DESC,g.id`,
        owner,
      ).all<Gift>()
    ).results;
  const r = await stmt(
    db,
    `SELECT ${giftColumns},CASE WHEN r.gift_id IS NULL THEN 'available' WHEN r.user_id=? THEN 'mine' ELSE 'reserved' END AS reservation FROM gifts g LEFT JOIN reservations r ON r.gift_id=g.id WHERE g.owner_id=? ORDER BY g.priority DESC,g.created_at DESC,g.id`,
    user.id,
    owner,
  ).all();
  return r.results;
}
async function route(req: Request, env: Env) {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method,
    db = env.DB;
  if (path === "/api/health" && method === "GET")
    return { ok: true, service: "Filimonov Family Wishes" };
  if (!env.BOT_TOKEN)
    fail(503, "NOT_CONFIGURED", "Приложение ещё настраивается.");
  const auth = req.headers.get("authorization");
  const user = auth
    ? await validateInitData(
        auth.startsWith("tma ") ? auth.slice(4) : "",
        env.BOT_TOKEN,
      )
    : null;
  const guest = req.headers.get("x-guest-token");
  if (
    !user &&
    !(
      method === "GET" &&
      (path === "/api/guest" ||
        /^\/api\/gifts\/[a-f0-9-]{36}\/photo$/.test(path))
    )
  )
    fail(401, "AUTH_REQUIRED", "Откройте приложение через Telegram.");
  // No raw auth data, guest token, IP, or reservation identity in logs.
  const rateKey = user
    ? `u:${user.id}`
    : `ip:${await hash(req.headers.get("cf-connecting-ip") || "local")}`;
  await rate(db, rateKey, user ? 240 : 120);
  if (user)
    await stmt(
      db,
      `INSERT INTO users(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE name<>excluded.name`,
      user.id,
      user.name,
    ).run();
  if (path === "/api/guest" && method === "GET") {
    if (!guest || !/^[A-Za-z0-9_-]{43}$/.test(guest)) missing();
    const link = await stmt(
      db,
      "SELECT owner_id FROM guest_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
      await hash(guest),
      now(),
    ).first<{ owner_id: string }>();
    if (!link) missing();
    const owner = await stmt(
      db,
      "SELECT id,name FROM users WHERE id=?",
      link.owner_id,
    ).first();
    return {
      owner,
      gifts: await list(db, link.owner_id, user),
      can_reserve: !!user && user.id !== link.owner_id,
      is_owner: user?.id === link.owner_id,
    };
  }
  if (!user && method === "GET" && path.endsWith("/photo")) {
    const match = path.match(/^\/api\/gifts\/([a-f0-9-]{36})\/photo$/);
    const g = match
      ? await stmt(
          db,
          "SELECT owner_id,photo FROM gifts WHERE id=?",
          match[1],
        ).first<{ owner_id: string; photo: string }>()
      : null;
    if (!g || !(await canView(db, g.owner_id, null, guest))) missing();
    return { photo: g.photo };
  }
  if (!user) fail(401, "AUTH_REQUIRED", "Откройте приложение через Telegram.");
  const uid = user.id;
  if (path === "/api/me" && method === "GET")
    return { user, family: await family(db, uid) };
  if (path === "/api/family" && method === "POST") {
    const b = await body(req),
      name = text(b.name, 80, true);
    if (await family(db, uid))
      fail(409, "ALREADY_MEMBER", "Вы уже состоите в семье.");
    const id = crypto.randomUUID(),
      invite = token(12);
    try {
      await db.batch([
        stmt(
          db,
          "INSERT INTO families(id,name,owner_id,invite_hash) VALUES(?,?,?,?)",
          id,
          name,
          uid,
          await hash(invite),
        ),
        stmt(db, "INSERT INTO members(user_id,family_id) VALUES(?,?)", uid, id),
      ]);
    } catch {
      fail(409, "ALREADY_MEMBER", "Вы уже состоите в семье.");
    }
    return { family: { id, name, owner_id: uid }, invite_code: invite };
  }
  if (path === "/api/family/join" && method === "POST") {
    const b = await body(req);
    await rate(db, `join:${uid}`, 5);
    const code = text(b.code, 100, true);
    const f = await stmt(
      db,
      "SELECT id,name,owner_id FROM families WHERE invite_hash=?",
      await hash(code),
    ).first<Family>();
    if (!f) fail(404, "INVITE_INVALID", "Код приглашения не найден.");
    try {
      await stmt(
        db,
        "INSERT INTO members(user_id,family_id) VALUES(?,?)",
        uid,
        f.id,
      ).run();
    } catch {
      fail(409, "ALREADY_MEMBER", "Вы уже состоите в семье.");
    }
    return { family: f };
  }
  if (path === "/api/family/members" && method === "GET") {
    const f = await family(db, uid);
    if (!f) missing();
    return {
      members: (
        await stmt(
          db,
          "SELECT u.id,u.name,COUNT(g.id) AS gift_count FROM members m JOIN users u ON u.id=m.user_id LEFT JOIN gifts g ON g.owner_id=u.id WHERE m.family_id=? GROUP BY u.id ORDER BY m.joined_at,u.id",
          f.id,
        ).all()
      ).results,
    };
  }
  if (path === "/api/family/invite" && method === "POST") {
    const f = await family(db, uid);
    if (!f || f.owner_id !== uid) missing();
    const invite = token(12);
    await stmt(
      db,
      "UPDATE families SET invite_hash=? WHERE id=?",
      await hash(invite),
      f.id,
    ).run();
    return { invite_code: invite };
  }
  if (path === "/api/family/leave" && method === "POST") {
    const f = await family(db, uid);
    if (!f) missing();
    if (f.owner_id === uid)
      fail(409, "FAMILY_OWNER", "Создатель семьи не может выйти из неё.");
    await stmt(db, "DELETE FROM members WHERE user_id=?", uid).run();
    return { ok: true };
  }
  const memberMatch = path.match(/^\/api\/family\/members\/(\d+)$/);
  if (memberMatch && method === "DELETE") {
    const f = await family(db, uid);
    if (!f || f.owner_id !== uid || memberMatch[1] === uid) missing();
    await stmt(
      db,
      "DELETE FROM members WHERE user_id=? AND family_id=?",
      memberMatch[1],
      f.id,
    ).run();
    return { ok: true };
  }
  const listMatch = path.match(/^\/api\/lists\/(\d+)$/);
  if (listMatch && method === "GET") {
    const owner = listMatch[1];
    if (!(await canView(db, owner, user, guest))) missing();
    const profile = await stmt(
      db,
      "SELECT id,name FROM users WHERE id=?",
      owner,
    ).first();
    if (!profile) missing();
    return {
      owner: profile,
      gifts: await list(db, owner, user),
      is_owner: owner === uid,
      can_reserve: owner !== uid,
    };
  }
  if (path === "/api/gifts" && method === "POST") {
    const g = giftInput(await body(req));
    const count = await stmt(
      db,
      "SELECT COUNT(*) AS n FROM gifts WHERE owner_id=?",
      uid,
    ).first<{ n: number }>();
    if ((count?.n || 0) >= 100)
      fail(409, "GIFT_LIMIT", "В списке может быть не больше 100 желаний.");
    const id = crypto.randomUUID();
    await stmt(
      db,
      "INSERT INTO gifts(id,owner_id,title,price_minor,currency,shop_url,description,priority,photo) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      uid,
      g.title,
      g.price_minor,
      g.currency,
      g.shop_url,
      g.description,
      g.priority,
      g.photo,
    ).run();
    return { id };
  }
  const giftMatch = path.match(
    /^\/api\/gifts\/([a-f0-9-]{36})(\/reservation|\/photo)?$/,
  );
  if (giftMatch) {
    const id = giftMatch[1];
    const g = await stmt(
      db,
      "SELECT id,owner_id FROM gifts WHERE id=?",
      id,
    ).first<{ id: string; owner_id: string }>();
    if (!g) missing();
    if (giftMatch[2] === "/photo" && method === "GET") {
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
    if (!giftMatch[2] && (method === "PUT" || method === "DELETE")) {
      if (g.owner_id !== uid) missing();
      if (method === "PUT") {
        const v = giftInput(await body(req));
        await stmt(
          db,
          "UPDATE gifts SET title=?,price_minor=?,currency=?,shop_url=?,description=?,priority=?,photo=?,updated_at=unixepoch() WHERE id=? AND owner_id=?",
          v.title,
          v.price_minor,
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
    if (giftMatch[2] && (method === "POST" || method === "DELETE")) {
      // Reject owner BEFORE any reservation read, including cancel attempts.
      if (g.owner_id === uid)
        fail(
          403,
          "SELF_RESERVATION",
          "Нельзя бронировать собственные подарки.",
        );
      // Cancelling one's own reservation is allowed even after a link expires or family removal.
      if (method === "DELETE") {
        await stmt(
          db,
          "DELETE FROM reservations WHERE gift_id=? AND user_id=?",
          id,
          uid,
        ).run();
        return { ok: true };
      }
      if (!(await canView(db, g.owner_id, user, guest))) missing();
      // Access is rechecked INSIDE the atomic write; revocation/removal cannot race this insert.
      const guestHash =
        guest && /^[A-Za-z0-9_-]{43}$/.test(guest) ? await hash(guest) : "";
      const r = await stmt(
        db,
        `INSERT INTO reservations(gift_id,user_id)
        SELECT id,? FROM gifts WHERE id=? AND owner_id<>? AND (
          EXISTS(SELECT 1 FROM members a JOIN members b ON a.family_id=b.family_id WHERE a.user_id=? AND b.user_id=gifts.owner_id)
          OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=gifts.owner_id AND l.token_hash=? AND l.revoked_at IS NULL AND l.expires_at>?)
        ) ON CONFLICT(gift_id) DO NOTHING RETURNING gift_id`,
        uid,
        id,
        uid,
        uid,
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
      `SELECT r.gift_id,CASE WHEN EXISTS(SELECT 1 FROM members a JOIN members b ON a.family_id=b.family_id WHERE a.user_id=? AND b.user_id=g.owner_id) OR EXISTS(SELECT 1 FROM guest_links l WHERE l.owner_id=g.owner_id AND l.revoked_at IS NULL AND l.expires_at>?) THEN g.title ELSE 'Подарок из закрытого списка' END AS title FROM reservations r JOIN gifts g ON g.id=r.gift_id WHERE r.user_id=? AND g.owner_id<>?`,
      uid,
      now(),
      uid,
      uid,
    ).all();
    return { reservations: r.results };
  }
  if (path === "/api/guest-links" && method === "GET")
    return {
      links: (
        await stmt(
          db,
          "SELECT id,expires_at,revoked_at,created_at FROM guest_links WHERE owner_id=? ORDER BY created_at DESC LIMIT 30",
          uid,
        ).all()
      ).results,
    };
  if (path === "/api/guest-links" && method === "POST") {
    await rate(db, `links:${uid}`, 5);
    const raw = token(),
      id = crypto.randomUUID(),
      expires = now() + 30 * 86400;
    await db.batch([
      stmt(
        db,
        "UPDATE guest_links SET revoked_at=? WHERE owner_id=? AND revoked_at IS NULL",
        now(),
        uid,
      ),
      stmt(
        db,
        "INSERT INTO guest_links(id,owner_id,token_hash,expires_at) VALUES(?,?,?,?)",
        id,
        uid,
        await hash(raw),
        expires,
      ),
    ]);
    return {
      id,
      expires_at: expires,
      token: raw,
      telegram_url: `https://t.me/FilimonovFamilyWishes_bot?startapp=g_${raw}`,
      web_url: `${https(env.APP_URL)}#guest=${raw}`,
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
        "GET,POST,PUT,DELETE,OPTIONS",
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
    await stmt(
      env.DB,
      "DELETE FROM rate_limits WHERE window<?",
      Math.floor(now() / 60) - 1440,
    ).run();
  },
};
