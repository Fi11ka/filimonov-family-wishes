// Gift changes made by the owner, from the website or from the bot, with the
// notifications they cause. The owner's own answers never depend on bookings.
import { legacyPriority } from "../shared/hearts";
import { checkLimit, now, stmt } from "./core";
import type { Outbox } from "./notify";
import type { giftInput, Identity } from "./security";
export type GiftValues = ReturnType<typeof giftInput>;
export interface StoredGift {
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
  archived_at: number | null;
  /** A list kept for someone close; null for the owner's own. */
  list_id: string | null;
}
export function ownGift(db: D1Database, uid: string, id: string) {
  return stmt(
    db,
    "SELECT id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,description,hearts AS priority,archived_at,list_id FROM gifts WHERE id=? AND owner_id=?",
    id,
    uid,
  ).first<StoredGift>();
}
/** Adding a wish, by hand, from the bot or by import, tells nobody. */
export async function createGift(
  db: D1Database,
  owner: Identity,
  g: GiftValues,
  /** list: a list kept for someone close, already checked to be the owner's. */
  options: { archived?: boolean; list?: string | null } = {},
) {
  const archived = !!options.archived;
  const list = options.list ?? null;
  await checkLimit(db, owner.id, archived, list);
  const id = crypto.randomUUID();
  await stmt(
    db,
    "INSERT INTO gifts(id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,description,hearts,priority,photo,archived_at,list_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    owner.id,
    g.title,
    g.price_minor,
    g.price_max_minor,
    g.price_range,
    g.currency,
    g.shop_url,
    g.description,
    g.priority,
    legacyPriority(g.priority),
    g.photo,
    archived ? now() : null,
    list,
  ).run();
  return id;
}
/** Who gave their word for a gift: the organizer of its booking and friends who joined. */
async function givers(db: D1Database, giftId: string) {
  return (
    await stmt(
      db,
      `SELECT user_id FROM reservations WHERE gift_id=?1 AND user_id IS NOT NULL
      UNION SELECT user_id FROM reservation_members WHERE gift_id=?1 AND status='joined'`,
      giftId,
    ).all<{ user_id: string }>()
  ).results.map((r) => r.user_id);
}
export type OwnerAction = "deleted" | ArchiveReason;
/**
 * The owner deleted or archived a wish: each giver keeps a card of their choice
 * as it was (flow 16), and the booking itself closes. A card the giver hid stays
 * hidden; one already confirmed as given keeps its place in «Подаренные» and
 * only learns what the owner did. Returns the givers to tell: those whose
 * booking was still active.
 */
async function keepForGivers(db: D1Database, giftId: string, action: OwnerAction) {
  const all = await givers(db, giftId);
  const given = all.length
    ? (
        await stmt(
          db,
          `SELECT user_id FROM giver_records WHERE gift_id=? AND gifted_at IS NOT NULL AND user_id IN (${all.map(() => "?").join(",")})`,
          giftId,
          ...all,
        ).all<{ user_id: string }>()
      ).results.map((r) => r.user_id)
    : [];
  await db.batch([
    stmt(
      db,
      `INSERT INTO giver_records(user_id,gift_id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,photo,reason,changed_at,list_name)
      SELECT b.user_id,g.id,g.owner_id,g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.shop_url,g.photo,?2,?3,
        (SELECT name FROM wishlists WHERE id=g.list_id)
      FROM gifts g JOIN (
        SELECT gift_id,user_id FROM reservations WHERE user_id IS NOT NULL
        UNION SELECT gift_id,user_id FROM reservation_members WHERE status='joined'
      ) b ON b.gift_id=g.id WHERE g.id=?1
      ON CONFLICT(user_id,gift_id) DO UPDATE SET reason=excluded.reason,changed_at=excluded.changed_at
      WHERE giver_records.hidden_at IS NULL`,
      giftId,
      action,
      now(),
    ),
    // Archived first and deleted later: the card says «Удалил» now.
    ...(action === "deleted"
      ? [
          stmt(
            db,
            "UPDATE giver_records SET reason='deleted',changed_at=? WHERE gift_id=? AND hidden_at IS NULL AND reason<>'deleted'",
            now(),
            giftId,
          ),
        ]
      : []),
    stmt(db, "DELETE FROM reservations WHERE gift_id=?", giftId),
  ]);
  return all.filter((id) => !given.includes(id));
}
export async function deleteGift(
  db: D1Database,
  out: Outbox,
  owner: Identity,
  id: string,
) {
  const g = await ownGift(db, owner.id, id);
  if (!g) return;
  const tell = await keepForGivers(db, id, "deleted");
  await stmt(
    db,
    "DELETE FROM gifts WHERE id=? AND owner_id=?",
    id,
    owner.id,
  ).run();
  out.wishRemoved(owner, g, tell, "deleted");
}
export const archiveReasons = [
  "changed_mind",
  "gifted",
  "bought_self",
] as const;
export type ArchiveReason = (typeof archiveReasons)[number];
/**
 * Any wish can be archived for any reason, booked or not, with the same answer.
 * A booking closes; its givers keep their cards (flow 16).
 */
