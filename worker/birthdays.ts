// Daily cron: friends get a reminder with a link to the wishlist a week and a day
// before a birthday. Only accepted friends are told; the person themself is not.
import { nextBirthday } from "../shared/birthday";
import { stmt, type Env } from "./core";
import { esc, openButton, type Outbox } from "./notify";
export const REMIND_DAYS = [7, 1];
export async function birthdayReminders(
  env: Env,
  out: Outbox,
  today = new Date(),
) {
  const db = env.DB;
  const people = (
    await stmt(
      db,
      `SELECT u.id,u.name,u.username,u.birthday,
        (SELECT COUNT(*) FROM gifts g WHERE g.owner_id=u.id AND g.archived_at IS NULL) AS gifts
      FROM users u WHERE u.birthday IS NOT NULL`,
    ).all<{
      id: string;
      name: string;
      username: string | null;
      birthday: string;
      gifts: number;
    }>()
  ).results;
  for (const p of people) {
    const next = nextBirthday(p.birthday, today);
    if (!next || !REMIND_DAYS.includes(next.days)) continue;
    // Once per birthday and lead time, even if the cron runs twice.
    const fresh = await stmt(
      db,
      "INSERT INTO birthday_notices(user_id,birthday_on,days) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING user_id",
      p.id,
      next.date.toISOString().slice(0, 10),
      next.days,
    ).first();
    if (!fresh) continue;
    // Only people with the bell on about this person who still see the list.
    const friends = await out.subscribers(p.id);
    const date = new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(next.date);
    const who = `<b>${esc(p.name)}</b>${p.username ? ` (@${esc(p.username)})` : ""}`;
    const when =
      next.days === 1 ? "Завтра" : `Через ${next.days} дней, ${date},`;
    out.send(
      friends,
      `🎂 ${when} день рождения у ${who}.\n` +
        (p.gifts
          ? `В вишлисте ${p.gifts} ${p.gifts % 10 === 1 && p.gifts % 100 !== 11 ? "желание" : p.gifts % 10 >= 2 && p.gifts % 10 <= 4 && (p.gifts % 100 < 12 || p.gifts % 100 > 14) ? "желания" : "желаний"} — выберите подарок, пока его не забронировали.`
          : "Вишлист пока пуст."),
      [[openButton(env, "Открыть вишлист", `l_${p.id}`)]],
    );
  }
}
