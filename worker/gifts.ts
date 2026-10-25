// Gift changes made by the owner, from the website or from the bot, with the
// notifications they cause. The owner's own answers never depend on bookings.
import { bookers, checkLimit, now, stmt } from "./core";
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
}
export function ownGift(db: D1Database, uid: string, id: string) {
  return stmt(
    db,
    "SELECT id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,description,priority,archived_at FROM gifts WHERE id=? AND owner_id=?",
    id,
    uid,
  ).first<StoredGift>();
}
export async function createGift(
  db: D1Database,
  out: Outbox,
  owner: Identity,
  g: GiftValues,
  options: { archived?: boolean; quiet?: boolean } = {},
) {
  const archived = !!options.archived;
  await checkLimit(db, owner.id, archived);
  const id = crypto.randomUUID();
  await stmt(
    db,
    "INSERT INTO gifts(id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,description,priority,photo,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
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
    g.photo,
    archived ? now() : null,
  ).run();
  // Imports pass quiet and announce the whole batch at the end.
  if (!archived && !options.quiet) await out.wishesAdded(owner, [{ id, ...g }]);
  return id;
}
export async function deleteGift(
  db: D1Database,
  out: Outbox,
  owner: Identity,
  id: string,
) {
  const g = await ownGift(db, owner.id, id);
  if (!g) return;
  const booked = await bookers(db, id);
  await stmt(
    db,
    "DELETE FROM gifts WHERE id=? AND owner_id=?",
    id,
    owner.id,
  ).run();
  // Archived wishes were announced when they left the list.
  if (g.archived_at === null)
    await out.wishRemoved(owner, g, booked, "deleted");
}
export const archiveReasons = [
  "changed_mind",
  "gifted",
  "bought_self",
] as const;
export type ArchiveReason = (typeof archiveReasons)[number];
/** Any wish can be archived for any reason, booked or not; bookings stay until the friends remove them. */
export async function archiveGift(
  db: D1Database,
  out: Outbox,
  owner: Identity,
  id: string,
  reason: ArchiveReason,
) {
  const g = await ownGift(db, owner.id, id);
  if (!g || g.archived_at !== null) return;
  await checkLimit(db, owner.id, true);
  const r = await stmt(
    db,
    "UPDATE gifts SET archived_at=unixepoch(),archive_reason=?,updated_at=unixepoch() WHERE id=? AND owner_id=? AND archived_at IS NULL RETURNING id",
    reason,
    id,
    owner.id,
  ).first();
  if (r) await out.wishRemoved(owner, g, await bookers(db, id), reason);
}
export async function restoreGift(
  db: D1Database,
  out: Outbox,
  owner: Identity,
  id: string,
) {
  const g = await ownGift(db, owner.id, id);
  if (!g || g.archived_at === null) return;
  await checkLimit(db, owner.id, false);
  await stmt(
    db,
    "UPDATE gifts SET archived_at=NULL,archive_reason=NULL,gifted_by_name=NULL,gifted_by_username=NULL,updated_at=unixepoch() WHERE id=? AND owner_id=?",
    id,
    owner.id,
  ).run();
  await out.wishesAdded(owner, [g]);
}
