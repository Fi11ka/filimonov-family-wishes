// Events in a wishlist header: the birthday, New Year, 8 March or 23 February
// (by gender) and one event of the owner's own. Used by the Worker and the app.
import { validBirthday } from "./birthday";
export type Gender = "female" | "male";
export type EventKey = "birthday" | "new_year" | "march8" | "feb23" | "custom";
/** How an event repeats: "MM-DD" every year, "YYYY-MM-DD" once (custom). */
export interface EventSpec {
  key: EventKey;
  title: string;
  on: string;
}
export interface UpcomingEvent {
  key: EventKey;
  title: string;
  /** YYYY-MM-DD of the next occurrence. */
  date: string;
  days: number;
}
export const EVENT_KEYS: EventKey[] = [
  "birthday",
  "new_year",
  "march8",
  "feb23",
  "custom",
];
export const isGender = (v: unknown): v is Gender =>
  v === "female" || v === "male";
export function validEventDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function eventSpecs(p: {
  birthday?: string | null;
  gender?: string | null;
  event_title?: string | null;
  event_date?: string | null;
}): EventSpec[] {
  const specs: EventSpec[] = [];
  if (p.birthday && validBirthday(p.birthday))
    specs.push({ key: "birthday", title: "День рождения", on: p.birthday });
  specs.push({ key: "new_year", title: "Новый год", on: "01-01" });
  if (p.gender === "female")
    specs.push({ key: "march8", title: "8 Марта", on: "03-08" });
  if (p.gender === "male")
    specs.push({ key: "feb23", title: "23 Февраля", on: "02-23" });
  if (p.event_title && validEventDate(p.event_date))
    specs.push({ key: "custom", title: p.event_title, on: p.event_date });
  return specs;
}
/** Calendar day of `today` in its own timezone, as a UTC timestamp. */
const dayOf = (today: Date) =>
  Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
/** Next occurrences from today (inclusive), nearest first; past custom events are dropped.
 * February 29 falls on February 28 in a non-leap year, as birthdays do. */
export function upcomingEvents(
  specs: EventSpec[],
  today = new Date(),
): UpcomingEvent[] {
  const current = dayOf(today);
  const found: UpcomingEvent[] = [];
  for (const s of specs) {
    let at: number;
    if (s.on.length === 10) {
      at = Date.parse(`${s.on}T00:00:00Z`);
      if (isNaN(at) || at < current) continue;
    } else {
      const [month, day] = s.on.split("-").map(Number);
      const inYear = (year: number) =>
        Date.UTC(
          year,
          month - 1,
          Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate()),
        );
      at = inYear(today.getFullYear());
      if (at < current) at = inYear(today.getFullYear() + 1);
    }
    found.push({
      key: s.key,
      title: s.title,
      date: new Date(at).toISOString().slice(0, 10),
      days: Math.round((at - current) / 86400000),
    });
  }
  return found.sort((a, b) => a.days - b.days || a.key.localeCompare(b.key));
}
/** Calendar days from today to a YYYY-MM-DD date (negative once it has passed). */
export const daysUntil = (date: string, today = new Date()) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - dayOf(today)) / 86400000);
/** Whether (key, date) is an upcoming event; a day either side allows for timezones. */
export function isUpcoming(
  specs: EventSpec[],
  key: string,
  date: string,
  now = Date.now(),
) {
  return [-1, 0, 1].some((shift) =>
    upcomingEvents(specs, new Date(now + shift * 86400000)).some(
      (e) => e.key === key && e.date === date,
    ),
  );
}
export const dayWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? "день"
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? "дня"
      : "дней";
/** "сегодня", "завтра", "через 5 дней". */
export const untilText = (days: number) =>
  days === 0
    ? "сегодня"
    : days === 1
      ? "завтра"
      : `через ${days} ${dayWord(days)}`;
/** "осталось 5 дней", "остался 21 день", "сегодня". */
export const daysLeft = (days: number) =>
  days <= 0
    ? "сегодня"
    : `${dayWord(days) === "день" ? "остался" : "осталось"} ${days} ${dayWord(days)}`;
/** "12 ноября" (UTC, so the date does not shift). */
export const eventDay = (date: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
