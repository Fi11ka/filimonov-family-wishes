// Events: as many as a person likes, each with its own guests, two dates and the
// wishes it shows (flows 5, 6 and 10). The standard occasions from the profile are
// only a list to start from. Guests take part as soon as they are invited and can
// decline; the organizer sees the guests they chose but never a booking.
import {
  eventSpecs,
  daysUntil,
  upcomingEvents,
  validEventDate,
  type EventKey,
} from "../shared/events";
import { fail, text, type Identity } from "./security";
import { isId } from "../shared/token";
import { now, stmt } from "./core";
import type { Outbox } from "./notify";
export const GUEST_LIMIT = 50;
type Person = { id: string; name: string; username: string | null };
export type Mode = "hero" | "everyone";
type EventRow = {
  id: string;
  owner_id: string;
  base: EventKey;
  title: string;
  actual_on: string;
  celebrate_on: string;
  mode: Mode;
  place: string | null;
  picked: number;
};
const COLUMNS =
  "e.id,e.owner_id,e.base,e.title,e.actual_on,e.celebrate_on,e.mode,e.place,e.picked";
/**
 * Still current: until a day after the later of the two dates. Afterwards the
 * event leaves the lists and stops opening wishlists; bookings stay as they are.
 */
const CURRENT = `MAX(e.actual_on,e.celebrate_on)>=date('now','-1 day')`;
/** User `u` takes part in event `e`: its organizer, or a guest who has not declined. */
const member = (u: string) =>
  `(e.owner_id=${u} OR EXISTS(SELECT 1 FROM event_members x WHERE x.event_id=e.id AND x.user_id=${u} AND x.declined_at IS NULL))`;
/** Guest `u` of event `e` takes part and shows a picked set (1) or the whole list (0). */
const guestPicked = (u: string, picked: 0 | 1) =>
  `EXISTS(SELECT 1 FROM event_members y WHERE y.event_id=e.id AND y.user_id=${u} AND y.declined_at IS NULL AND y.picked=${picked})`;
/**
 * SQL condition: `viewer` takes part in a current event of `owner` that shows
 * the whole wishlist, or both take part in a «для всех» event where `owner`, a
 * guest, shows their whole list. A picked set opens only its wishes: EVENT_GIFT.
 */
export const PARTY_PEER = (viewer: string, owner: string) =>
  `EXISTS(SELECT 1 FROM events e WHERE ${CURRENT} AND ${member(viewer)}
    AND ((e.owner_id=${owner} AND e.picked=0) OR (e.mode='everyone' AND e.owner_id<>${owner} AND ${guestPicked(owner, 0)})))`;
/**
 * SQL condition: `gift` is one of the picked wishes a current event shows to
 * `viewer`: the organizer's, or in «для всех» a guest's own picked set.
 */
export const EVENT_GIFT = (viewer: string, gift: string, owner: string) =>
  `EXISTS(SELECT 1 FROM events e JOIN event_wishes w ON w.event_id=e.id
    WHERE w.gift_id=${gift} AND ${CURRENT} AND ${member(viewer)}
      AND ((e.owner_id=${owner} AND e.picked=1)
        OR (e.mode='everyone' AND e.owner_id<>${owner} AND ${guestPicked(owner, 1)})))`;
/** Who may invite whom: anyone in the four groups of «Друзья», either way, approved or not. */
const PEOPLE = (other: string) =>
  `EXISTS(SELECT 1 FROM follows f WHERE (f.follower_id=?1 AND f.target_id=${other}) OR (f.follower_id=${other} AND f.target_id=?1))`;
const shape = (e: EventRow) => ({
  id: e.id,
  owner_id: e.owner_id,
  base: e.base,
  title: e.title,
  actual_on: e.actual_on,
  celebrate_on: e.celebrate_on,
  days: Math.max(0, daysUntil(e.celebrate_on)),
  mode: e.mode,
  picked: !!e.picked,
});
type Shaped = ReturnType<typeof shape>;
const forMessage = (e: Shaped) => ({
  id: e.id,
  title: e.title,
  date: e.celebrate_on,
  days: e.days,
});
async function guestsOf(db: D1Database, ids: string[]) {
  if (!ids.length) return new Map<string, (Person & { declined: boolean })[]>();
  const rows = (
    await stmt(
      db,
      `SELECT m.event_id,u.id,u.name,u.username,m.declined_at FROM event_members m JOIN users u ON u.id=m.user_id
      WHERE m.event_id IN (SELECT value FROM json_each(?)) ORDER BY m.created_at,u.name`,
      JSON.stringify(ids),
    ).all<Person & { event_id: string; declined_at: number | null }>()
  ).results;
  const by = new Map<string, (Person & { declined: boolean })[]>();
  for (const r of rows)
    by.set(r.event_id, [
      ...(by.get(r.event_id) || []),
      {
        id: r.id,
        name: r.name,
        username: r.username,
        declined: r.declined_at !== null,
      },
    ]);
  return by;
}
/**
 * The owner's current events the viewer may see in their wishlist: every one
 * for the owner, otherwise those the viewer takes part in.
 */