export async function archiveGift(
  db: D1Database,
  out: Outbox,
  owner: Identity,
  id: string,
  reason: ArchiveReason,
) {
  const g = await ownGift(db, owner.id, id);
  if (!g || g.archived_at !== null) return;
  await checkLimit(db, owner.id, true, g.list_id);
  const r = await stmt(
    db,
    "UPDATE gifts SET archived_at=unixepoch(),archive_reason=?,updated_at=unixepoch() WHERE id=? AND owner_id=? AND archived_at IS NULL RETURNING id",
    reason,
    id,
    owner.id,
  ).first();
  if (r) out.wishRemoved(owner, g, await keepForGivers(db, id, reason), reason);
}
type Changeable = Pick<
  StoredGift,
  "id" | "title" | "price_minor" | "price_max_minor" | "price_range" | "currency" | "shop_url"
>;
/**
 * The owner changed the title, price or link of a wish: whoever booked it gets a
 * message and a mark in «Мои брони». The booking stays; the owner sees nothing.
 */
export async function giftChanged(
  db: D1Database,
  out: Outbox,
  owner: Identity,
  before: Changeable,
  after: Changeable | null,
) {
  if (!after) return;
  const fields = [
    before.title !== after.title && "title",
    (before.price_minor !== after.price_minor ||
      before.price_max_minor !== after.price_max_minor ||
      !!before.price_range !== !!after.price_range ||
      before.currency !== after.currency) &&
      "price",
    before.shop_url !== after.shop_url && "link",
  ].filter((f): f is string => !!f);
  if (!fields.length) return;
  const r = await stmt(
    db,
    "SELECT changed_fields FROM reservations WHERE gift_id=? AND user_id IS NOT NULL",
    before.id,
  ).first<{ changed_fields: string | null }>();
  if (!r) return;
  const all = [
    ...new Set([...(r.changed_fields?.split(",").filter(Boolean) ?? []), ...fields]),
  ];
  await stmt(
    db,
    "UPDATE reservations SET changed_at=?,changed_fields=? WHERE gift_id=?",
    now(),
    all.join(","),
    before.id,
  ).run();
  out.giftChanged(owner, after, await givers(db, before.id), fields);
}
/** A wish back from the archive is not news either. */
export async function restoreGift(db: D1Database, owner: Identity, id: string) {
  const g = await ownGift(db, owner.id, id);
  if (!g || g.archived_at === null) return;
  await checkLimit(db, owner.id, false, g.list_id);
  await stmt(
    db,
    "UPDATE gifts SET archived_at=NULL,archive_reason=NULL,gifted_by_name=NULL,gifted_by_username=NULL,updated_at=unixepoch() WHERE id=? AND owner_id=?",
    id,
    owner.id,
  ).run();
}
