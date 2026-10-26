// Events of a wishlist owner and the friends invited to them. Guests of one event
// see who else is invited and whose bookings are theirs; the owner sees the guests
// they chose but never a booking.
import {
  eventSpecs,
  daysUntil,
  isUpcoming,
  upcomingEvents,
  validEventDate,
  type EventSpec,
} from "../shared/events";
import { ACCOUNT_ID_PART, isAccountId } from "../shared/account-id";
import { fail, text, usernameOf, type Identity } from "./security";
import { CONNECTED, now, stmt } from "./core";
import type { Outbox } from "./notify";
export const GUEST_LIMIT = 50;
type Person = { id: string; name: string; username: string | null };
export async function ownerSpecs(db: D1Database, ownerId: string) {
  const r = await stmt(
    db,
    "SELECT birthday,gender,event_title,event_date FROM users WHERE id=?",
    ownerId,
  ).first<{
    birthday: string | null;
    gender: string | null;
    event_title: string | null;
    event_date: string | null;
  }>();
  return r ? eventSpecs(r) : [];
}
export type Mode = "hero" | "everyone";
/** Whose bookings are named where: see migrations/0012_events.sql. */
const PARTY_ROWS = `SELECT p.owner_id,p.event_key,p.event_on,p.mode,p.description,u.id,u.name,u.username
  FROM event_parties p LEFT JOIN event_guests e ON e.owner_id=p.owner_id AND e.event_key=p.event_key AND e.event_on=p.event_on
  LEFT JOIN users u ON u.id=e.user_id WHERE p.event_on>=date('now','-2 days')`;
type PartyRow = {
  owner_id: string;
  event_key: string;
  event_on: string;
  mode: Mode;
  description: string | null;
  /** NULL for a party without guests. */
  id: string | null;
  name: string;
  username: string | null;
};
/** User `u` (a placeholder or column) takes part in party `p`: its owner or a guest. */
const member = (u: string) =>
  `(p.owner_id=${u} OR EXISTS(SELECT 1 FROM event_guests x WHERE x.owner_id=p.owner_id AND x.event_key=p.event_key AND x.event_on=p.event_on AND x.user_id=${u}))`;
/**
 * SQL condition: `viewer` is a guest of `owner`'s upcoming party, or both take
 * part in a «праздник для всех». It opens the list even without friendship
 * (people can be invited by their Telegram username).
 * Stale rows (a changed birthday or gender) are removed when the profile changes.
 */
export const PARTY_PEER = (viewer: string, owner: string) =>
  `EXISTS(SELECT 1 FROM event_parties p WHERE p.event_on>=date('now','-1 day') AND ${member(viewer)} AND (p.owner_id=${owner} OR (p.mode='everyone' AND ${member(owner)})))`;
/** Groups guest rows into parties that are still ahead (a changed birthday leaves old rows behind). */
async function parties(db: D1Database, rows: PartyRow[]) {
  const specs = new Map<string, EventSpec[]>();
  const found = new Map<
    string,
    {
      owner_id: string;
      key: string;
      date: string;
      title: string;
      mode: Mode;
      description: string;
      guests: Person[];
    }
  >();
  for (const r of rows) {
    if (!specs.has(r.owner_id))
      specs.set(r.owner_id, await ownerSpecs(db, r.owner_id));
    const own = specs.get(r.owner_id)!;
    if (!isUpcoming(own, r.event_key, r.event_on)) continue;
    const id = `${r.owner_id}:${r.event_key}:${r.event_on}`;
    if (!found.has(id))
      found.set(id, {
        owner_id: r.owner_id,
        key: r.event_key,
        date: r.event_on,
        title: own.find((s) => s.key === r.event_key)?.title || "",
        mode: r.mode,
        description: r.description || "",
        guests: [],
      });
    if (r.id)
      found
        .get(id)!
        .guests.push({ id: r.id, name: r.name, username: r.username });
  }
  return [...found.values()];
}
/**
 * The owner's invitations the viewer may see: all of them for the owner,
 * otherwise only events the viewer is invited to, with the other guests.
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
      `${PARTY_ROWS} AND p.owner_id=?1 AND (?2=?1 OR EXISTS(SELECT 1 FROM event_guests v WHERE v.owner_id=p.owner_id AND v.event_key=p.event_key AND v.event_on=p.event_on AND v.user_id=?2))
      ORDER BY e.created_at,u.name`,

      ownerId,
      viewerId,
    ).all<PartyRow>()
  ).results;
  return (await parties(db, rows)).map(({ owner_id: _, ...p }) => p);
}
/**
 * Names of who booked each gift in listOwner's list, as the viewer may see them:
 * the viewer and the bookers share an event with listOwner as its hero, or a
 * «праздник для всех» listOwner takes part in. Guests from a link are named by
 * what they typed; other bookings stay a plain «Забронировано».
 * Nobody learns this about their own list.
 */
