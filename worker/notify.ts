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
  /** Sends to users who allow notifications and whose chat is not known to be blocked. */
  send(ids: string[], text: string, keyboard?: Keyboard) {
    const unique = [...new Set(ids)];
    if (!unique.length || !this.env.BOT_TOKEN) return;
    this.jobs.push(
      (async () => {
        const rows = (
          await stmt(
            this.db,
            `SELECT id FROM users WHERE id IN (${unique.map(() => "?").join(",")}) AND notify=1 AND bot_blocked_at IS NULL`,
            ...unique,
          ).all<{ id: string }>()
        ).results;
        await Promise.all(
          rows.map(async ({ id }) => {
            const r = await telegramCall(this.env, "sendMessage", {
              chat_id: id,
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
  /** Subscribers who are still friends of the owner, minus people excluded. */
  private async subscribers(ownerId: string, exclude: string[] = []) {
    const rows = (
      await stmt(
        this.db,
        `SELECT s.subscriber_id AS id FROM subscriptions s JOIN friendships f
        ON f.status='accepted' AND ((f.user_a=s.subscriber_id AND f.user_b=?1) OR (f.user_b=s.subscriber_id AND f.user_a=?1))
        WHERE s.target_id=?1`,
        ownerId,
      ).all<{ id: string }>()
    ).results;
    return rows.map((r) => r.id).filter((id) => !exclude.includes(id));
  }
  async wishesAdded(owner: Named, gifts: GiftLike[]) {
    if (!gifts.length) return;
    const ids = await this.subscribers(owner.id);
    const shown = gifts.slice(0, 10);
    const text =
      gifts.length === 1
        ? `🎁 ${who(owner)} добавил(а) желание «${esc(gifts[0].title)}»${priced(gifts[0])}`
        : `🎁 ${who(owner)} добавил(а) желания (${gifts.length}):\n` +
          shown.map((g) => `• ${esc(g.title)}${priced(g)}`).join("\n") +
          (gifts.length > shown.length
            ? `\n…и ещё ${gifts.length - shown.length}`
            : "");
    this.send(ids, text, [
      [openButton(this.env, "Открыть вишлист", `l_${owner.id}`)],
    ]);
  }
  /**
   * The owner deleted or archived a wish. `booked` must be read before the
   * delete (reservations cascade). Booking friends get their own message.
   */
  async wishRemoved(
    owner: Named,
    gift: GiftLike,
    booked: string[],
    how: "deleted" | "changed_mind" | "bought_self" | "gifted",
  ) {
    const subscribers = await this.subscribers(owner.id, booked);
    this.send(
      subscribers,
      `🗑 ${who(owner)} убрал(а) из вишлиста желание «${esc(gift.title)}»`,
      [[openButton(this.env, "Открыть вишлист", `l_${owner.id}`)]],
    );
    const text =
      how === "deleted"
        ? `⚠️ ${who(owner)} удалил(а) из вишлиста «${esc(gift.title)}» — подарок, который вы забронировали. Бронь снята.`
        : how === "gifted"
          ? `🎉 ${who(owner)} отметил(а) «${esc(gift.title)}» как подаренный и убрал(а) его в архив. Бронь в «Моих бронях» можно удалить.`
          : `⚠️ ${who(owner)} убрал(а) в архив «${esc(gift.title)}» — подарок, который вы забронировали${how === "bought_self" ? " (купил(а) сам(а))" : ""}. Если вы его ещё не купили, отмените бронь.`;
    this.send(booked, text, [[openButton(this.env, "Мои брони", "b")]]);
  }
  /** The owner added their own event: subscribers learn how many days are left. */
  async eventAdded(owner: Named, event: EventLike) {
    this.send(
      await this.subscribers(owner.id),
      `📅 ${who(owner)} добавил(а) мероприятие «${esc(event.title)}»: ${when(event)}.`,
      [[openButton(this.env, "Открыть вишлист", `l_${owner.id}`)]],
    );
  }
  eventInvite(
    owner: Named,
    event: EventLike & { key: string },
    mode: "hero" | "everyone",
    ids: string[],
  ) {
    this.send(
      ids,
      `🎉 ${who(owner)} приглашает вас на «${esc(event.title)}»: ${when(event)}.\n\n` +
        (mode === "everyone"
          ? "Это праздник для всех: участники видят, кто из них что забронировал в вишлистах друг друга. В своём вишлисте никто этого не видит."
          : `В вишлисте ${esc(owner.name)} вы увидите, кто из приглашённых что забронировал. ${esc(owner.name)} этого не видит.`),
      [
        [
          openButton(
            this.env,
            "Открыть мероприятие",
            `e_${owner.id}_${event.key}_${event.date}`,
          ),
        ],
      ],
    );
  }
  eventCancelled(owner: Named, event: EventLike, ids: string[]) {
    this.send(
      ids,
      `${who(owner)} отменил(а) праздник «${esc(event.title)}» (${eventDay(event.date)}). Приглашение больше не действует.`,
    );
  }
  friendRequest(from: Named, to: string) {
    this.send(
      [to],
      `👋 ${who(from)} хочет добавить вас в друзья. Друзья видят вишлисты друг друга.`,
      [
        [
          { text: "✅ Принять", callback_data: `fa:${from.id}` },
          { text: "Отклонить", callback_data: `fd:${from.id}` },
        ],
      ],
    );
  }
  friendAdded(by: Named, to: string) {
    this.send(
      [to],
      `🤝 ${who(by)} теперь у вас в друзьях. Можно смотреть вишлисты друг друга.`,
      [[openButton(this.env, "Открыть вишлист друга", `l_${by.id}`)]],
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
  groupCancelled(organizer: Named, gift: GiftLike, ids: string[]) {
    this.send(
      ids,
      `${who(organizer)} отменил(а) бронь совместного подарка «${esc(gift.title)}».`,
    );
  }
}
