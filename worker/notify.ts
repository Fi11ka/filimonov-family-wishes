// Telegram Bot API calls and notifications. Messages never tell a wishlist owner
// who booked their gifts: owners are not recipients of any booking event.
import { formatPrice } from "../shared/price";
import { daysLeft, eventDay } from "../shared/events";
import { now, stmt, type Env } from "./core";
export type Button =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } }
  | { text: string; url: string };
export type Keyboard = Button[][];
export const telegramApi = (env: Env) =>
  env.TELEGRAM_API || "https://api.telegram.org";
export async function telegramCall(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
) {
  try {
    const res = await fetch(
      `${telegramApi(env)}/bot${env.BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown;
    };
    return { ok: !!data.ok, status: res.status, result: data.result };
  } catch {
    return { ok: false, status: 0, result: undefined };
  }
}
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The Mini App, optionally opened on a screen: l_<user id> is a friend's list, b is «Мои брони». */
export function appUrl(env: Env, open?: string) {
  const u = new URL(env.APP_URL);
  if (open) u.searchParams.set("open", open);
  return u.href;
}
export const openButton = (env: Env, text: string, open?: string): Button => ({
  text,
  web_app: { url: appUrl(env, open) },
});
type Named = { id: string; name: string; username?: string | null };
const who = (u: Named) =>
  `<b>${esc(u.name)}</b>${u.username ? ` (@${esc(u.username)})` : ""}`;
type EventLike = { title: string; date: string; days: number };
const when = (e: EventLike) => `${eventDay(e.date)}, ${daysLeft(e.days)}`;
type GiftLike = {
  id: string;
  title: string;
  price_minor: number | null;
  price_max_minor?: number | null;
  price_range?: number;
  currency: string;
};
const priced = (g: GiftLike) =>
  g.price_minor === null && (g.price_max_minor ?? null) === null
    ? ""
    : ` · ${formatPrice(g)}`;
/** Collects sends so the HTTP answer does not wait for Telegram (ctx.waitUntil). */
export class Outbox {
  jobs: Promise<unknown>[] = [];
  constructor(
    public env: Env,
    public db: D1Database,
  ) {}
  /**
   * Sends to users who allow notifications and whose chat is not known to be blocked.
   * The chat is the person's Telegram identity; people without Telegram are skipped.
   */
  send(ids: string[], text: string, keyboard?: Keyboard) {
    const unique = [...new Set(ids)];
    if (!unique.length || !this.env.BOT_TOKEN) return;
    this.jobs.push(
      (async () => {
        const rows = (
          await stmt(
            this.db,
            `SELECT u.id,i.subject AS chat FROM users u JOIN identities i ON i.user_id=u.id AND i.provider='telegram'
            WHERE u.id IN (${unique.map(() => "?").join(",")}) AND u.notify=1 AND u.bot_blocked_at IS NULL`,
            ...unique,
          ).all<{ id: string; chat: string }>()
        ).results;
        await Promise.all(
          rows.map(async ({ id, chat }) => {
            const r = await telegramCall(this.env, "sendMessage", {
              chat_id: chat,
              text,
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              ...(keyboard
                ? { reply_markup: { inline_keyboard: keyboard } }
                : {}),
            });
            // 403: the user never pressed Start or blocked the bot. Stop trying until they write.
            if (r.status === 403)
              await stmt(
                this.db,
                "UPDATE users SET bot_blocked_at=? WHERE id=?",
                now(),
                id,
              ).run();
          }),
        );
      })().catch(() => undefined),
    );
  }
  /** Waits for every job, including messages queued by jobs that were already running. */
  async done() {
    for (let seen = 0; seen < this.jobs.length;) {
      const batch = this.jobs.slice(seen);
      seen = this.jobs.length;
      await Promise.allSettled(batch);
    }
  }
  // ---- Events ----
  /**
   * People who have this person in their own «Друзья»: they added them and the
   * list is open to them. «Добавили вас» and pending requests do not count.
   */
  async friendsOf(personId: string, exclude: string[] = []) {
    const rows = (
      await stmt(
        this.db,
        "SELECT follower_id AS id FROM follows WHERE target_id=? AND status='approved'",
        personId,
      ).all<{ id: string }>()
    ).results;
    return rows.map((r) => r.id).filter((id) => !exclude.includes(id));
  }
  /**
   * The owner deleted or archived a wish someone chose. Only its givers hear about
   * it, each with the reason; their card stays in «Мои брони» (flow 16).
   */
  wishRemoved(
    owner: Named,
    gift: GiftLike,
    givers: string[],
    how: "deleted" | "changed_mind" | "bought_self" | "gifted",
  ) {
    const g = `«${esc(gift.title)}»`;
    const text = {
      deleted: `⚠️ ${who(owner)} удалил(а) из вишлиста ${g} — подарок, который вы выбрали. Бронь закрыта, карточка осталась в «Моих бронях».`,
      changed_mind: `⚠️ ${who(owner)} передумал(а): ${g} больше не нужен. Бронь закрыта. Если вы ещё не купили подарок, покупать не нужно.`,
      bought_self: `⚠️ ${who(owner)} купил(а) ${g} сам(а). Бронь закрыта. Если вы ещё не купили подарок, покупать не нужно.`,
      gifted: `🎁 ${who(owner)} отметил(а), что получил(а) ${g}. Если это ваш подарок, нажмите «Это подарил я» в «Моих бронях».`,
    }[how];
    this.send(givers, text, [[openButton(this.env, "Мои брони", "b")]]);
  }
  /** The owner changed a gift someone chose: the booking stays, they decide. */
  giftChanged(owner: Named, gift: GiftLike, givers: string[], fields: string[]) {
    const what = fields
      .map((f) => ({ title: "название", price: "цену", link: "ссылку" })[f])
      .join(", ");
    this.send(
      givers,
      `✏️ ${who(owner)} изменил(а) ${what} у подарка «${esc(gift.title)}», который вы выбрали${fields.includes("price") ? (priced(gift) ? `: теперь${priced(gift).slice(2)}` : ": теперь без цены") : ""}. Бронь осталась за вами.`,
      [[openButton(this.env, "Мои брони", "b")]],
    );
  }
  /**
   * A new event: friends who see the organizer's list learn how many days are
   * left. Those invited got an invitation instead, so they are skipped.
   */
  async eventAdded(owner: Named, event: EventLike & { id: string }, invited: string[] = []) {
    this.send(
      await this.friendsOf(owner.id, invited),
      `📅 ${who(owner)} добавил(а) мероприятие «${esc(event.title)}»: ${when(event)}.`,
      [[openButton(this.env, "Открыть мероприятие", `e_${event.id}`)]],
    );
  }
  /** Invited: a guest takes part at once and can decline in «Мероприятия» (П24). */
  eventInvite(
    owner: Named,
    event: EventLike & { id: string },
    mode: "hero" | "everyone",
    ids: string[],
  ) {
    this.send(
      ids,
      `🎉 ${who(owner)} приглашает вас на «${esc(event.title)}»: ${when(event)}.\n\n` +
        (mode === "everyone"
          ? "Это праздник для всех: участники видят, кто из них что забронировал в вишлистах друг друга. В своём вишлисте никто этого не видит."
          : `В вишлисте ${esc(owner.name)} вы увидите, кто из приглашённых что забронировал. ${esc(owner.name)} этого не видит.`) +
        "\n\nЕсли не сможете, нажмите «Отказаться от участия» в «Мероприятиях».",
      [[openButton(this.env, "Открыть мероприятие", `e_${event.id}`)]],
    );
  }
  /** The organizer moved the celebration or changed the place. Bookings stay. */
  eventChanged(
    owner: Named,
    event: EventLike & { id: string },
    ids: string[],
    what: { date: boolean; place: boolean },
  ) {
    const changed = [what.date && "дата празднования", what.place && "место"]
      .filter(Boolean)
      .join(" и ");
    this.send(
      ids,
      `📅 У мероприятия «${esc(event.title)}» ${who(owner)} изменилось: ${changed}. Теперь — ${when(event)}.`,
      [[openButton(this.env, "Открыть мероприятие", `e_${event.id}`)]],
    );
  }
  eventCancelled(owner: Named, event: EventLike, ids: string[]) {
    this.send(
      ids,
      `${who(owner)} отменил(а) праздник «${esc(event.title)}» (${eventDay(event.date)}). Приглашение больше не действует, ваши брони остались в «Моих бронях».`,
    );
  }
  /** «Напомнить» from an event with no wishes: the organizer is asked, nobody named. */
  eventRemind(ownerId: string, event: EventLike & { id: string }) {
    this.send(
      [ownerId],
      `🎁 Гости мероприятия «${esc(event.title)}» ждут ваших желаний. Добавьте в вишлист, что хотели бы получить.`,
      [[openButton(this.env, "Открыть мероприятие", `e_${event.id}`)]],
    );
  }
  followRequest(from: Named, to: string) {
    this.send(
      [to],
      `👋 ${who(from)} хочет добавить вас в друзья и видеть ваш вишлист.\n\n«Одобрить» — и вы тоже добавите этого человека в друзья.`,
      [
        [
          { text: "✅ Одобрить", callback_data: `fa:${from.id}` },
          { text: "Отклонить", callback_data: `fd:${from.id}` },
        ],
      ],
    );
  }
  /** `by` approved the request of `to`, and maybe added `to` back. */
  followApproved(by: Named, to: string, mutual = false) {
    this.send(
      [to],
      mutual
        ? `🤝 ${who(by)} принимает вас в друзья и добавляет в ответ. Теперь вам видны вишлисты друг друга.`
        : `🤝 ${who(by)} принимает вас в друзья. Теперь вам виден вишлист.`,
      [[openButton(this.env, "Открыть вишлист", `l_${by.id}`)]],
    );
  }
  /** `from` added `to`, whose list was open to them. `back`: `to` had added `from` already. */
  newFollower(from: Named, to: string, back = false) {
    this.send(
      [to],
      back
        ? `🤝 ${who(from)} добавляет вас в друзья в ответ.`
        : `👋 ${who(from)} добавляет вас в друзья.`,
      back
        ? [[openButton(this.env, "Открыть вишлист", `l_${from.id}`)]]
        : [
            [{ text: "➕ Добавить в ответ", callback_data: `fb:${from.id}` }],
            [openButton(this.env, "Открыть профиль", `l_${from.id}`)],
          ],
    );
  }
  groupInvite(organizer: Named, owner: Named, gift: GiftLike, ids: string[]) {
    this.send(
      ids,
      `🤝 ${who(organizer)} предлагает скинуться на подарок для ${who(owner)}: «${esc(gift.title)}»${priced(gift)}.\n\n${esc(owner.name)} об этом не узнает.`,
      [
        [
          { text: "✅ Участвую", callback_data: `gj:${gift.id}` },
          { text: "Не могу", callback_data: `gd:${gift.id}` },
        ],
        [openButton(this.env, "Мои брони", "b")],
      ],
    );
  }
  memberAnswered(
    member: Named,
    organizerId: string,
    gift: GiftLike,
    joined: boolean,
  ) {
    this.send(
      [organizerId],
      joined
        ? `✅ ${who(member)} участвует в совместном подарке «${esc(gift.title)}».`
        : `${who(member)} не участвует в совместном подарке «${esc(gift.title)}».`,
      [[openButton(this.env, "Мои брони", "b")]],
    );
  }
  groupDissolved(organizer: Named, gift: GiftLike, ids: string[]) {
    this.send(
      ids,
      `${who(organizer)} купит «${esc(gift.title)}» сам(а): совместный подарок отменён, скидываться не нужно.`,
      [[openButton(this.env, "Мои брони", "b")]],
    );
  }
  groupCancelled(organizer: Named, gift: GiftLike, ids: string[]) {
    this.send(
      ids,
      `${who(organizer)} отменил(а) бронь совместного подарка «${esc(gift.title)}».`,
    );
  }
}
