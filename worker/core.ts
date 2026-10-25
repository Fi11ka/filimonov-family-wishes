// Database helpers shared by the HTTP API (index.ts) and the Telegram bot (bot.ts).
import { fail, type Identity } from "./security";
import type { AiBinding } from "./shops/naming";
export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  APP_ORIGIN: string;
  APP_URL: string;
  /** Workers AI (optional): shortens shop titles into Russian wish names. */
  AI?: AiBinding;
  /** Secret shared with the home helper program (optional). */
  HELPER_TOKEN?: string;
  /** Bot API address; only tests change it. */
  TELEGRAM_API?: string;
}
export const now = () => Math.floor(Date.now() / 1000);
export function stmt(db: D1Database, sql: string, ...args: unknown[]) {
  return db.prepare(sql).bind(...args);
}
export const ACTIVE_LIMIT = 100,
  ARCHIVE_LIMIT = 300;
// Accepted friendship between ?1 and the gift owner column, in either order.
export const FRIEND_OF = (owner: string) =>
  `EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.user_a=?1 AND f.user_b=${owner}) OR (f.user_b=?1 AND f.user_a=${owner})))`;
/** Friendship rows store the pair ordered (user_a < user_b). */
export const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
export async function friendship(db: D1Database, x: string, y: string) {
  const [a, b] = pair(x, y);
  return stmt(
    db,
    "SELECT status,requested_by FROM friendships WHERE user_a=? AND user_b=?",
    a,
    b,
  ).first<{ status: "pending" | "accepted"; requested_by: string }>();
}
export async function saveUser(db: D1Database, user: Identity) {
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
export async function activeCount(
  db: D1Database,
  uid: string,
  archived: boolean,
) {
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
export async function checkLimit(
  db: D1Database,
  uid: string,
  archived: boolean,
) {
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
}
/** Everyone who booked the gift: the organizer and invited or joined friends. Guests have no account. */
export async function bookers(db: D1Database, giftId: string) {
  return (
    await stmt(
      db,
      `SELECT user_id FROM reservations WHERE gift_id=?1 AND user_id IS NOT NULL
      UNION SELECT user_id FROM reservation_members WHERE gift_id=?1`,
      giftId,
    ).all<{ user_id: string }>()
  ).results.map((r) => r.user_id);
}
/** Gift details for messages to bookers; the organizer is reservations.user_id. */
export async function giftInfo(db: D1Database, id: string) {
  const r = await stmt(
    db,
    `SELECT g.id,g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.owner_id,u.name AS owner_name,u.username AS owner_username,r.user_id AS organizer
    FROM gifts g JOIN users u ON u.id=g.owner_id LEFT JOIN reservations r ON r.gift_id=g.id WHERE g.id=?`,
    id,
  ).first<{
    id: string;
    title: string;
    price_minor: number | null;
    price_max_minor: number | null;
    price_range: number;
    currency: string;
    owner_id: string;
    owner_name: string;
    owner_username: string | null;
    organizer: string | null;
  }>();
  if (!r) return null;
  return {
    gift: r,
    owner: { id: r.owner_id, name: r.owner_name, username: r.owner_username },
    organizer: r.organizer,
  };
}
