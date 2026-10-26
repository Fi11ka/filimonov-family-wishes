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
// A share link that still opens the owner's list: not revoked, not expired, and made
// by the owner or by a friend while the owner allows resharing.
export const LINK_ACTIVE = (link: string, at: string) =>
  `${link}.revoked_at IS NULL AND ${link}.expires_at>${at} AND (${link}.created_by=${link}.owner_id OR EXISTS(SELECT 1 FROM users share_owner WHERE share_owner.id=${link}.owner_id AND share_owner.allow_resharing=1))`;
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
/**
 * Finds or creates the account of a person signed in with Telegram (Mini App,
 * website, bot). `user` carries the Telegram user ID; the result carries the
 * account ID, which is the same number for every account created through
 * Telegram, but may differ once other sign-in methods link to an account.
 *
 * Never duplicates an account: without an identity row (e.g. one missed by a
 * migration) an existing account with the Telegram ID gets the identity back.
 */
export async function saveUser(db: D1Database, user: Identity) {
  const telegramId = user.id;
  const account =
    (
      await stmt(
        db,
        "SELECT user_id FROM identities WHERE provider='telegram' AND subject=?",
        telegramId,
      ).first<{ user_id: string }>()
    )?.user_id ?? telegramId;
  await db.batch([
    // A Telegram username can move to another person; the newest owner keeps it.
    // users.username is kept as a copy for display and for the previous Worker version.
    ...(user.username
      ? [
          stmt(
            db,
            "UPDATE identities SET username=NULL WHERE provider='telegram' AND username=? AND subject<>?",
            user.username,
            telegramId,
          ),
          stmt(
            db,
            "UPDATE users SET username=NULL WHERE username=? AND id<>?",
            user.username,
            account,
          ),
        ]
      : []),
    stmt(
      db,
      `INSERT INTO users(id,name,username) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username WHERE name<>excluded.name OR username IS NOT excluded.username`,
      account,
      user.name,
      user.username,
    ),
    stmt(
      db,
      `INSERT INTO identities(provider,subject,user_id,username,name) VALUES('telegram',?,?,?,?)
      ON CONFLICT(provider,subject) DO UPDATE SET username=excluded.username,name=excluded.name
      WHERE username IS NOT excluded.username OR name IS NOT excluded.name`,
      telegramId,
      account,
      user.username,
      user.name,
    ),
  ]);
  return { ...user, id: account };
}
/** The Telegram user ID (= private chat ID) of an account, or null without Telegram. */
export async function telegramIdOf(db: D1Database, account: string) {
  return (
    (
      await stmt(
        db,
        "SELECT subject FROM identities WHERE provider='telegram' AND user_id=? ORDER BY created_at LIMIT 1",
        account,
      ).first<{ subject: string }>()
    )?.subject ?? null
  );
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