export async function bookerNames(
  db: D1Database,
  listOwner: string,
  viewerId: string,
) {
  const names = new Map<string, string[]>();
  if (viewerId === listOwner) return names;
  const rows = (
    await stmt(
      db,
      `${PARTY_ROWS} AND ${member("?1")} AND (p.owner_id=?2 OR (p.mode='everyone' AND ${member("?2")}))`,
      viewerId,
      listOwner,
    ).all<PartyRow>()
  ).results;
  const shared = await parties(db, rows);
  if (!shared.length) return names;
  const together = new Set(
    shared.flatMap((p) => [p.owner_id, ...p.guests.map((g) => g.id)]),
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
/** Upcoming parties the user is a guest of, nearest first. */
export async function myParties(db: D1Database, uid: string) {
  const rows = (
    await stmt(
      db,
      "SELECT owner_id,event_key AS key,event_on AS date FROM event_guests WHERE user_id=? AND event_on>=date('now','-2 days') ORDER BY event_on",
      uid,
    ).all<{ owner_id: string; key: string; date: string }>()
  ).results;
  const specs = new Map<string, EventSpec[]>();
  const found = [];
  for (const r of rows) {
    if (!specs.has(r.owner_id))
      specs.set(r.owner_id, await ownerSpecs(db, r.owner_id));
    if (isUpcoming(specs.get(r.owner_id)!, r.key, r.date)) found.push(r);
  }
  return found;
}
/** Owner's event routes; null when the path is not one of them. */
export async function eventRoute(
  db: D1Database,
  out: Outbox,
  user: Identity,
  path: string,
  method: string,
  body: () => Promise<Record<string, unknown>>,
  rate: (key: string, max: number) => Promise<void>,
  canView: (owner: string) => Promise<boolean>,
) {
  const uid = user.id;
  if (path === "/api/events" && method === "GET") {
    // «Мероприятия»: one's own upcoming events and the parties one is invited to.
    const specs = await ownerSpecs(db, uid);
    const mine = await invitations(db, uid, uid);
    const rows = (
      await stmt(
        db,
        `SELECT p.owner_id,p.event_key,p.event_on,p.mode,u.name,u.username FROM event_parties p
        JOIN event_guests e ON e.owner_id=p.owner_id AND e.event_key=p.event_key AND e.event_on=p.event_on AND e.user_id=?
        JOIN users u ON u.id=p.owner_id WHERE p.event_on>=date('now','-2 days') ORDER BY p.event_on`,
        uid,
      ).all<{
        owner_id: string;
        event_key: string;
        event_on: string;
        mode: Mode;
        name: string;
        username: string | null;
      }>()
    ).results;
    const invited = [];
    for (const r of rows) {
      const own = await ownerSpecs(db, r.owner_id);
      if (!isUpcoming(own, r.event_key, r.event_on)) continue;
      invited.push({
        owner: { id: r.owner_id, name: r.name, username: r.username },
        event: eventOf(own, r.event_key, r.event_on),
        mode: r.mode,
      });
    }
    return {
      mine: upcomingEvents(specs, new Date(now() * 1000)).map((e) => {
        const party = mine.find((p) => p.key === e.key && p.date === e.date);
        return {
          event: e,
          mode: party?.mode || null,
          guests: party?.guests.length || 0,
        };
      }),
      invited,
    };
  }
  if (path === "/api/events/custom" && method === "PUT") {
    const b = await body();
    await rate(`event:${uid}`, 10);
    const title = text(b.title, 80);
    if (!title) fail(400, "VALIDATION", "Введите название мероприятия.");
    const date = b.date;
    const today = new Date(now() * 1000 - 86400000).toISOString().slice(0, 10);
    const latest = new Date(now() * 1000 + 3 * 366 * 86400000)
      .toISOString()
      .slice(0, 10);
    if (!validEventDate(date) || date < today || date > latest)
      fail(
        400,
        "VALIDATION",
        "Укажите дату мероприятия: не раньше сегодняшней и не дальше чем через 3 года.",
      );
    // One event of one's own: the new one replaces the old, and so do its guests.
    const old = await stmt(
      db,
      "SELECT event_title,event_date FROM users WHERE id=?",
      uid,
    ).first<{ event_title: string | null; event_date: string | null }>();
    const same = old?.event_date === date;
    await db.batch([
      stmt(
        db,
        "UPDATE users SET event_title=?,event_date=? WHERE id=?",
        title,
        date,
        uid,
      ),
      ...(same
        ? []
        : [
            stmt(
              db,
              "DELETE FROM event_parties WHERE owner_id=? AND event_key='custom'",
              uid,
            ),
          ]),
    ]);
    if (old?.event_title !== title || !same) {
      await out.eventAdded(user, {
        title,
        date,
        days: Math.max(0, daysUntil(date)),
      });
    }
    return { ok: true };
  }
  if (path === "/api/events/custom" && method === "DELETE") {
    await db.batch([
      stmt(
        db,
        "UPDATE users SET event_title=NULL,event_date=NULL WHERE id=?",
        uid,
      ),
      stmt(
        db,
        "DELETE FROM event_parties WHERE owner_id=? AND event_key='custom'",
        uid,
      ),
    ]);
    return { ok: true };
  }
  if (
    (path === "/api/events/party" || path === "/api/events/guests") &&
    method === "PUT"
  ) {
    // Guests, mode and description of one event; fields left out stay as they are.
    // Only newly added friends get a message; removing someone is silent.
    const b = await body();
    await rate(`eguests:${uid}`, 20);
    const { specs, key, date } = await ownEvent(db, uid, b);
    const party = await stmt(
      db,
      `SELECT mode,description FROM event_parties WHERE ${WHERE}`,
      uid,
      key,
      date,
    ).first<{ mode: Mode; description: string | null }>();
    const mode = b.mode ?? party?.mode ?? "hero";
    if (mode !== "hero" && mode !== "everyone")
      fail(400, "VALIDATION", "Выберите, для кого праздник.");
    const description =
      b.description === undefined
        ? party?.description || null
        : text(b.description ?? "", 1000) || null;
    const value = b.friends;
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.length > GUEST_LIMIT ||
        !value.every(isAccountId))
    )
      fail(400, "VALIDATION", `Выберите до ${GUEST_LIMIT} друзей.`);
    // People who are not friends are added by their Telegram username.
    const names = b.usernames ?? [];
    if (!Array.isArray(names) || names.length > GUEST_LIMIT)
      fail(400, "VALIDATION", `Можно пригласить до ${GUEST_LIMIT} человек.`);
    const wantedNames = names.map((n) => {
      const u = usernameOf(n);
      if (!u)
        fail(
          400,
          "VALIDATION",
          "Введите ник Telegram, например @anna_filimonova.",
        );
      return u;
    });
    const byName = wantedNames.length
      ? (
          await stmt(
            db,
            // Nicknames are Telegram ones: look them up among Telegram sign-ins.
            `SELECT user_id AS id,username FROM identities WHERE provider='telegram' AND username IN (${wantedNames.map(() => "?").join(",")})`,
            ...wantedNames,
          ).all<{ id: string; username: string }>()
        ).results
      : [];
    const unknown = wantedNames.filter(
      (n) => !byName.some((u) => u.username === n),
    );
    if (unknown.length)
      fail(
        404,
        "USER_NOT_FOUND",
        `Не нашли ${unknown.map((n) => `@${n}`).join(", ")}. Человек должен хотя бы раз открыть приложение в Telegram.`,
      );
    const named = byName.map((u) => u.id);
    const current =
      value === undefined
        ? []
        : (
            await stmt(
              db,
              `SELECT user_id FROM event_guests WHERE ${WHERE}`,
              uid,
              key,
              date,
            ).all<{ user_id: string }>()
          ).results.map((r) => r.user_id);
    const wanted =
      value === undefined && !named.length
        ? null
        : [
            ...new Set([
              ...((value as string[] | undefined) ?? current),
              ...named,
            ]),
          ].filter((id) => id !== uid);
    if (wanted && wanted.length > GUEST_LIMIT)
      fail(400, "VALIDATION", `Можно пригласить до ${GUEST_LIMIT} человек.`);
    const results = await db.batch([
      stmt(
        db,
        `INSERT INTO event_parties(owner_id,event_key,event_on,mode,description) VALUES(?,?,?,?,?)
        ON CONFLICT DO UPDATE SET mode=excluded.mode,description=excluded.description`,
        uid,
        key,
        date,
        mode,
        description,
      ),
      ...(wanted
        ? [
            stmt(
              db,
              `DELETE FROM event_guests WHERE ${WHERE} AND user_id NOT IN (${["''", ...wanted.map(() => "?")].join(",")})`,
              uid,
              key,
              date,
              ...wanted,
            ),
            // Own people (followers, people followed) by ID; anyone else only by the username typed now.
            ...wanted.map((id) =>
              stmt(
                db,
                `INSERT INTO event_guests(owner_id,event_key,event_on,user_id)
                SELECT ?1,?2,?3,?4 WHERE ?5=1 OR ${CONNECTED("?4")} ON CONFLICT DO NOTHING RETURNING user_id`,
                uid,
                key,
                date,
                id,
                named.includes(id) ? 1 : 0,
              ),
            ),
          ]
        : []),
    ]);
    const added = results
      .slice(2)
      .flatMap((r) =>
        (r.results as { user_id: string }[]).map((x) => x.user_id),
      );
    if (added.length)
      out.eventInvite(user, eventOf(specs, key, date), mode, added);
    return { invitations: await invitations(db, uid, uid) };
  }
  if (path === "/api/events/cancel" && method === "POST") {
    // «Передумал справлять»: the event stays, every invitation is withdrawn.
    const b = await body();
    const { specs, key, date } = await ownEvent(db, uid, b);
    const removed = (
      await stmt(
        db,
        `DELETE FROM event_guests WHERE ${WHERE} RETURNING user_id`,
        uid,
        key,
        date,
      ).all<{ user_id: string }>()
    ).results.map((r) => r.user_id);
    out.eventCancelled(user, eventOf(specs, key, date), removed);
    return { invitations: await invitations(db, uid, uid) };
  }
  const page = path.match(
    new RegExp(
      `^/api/events/(${ACCOUNT_ID_PART})/([a-z0-9_]+)/(\\d{4}-\\d{2}-\\d{2})$`,
    ),
  );
  if (page && method === "GET") {
    // The event page: anyone who sees the wishlist; the guests and the
    // description only for the owner and the guests.
    const [, ownerId, key, date] = page;
    const specs = await ownerSpecs(db, ownerId);
    if (!isUpcoming(specs, key, date))
      fail(404, "NOT_FOUND", "Мероприятие уже прошло или изменилось.");
    const party = (await invitations(db, ownerId, uid)).find(
      (p) => p.key === key && p.date === date,
    );
    if (!party && ownerId !== uid && !(await canView(ownerId))) missing();
    const owner = await stmt(
      db,
      "SELECT id,name,username FROM users WHERE id=?",
      ownerId,
    ).first<Person>();
    return {
      owner,
      event: eventOf(specs, key, date),
      mode: party?.mode || "hero",
      description: party?.description || "",
      guests: party?.guests || [],
      is_owner: ownerId === uid,
      invited: !!party && ownerId !== uid,
    };
  }
  return null;
}
const WHERE = "owner_id=? AND event_key=? AND event_on=?";
const missing = (): never => fail(404, "NOT_FOUND", "Мероприятие недоступно.");
/** The owner's upcoming event named in a request body. */
async function ownEvent(
  db: D1Database,
  uid: string,
  b: Record<string, unknown>,
) {
  const specs = await ownerSpecs(db, uid);
  const key = String(b.key ?? ""),
    date = String(b.date ?? "");
  if (!isUpcoming(specs, key, date))
    fail(404, "NOT_FOUND", "Мероприятие уже прошло или изменилось.");
  return { specs, key, date };
}
function eventOf(specs: EventSpec[], key: string, date: string) {
  return {
    key,
    title: specs.find((s) => s.key === key)?.title || "",
    date,
    days: Math.max(0, daysUntil(date)),
  };
}