export async function invitations(
  db: D1Database,
  ownerId: string,
  viewerId: string | null,
) {
  if (!viewerId) return [];
  const rows = (
    await stmt(
      db,
      `SELECT ${COLUMNS} FROM events e WHERE e.owner_id=?1 AND ${CURRENT} AND (?2=?1 OR ${member("?2")})
      ORDER BY e.celebrate_on,e.created_at`,
      ownerId,
      viewerId,
    ).all<EventRow>()
  ).results;
  const guests = await guestsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    ...shape(r),
    guests: (guests.get(r.id) || []).filter((g) => !g.declined).length,
  }));
}
/**
 * Names of who booked each gift in listOwner's list, as the viewer may see them:
 * the viewer and the bookers take part in an event of listOwner, or in a «для
 * всех» event listOwner takes part in. Guests from a link are named by what
 * they typed; other bookings stay without a name. Nobody learns this about
 * their own list.
 */
export async function bookerNames(
  db: D1Database,
  listOwner: string,
  viewerId: string,
) {
  const names = new Map<string, string[]>();
  if (viewerId === listOwner) return names;
  const shared = (
    await stmt(
      db,
      `SELECT e.id,e.owner_id FROM events e WHERE ${CURRENT} AND ${member("?1")}
      AND (e.owner_id=?2 OR (e.mode='everyone' AND ${member("?2")}))`,
      viewerId,
      listOwner,
    ).all<{ id: string; owner_id: string }>()
  ).results;
  if (!shared.length) return names;
  const guests = await guestsOf(
    db,
    shared.map((e) => e.id),
  );
  const together = new Set(
    shared.flatMap((e) => [
      e.owner_id,
      ...(guests.get(e.id) || []).filter((g) => !g.declined).map((g) => g.id),
    ]),
  );
  const bookings = (
    await stmt(
      db,
      `SELECT r.gift_id,r.user_id,COALESCE(u.name,r.guest_name) AS name,r.created_at AS at FROM reservations r
        JOIN gifts g ON g.id=r.gift_id LEFT JOIN users u ON u.id=r.user_id
        WHERE g.owner_id=?1 AND g.archived_at IS NULL
      UNION ALL SELECT m.gift_id,m.user_id,u.name,m.created_at+1 AS at FROM reservation_members m
        JOIN gifts g ON g.id=m.gift_id JOIN users u ON u.id=m.user_id
        WHERE g.owner_id=?1 AND g.archived_at IS NULL AND m.status='joined'
      ORDER BY at`,
      listOwner,
    ).all<{ gift_id: string; user_id: string | null; name: string | null }>()
  ).results;
  for (const r of bookings) {
    if (!r.name || (r.user_id !== null && !together.has(r.user_id))) continue;
    names.set(r.gift_id, [...(names.get(r.gift_id) || []), r.name]);
  }
  return names;
}
/** Current events the user takes part in as a guest, nearest first. */
export async function myParties(db: D1Database, uid: string) {
  return (
    await stmt(
      db,
      `SELECT e.id,e.owner_id,e.title,e.celebrate_on AS date FROM events e
      JOIN event_members m ON m.event_id=e.id AND m.user_id=? AND m.declined_at IS NULL
      WHERE ${CURRENT} ORDER BY e.celebrate_on`,
      uid,
    ).all<{ id: string; owner_id: string; title: string; date: string }>()
  ).results;
}
const standardTitle: Record<EventKey, string> = {
  birthday: "День рождения",
  new_year: "Новый год",
  march8: "8 Марта",
  feb23: "23 Февраля",
  custom: "",
};
const missing = (): never => fail(404, "NOT_FOUND", "Мероприятие недоступно.");
/** A date that is a real day, not long past and not beyond three years. */
function eventDate(value: unknown, label: string) {
  const earliest = new Date(now() * 1000 - 86400000).toISOString().slice(0, 10);
  const latest = new Date(now() * 1000 + 3 * 366 * 86400000)
    .toISOString()
    .slice(0, 10);
  if (!validEventDate(value) || value < earliest || value > latest)
    fail(
      400,
      "VALIDATION",
      `Укажите ${label}: не раньше сегодняшней и не дальше чем через 3 года.`,
    );
  return value;
}
type Wishes = (
  owner: string,
  user: Identity,
  event: string | null,
) => Promise<object[]>;
/** Event routes; null when the path is not one of them. */
export async function eventRoute(
  db: D1Database,
  out: Outbox,
  user: Identity,
  path: string,
  method: string,
  body: () => Promise<Record<string, unknown>>,
  rate: (key: string, max: number) => Promise<void>,
  canView: (owner: string) => Promise<boolean>,
  wishes: Wishes,
  query: URLSearchParams = new URLSearchParams(),
) {
  const uid = user.id;
  const load = (id: string) =>
    stmt(db, `SELECT ${COLUMNS} FROM events e WHERE e.id=?`, id).first<EventRow>();
  /** The guests asked for: people from «Друзья» only, at most GUEST_LIMIT. */
  async function chosenGuests(value: unknown) {
    if (
      !Array.isArray(value) ||
      value.length > GUEST_LIMIT ||
      !value.every((v) => typeof v === "string")
    )
      fail(400, "VALIDATION", `Можно пригласить до ${GUEST_LIMIT} человек.`);
    const ids = [...new Set(value as string[])].filter((id) => id !== uid);
    if (!ids.length) return [];
    return (
      await stmt(
        db,
        `SELECT u.id FROM users u WHERE u.id IN (SELECT value FROM json_each(?2)) AND ${PEOPLE("u.id")}`,
        uid,
        JSON.stringify(ids),
      ).all<{ id: string }>()
    ).results.map((r) => r.id);
  }
  /** «Весь вишлист» (null) or chosen wishes: only my active personal ones count. */
  function wishSet(value: unknown) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) fail(400, "VALIDATION", "Выберите желания.");
    return [...new Set((value as unknown[]).filter(isId))].slice(0, 100);
  }
  const putWishes = (event: string, ids: string[]) =>
    ids.map((g) =>
      stmt(
        db,
        `INSERT OR IGNORE INTO event_wishes(event_id,gift_id)
        SELECT ?1,id FROM gifts WHERE id=?2 AND owner_id=?3 AND list_id IS NULL AND archived_at IS NULL`,
        event,
        g,
        uid,
      ),
    );
  /** Forget which of my wishes an event shows; other participants' choices stay. */
  const dropWishes = (event: string) =>
    stmt(
      db,
      "DELETE FROM event_wishes WHERE event_id=? AND gift_id IN (SELECT id FROM gifts WHERE owner_id=?)",
      event,
      uid,
    );
  if (path === "/api/events" && method === "GET") {
    // «Мероприятия»: the standard occasions to start from, my events and the ones I am invited to.
    const me = await stmt(
      db,
      "SELECT birthday,gender FROM users WHERE id=?",
      uid,
    ).first<{ birthday: string | null; gender: string | null }>();
    const mine = await invitations(db, uid, uid);
    const rows = (
      await stmt(
        db,
        `SELECT ${COLUMNS},u.name,u.username,m.declined_at FROM events e
        JOIN event_members m ON m.event_id=e.id AND m.user_id=?
        JOIN users u ON u.id=e.owner_id WHERE ${CURRENT} ORDER BY e.celebrate_on`,
        uid,
      ).all<EventRow & Person & { declined_at: number | null }>()
    ).results;
    return {
      occasions: upcomingEvents(eventSpecs(me || {}), new Date(now() * 1000)),
      mine,
      invited: rows.map((r) => ({
        ...shape(r),
        owner: { id: r.owner_id, name: r.name, username: r.username },
        declined: r.declined_at !== null,
      })),
    };
  }
  if (path === "/api/events" && method === "POST") {
    // One form: occasion or a title, two dates, «для всех» / «для одного», which
    // wishes, whom to invite. A new event never replaces another.
    const b = await body();
    await rate(`event:${uid}`, 10);
    const base = (
      ["birthday", "new_year", "march8", "feb23", "custom"] as EventKey[]
    ).includes(b.base as EventKey)
      ? (b.base as EventKey)
      : "custom";
    const title = text(b.title ?? "", 80) || standardTitle[base];
    if (!title) fail(400, "VALIDATION", "Введите название мероприятия.");
    const actual = eventDate(b.actual_on, "дату");
    const celebrate =
      b.celebrate_on === undefined || b.celebrate_on === null || b.celebrate_on === ""
        ? actual
        : eventDate(b.celebrate_on, "когда отмечаете");
    const mode = b.mode === "everyone" ? "everyone" : "hero";
    const place = text(b.place ?? "", 1000) || null;
    const picked = wishSet(b.wishes);
    const guests = await chosenGuests(b.guests ?? []);
    const id = crypto.randomUUID();
    await db.batch([
      stmt(
        db,
        "INSERT INTO events(id,owner_id,base,title,actual_on,celebrate_on,mode,place,picked) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        uid,
        base,
        title,
        actual,
        celebrate,
        mode,
        place,
        picked ? 1 : 0,
      ),
      ...putWishes(id, picked || []),
      ...guests.map((g) =>
        stmt(
          db,
          "INSERT INTO event_members(event_id,user_id) VALUES(?,?)",
          id,
          g,
        ),
      ),
    ]);
    const e = shape((await load(id))!);
    if (guests.length) out.eventInvite(user, forMessage(e), mode, guests);
    // Friends hear about it once; the invited already got their invitation.
    await out.eventAdded(user, forMessage(e), guests);
    return { event: e };
  }
  const one = path.match(
    /^\/api\/events\/([a-f0-9-]{36})(\/decline|\/remind|\/wishes)?$/,
  );
  if (!one) return null;
  const event = await load(one[1]);
  if (!event) missing();
  const e = event!;
  const own = e.owner_id === uid;
  const membership = await stmt(
    db,
    "SELECT declined_at,picked FROM event_members WHERE event_id=? AND user_id=?",
    e.id,
    uid,
  ).first<{ declined_at: number | null; picked: number }>();
  /** Which of my wishes this event shows: null is the whole list. */
  const myWishIds = async (picked: boolean) =>
    picked
      ? (
          await stmt(
            db,
            "SELECT w.gift_id FROM event_wishes w JOIN gifts g ON g.id=w.gift_id WHERE w.event_id=? AND g.owner_id=?",
            e.id,
            uid,
          ).all<{ gift_id: string }>()
        ).results.map((r) => r.gift_id)
      : null;
  if (one[2] === "/wishes" && method === "PUT") {
    // «Мои желания для мероприятия»: the organizer, or in «для всех» any guest who
    // takes part, picks a set of their own wishes or shows the whole list.
    const guestHere =
      !!membership && membership.declined_at === null && e.mode === "everyone";
    if (!own && !guestHere) missing();
    await rate(`eventwishes:${uid}`, 30);
    const picked = wishSet((await body()).wishes);
    await db.batch([
      own
        ? stmt(
            db,
            "UPDATE events SET picked=?,updated_at=unixepoch() WHERE id=?",
            picked ? 1 : 0,
            e.id,
          )
        : stmt(
            db,
            "UPDATE event_members SET picked=? WHERE event_id=? AND user_id=?",
            picked ? 1 : 0,
            e.id,
            uid,
          ),
      dropWishes(e.id),
      ...putWishes(e.id, picked || []),
    ]);
    return { wish_ids: await myWishIds(!!picked) };
  }
  if (one[2] === "/decline" && (method === "POST" || method === "DELETE")) {
    // «Отказаться от участия» and undoing it. Bookings stay in «Мои брони».
    if (!membership) missing();
    await stmt(
      db,
      "UPDATE event_members SET declined_at=? WHERE event_id=? AND user_id=?",
      method === "POST" ? now() : null,
      e.id,
      uid,
    ).run();
    return { declined: method === "POST" };
  }
  if (one[2] === "/remind" && method === "POST") {
    // «Напомнить»: the bot asks the organizer to add wishes, without saying who asked.
    if (!membership || membership.declined_at !== null) missing();
    await rate(`remind:${uid}:${e.id}`, 1);
    out.eventRemind(e.owner_id, forMessage(shape(e)));
    return { ok: true };
  }
  if (one[2]) return null;
  if (method === "GET") {
    // The event page. Who takes part sees the guests, the place and the wishes;
    // whoever sees the organizer's list sees only what the event is.
    const current =
      Math.max(daysUntil(e.actual_on), daysUntil(e.celebrate_on)) >= -1;
    const visible =
      own || (membership && current) || (current && (await canView(e.owner_id)));
    if (!visible) missing();
    const taking = own || (!!membership && membership.declined_at === null);
    const people = (await guestsOf(db, [e.id])).get(e.id) || [];
    // Whose wishes: the organizer's, or in «для всех» any guest's who takes part.
    const of = query.get("of") || e.owner_id;
    const ofGuest =
      of !== e.owner_id && e.mode === "everyone"
        ? await stmt(
            db,
            "SELECT picked FROM event_members WHERE event_id=? AND user_id=? AND declined_at IS NULL",
            e.id,
            of,
          ).first<{ picked: number }>()
        : null;
    if (of !== e.owner_id && !ofGuest) missing();
    const ofPicked = ofGuest ? !!ofGuest.picked : !!e.picked;
    const [owner, list] = await Promise.all([
      stmt(
        db,
        "SELECT id,name,username FROM users WHERE id=?",
        e.owner_id,
      ).first<Person>(),
      taking ? wishes(of, user, ofPicked ? e.id : null) : [],
    ]);
    return {
      event: shape(e),
      owner,
      place: taking || membership ? e.place || "" : "",
      is_owner: own,
      member: membership ? { declined: membership.declined_at !== null } : null,
      // The organizer sees who declined; guests see who takes part.
      guests: own ? people : taking ? people.filter((g) => !g.declined) : [],
      of,
      wishes: list,
      // My own choice for this event: the organizer's, or a «для всех» guest's.
      wish_ids:
        own || (taking && e.mode === "everyone")
          ? await myWishIds(own ? !!e.picked : !!membership?.picked)
          : null,
    };
  }
  if (!own) missing();
  if (method === "DELETE") {
    // Cancelling: the guests are told; bookings stay with the givers.
    const told = (
      await stmt(
        db,
        "SELECT user_id FROM event_members WHERE event_id=? AND declined_at IS NULL",
        e.id,
      ).all<{ user_id: string }>()
    ).results.map((r) => r.user_id);
    await stmt(db, "DELETE FROM events WHERE id=?", e.id).run();
    out.eventCancelled(user, forMessage(shape(e)), told);
    return { ok: true };
  }
  if (method !== "PATCH") missing();
  // Management from «Мероприятия»: when we celebrate, the place, the format,
  // the wishes and the guests. The actual date never changes here.
  const b = await body();
  await rate(`eventedit:${uid}`, 30);
  const title =
    b.title === undefined ? e.title : text(b.title ?? "", 80) || e.title;
  const celebrate =
    b.celebrate_on === undefined
      ? e.celebrate_on
      : eventDate(b.celebrate_on, "когда отмечаете");
  const place =
    b.place === undefined ? e.place : text(b.place ?? "", 1000) || null;
  const mode =
    b.mode === undefined ? e.mode : b.mode === "everyone" ? "everyone" : "hero";
  const picked = b.wishes === undefined ? undefined : wishSet(b.wishes);
  const before = (
    await stmt(
      db,
      "SELECT user_id FROM event_members WHERE event_id=?",
      e.id,
    ).all<{ user_id: string }>()
  ).results.map((r) => r.user_id);
  const guests =
    b.guests === undefined ? before : await chosenGuests(b.guests);
  const added = guests.filter((g) => !before.includes(g));
  const removed = before.filter((g) => !guests.includes(g));
  await db.batch([
    stmt(
      db,
      "UPDATE events SET title=?,celebrate_on=?,place=?,mode=?,picked=?,updated_at=unixepoch() WHERE id=?",
      title,
      celebrate,
      place,
      mode,
      picked === undefined ? e.picked : picked ? 1 : 0,
      e.id,
    ),
    ...(picked === undefined
      ? []
      : [
          dropWishes(e.id),
          ...putWishes(e.id, picked || []),
        ]),
    // A guest taken off loses access through the event; their bookings stay.
    ...removed.map((g) =>
      stmt(
        db,
        "DELETE FROM event_members WHERE event_id=? AND user_id=?",
        e.id,
        g,
      ),
    ),
    ...added.map((g) =>
      stmt(
        db,
        "INSERT INTO event_members(event_id,user_id) VALUES(?,?)",
        e.id,
        g,
      ),
    ),
  ]);
  const fresh = shape((await load(e.id))!);
  if (added.length) out.eventInvite(user, forMessage(fresh), fresh.mode, added);
  if (celebrate !== e.celebrate_on || place !== e.place) {
    const stay = (
      await stmt(
        db,
        "SELECT user_id FROM event_members WHERE event_id=? AND declined_at IS NULL",
        e.id,
      ).all<{ user_id: string }>()
    ).results
      .map((r) => r.user_id)
      .filter((g) => !added.includes(g));
    out.eventChanged(user, forMessage(fresh), stay, {
      date: celebrate !== e.celebrate_on,
      place: place !== e.place,
    });
  }
  return { event: fresh };
}
