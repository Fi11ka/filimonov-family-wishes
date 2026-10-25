// @FilimonovFamilyWishes_bot: chat buttons «Добавить в вишлист», «Мои желания»,
// «Открыть вишлист», editing one's own wishes and answers to notifications.
// Updates arrive by webhook; Telegram proves itself with the secret_token header.
import { formatPrice, parsePriceText } from "../shared/price";
import { giftInfo, now, pair, saveUser, stmt, type Env } from "./core";
import {
  archiveGift,
  createGift,
  deleteGift,
  ownGift,
  type ArchiveReason,
  type StoredGift,
} from "./gifts";
import { homeHelper } from "./helper";
import {
  Outbox,
  esc,
  openButton,
  telegramApi,
  telegramCall,
  type Keyboard,
} from "./notify";
import {
  ApiError,
  fail,
  giftInput,
  hash,
  https,
  usernameOf,
  type Identity,
} from "./security";
import { liveContext, lookupProduct } from "./shops";
import { aiNamer } from "./shops/naming";
type Rate = (db: D1Database, key: string, max: number) => Promise<void>;
/** Derived from the bot token, so no extra secret has to be configured. */
export async function webhookSecret(botToken: string) {
  return hash(`webhook:${botToken}`);
}
export function cleanupBotStates(db: D1Database) {
  return stmt(db, "DELETE FROM bot_states WHERE updated_at<?", now() - 86400);
}
const ADD = "➕ Добавить в вишлист",
  LIST = "📋 Мои желания",
  OPEN = "🎁 Открыть вишлист";
const PAGE = 8;
// Telegram limits: 512 and 120 characters.
export const BOT_DESCRIPTION =
  "🎁 Вишлист от задротов Насти, Дарины и Димы\n\n" +
  "• Собирайте свои желания: пришлите ссылку на товар — название, цену и фото бот подтянет сам\n" +
  "• Смотрите вишлисты друзей и тайно бронируйте подарки — владелец не узнает, кто выбрал\n" +
  "• Скидывайтесь на подарок вместе с друзьями\n" +
  "• Получайте напоминания о днях рождения и новых желаниях друзей\n\n" +
  "Нажмите «Запустить», чтобы начать.";
export const BOT_SHORT_DESCRIPTION =
  "Вишлист от задротов Насти, Дарины и Димы: желания, тайные брони, совместные подарки, дни рождения.";
const priorities = ["", "Будет приятно", "Очень хочется", "Мечта"];
export async function botRoute(
  req: Request,
  env: Env,
  out: Outbox,
  rate: Rate,
): Promise<unknown> {
  const path = new URL(req.url).pathname;
  if (path === "/api/telegram/setup" && req.method === "GET") {
    // Idempotent: points the webhook at this Worker. Opened once by the owner after deploy.
    await rate(
      env.DB,
      `botsetup:${await hash(req.headers.get("cf-connecting-ip") || "local")}`,
      5,
    );
    const url = `${new URL(req.url).origin}/api/telegram/webhook`;
    const webhook = await telegramCall(env, "setWebhook", {
      url,
      secret_token: await webhookSecret(env.BOT_TOKEN),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    const commands = await telegramCall(env, "setMyCommands", {
      commands: [
        { command: "start", description: "Меню" },
        { command: "add", description: "Добавить желание" },
        { command: "list", description: "Мои желания" },
        { command: "cancel", description: "Отменить ввод" },
      ],
    });
    // Shown in an empty chat before «Запустить» and in the bot's profile.
    const description = await telegramCall(env, "setMyDescription", {
      description: BOT_DESCRIPTION,
    });
    const short = await telegramCall(env, "setMyShortDescription", {
      short_description: BOT_SHORT_DESCRIPTION,
    });
    return {
      ok: webhook.ok && commands.ok && description.ok && short.ok,
      webhook: url,
    };
  }
  if (path === "/api/telegram/webhook" && req.method === "POST") {
    const secret = req.headers.get("x-telegram-bot-api-secret-token") || "";
    if (secret !== (await webhookSecret(env.BOT_TOKEN)))
      fail(401, "AUTH_INVALID", "Неверный секрет.");
    if (Number(req.headers.get("content-length") || 0) > 1_000_000)
      fail(413, "TOO_LARGE", "Слишком большой запрос.");
    const update = (await req.json().catch(() => null)) as Update | null;
    // Answer Telegram at once; slow shop lookups must not cause redelivery.
    if (update) out.jobs.push(handleUpdate(update, env, out, rate));
    return { ok: true };
  }
  fail(404, "NOT_FOUND", "Раздел не найден.");
}
interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface Update {
  message?: {
    message_id: number;
    from?: TgUser;
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    photo?: { file_id: string; file_size?: number; width: number }[];
  };
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { message_id: number; chat: { id: number; type: string } };
  };
}
function identity(u: TgUser): Identity {
  return {
    id: String(u.id),
    name:
      [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 160) ||
      "Участник",
    username: usernameOf(u.username),
  };
}
class Chat {
  constructor(
    public env: Env,
    public db: D1Database,
    public out: Outbox,
    public user: Identity,
    /** The message a pressed inline button belongs to; replies replace it. */
    public messageId?: number,
  ) {}
  async say(text: string, keyboard?: Keyboard | "menu") {
    const reply_markup =
      keyboard === "menu"
        ? {
            keyboard: [[{ text: ADD }, { text: LIST }], [{ text: OPEN }]],
            resize_keyboard: true,
            is_persistent: true,
          }
        : keyboard
          ? { inline_keyboard: keyboard }
          : undefined;
    const payload = {
      chat_id: this.user.id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(reply_markup ? { reply_markup } : {}),
    };
    if (this.messageId && keyboard !== "menu") {
      const r = await telegramCall(this.env, "editMessageText", {
        ...payload,
        message_id: this.messageId,
      });
      if (r.ok) return;
    }
    await telegramCall(this.env, "sendMessage", payload);
  }
  state(action: string | null, giftId: string | null = null) {
    return action
      ? stmt(
          this.db,
          "INSERT INTO bot_states(user_id,action,gift_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET action=excluded.action,gift_id=excluded.gift_id,updated_at=excluded.updated_at",
          this.user.id,
          action,
          giftId,
          now(),
        ).run()
      : stmt(
          this.db,
          "DELETE FROM bot_states WHERE user_id=?",
          this.user.id,
        ).run();
  }
  async welcome() {
    await this.state(null);
    await this.say(
      `Привет, ${esc(this.user.name.split(" ")[0])}! Это семейный вишлист.\n\n` +
        `<b>${ADD}</b> — пришлите ссылку на товар, название или фото.\n` +
        `<b>${LIST}</b> — посмотреть и изменить свои желания.\n` +
        `<b>${OPEN}</b> — вишлисты друзей, брони и подписки.\n\n` +
        "Сюда же приходят уведомления: заявки в друзья, новые желания друзей, на которых вы подписаны, и приглашения скинуться на подарок.",
      "menu",
    );
  }
  async open() {
    await this.say("Вишлист открывается в Telegram, вход не нужен:", [
      [openButton(this.env, OPEN)],
    ]);
  }
  async askNew() {
    await this.state("add");
    await this.say(
      "Пришлите <b>ссылку на товар</b> — я подтяну название, цену и фото. Или просто напишите название, можно с фото.\n\n/cancel — отменить",
    );
  }
  async list(page: number) {
    const rows = (
      await stmt(
        this.db,
        "SELECT id,title FROM gifts WHERE owner_id=? AND archived_at IS NULL ORDER BY priority DESC,created_at DESC,id LIMIT ? OFFSET ?",
        this.user.id,
        PAGE + 1,
        page * PAGE,
      ).all<{ id: string; title: string }>()
    ).results;
    if (!rows.length && page === 0) {
      await this.say("В вишлисте пока пусто.", [
        [{ text: ADD, callback_data: "add" }],
      ]);
      return;
    }
    const keyboard: Keyboard = rows
      .slice(0, PAGE)
      .map((g) => [{ text: g.title.slice(0, 60), callback_data: `g:${g.id}` }]);
    const nav = [];
    if (page > 0) nav.push({ text: "← Назад", callback_data: `l:${page - 1}` });
    if (rows.length > PAGE)
      nav.push({ text: "Дальше →", callback_data: `l:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([
      { text: ADD, callback_data: "add" },
      openButton(this.env, "Открыть"),
    ]);
    await this.say("Ваши желания. Выберите, что изменить:", keyboard);
  }
  async card(g: StoredGift, headline = "") {
    const lines = [
      headline,
      `<b>${esc(g.title)}</b>`,
      `💰 ${esc(formatPrice(g))}`,
      `⭐ ${priorities[g.priority]}`,
      g.description ? `📝 ${esc(g.description)}` : "",
      g.shop_url ? `🔗 ${esc(g.shop_url)}` : "",
    ].filter(Boolean);
    await this.say(lines.join("\n"), [
      [
        { text: "✏️ Название", callback_data: `e:title:${g.id}` },
        { text: "💰 Цена", callback_data: `e:price:${g.id}` },
      ],
      [
        { text: "📝 Подсказка", callback_data: `e:desc:${g.id}` },
        { text: "🔗 Ссылка", callback_data: `e:link:${g.id}` },
      ],
      [
        { text: "📷 Фото", callback_data: `e:photo:${g.id}` },
        { text: "⭐ Важность", callback_data: `r:${g.id}` },
      ],
      [
        { text: "🗄 В архив", callback_data: `a:${g.id}` },
        { text: "🗑 Удалить", callback_data: `x:${g.id}` },
      ],
      [{ text: "← Все желания", callback_data: "l:0" }],
    ]);
  }
  async gift(id: string) {
    const g = await ownGift(this.db, this.user.id, id);
    if (!g || g.archived_at !== null) {
      await this.say("Этого желания уже нет в вишлисте.", [
        [{ text: "← Все желания", callback_data: "l:0" }],
      ]);
      return null;
    }
    return g;
  }
  /** A new wish from text (maybe with a shop link) and/or a photo. */
  async create(text: string, photo = "") {
    const link = text.match(/https:\/\/\S+/)?.[0] || "";
    let title = text.replace(link, "").replace(/\s+/g, " ").trim(),
      description = "",
      image = photo,
      price: { min: number | null; max: number | null; range: boolean } = {
        min: null,
        max: null,
        range: false,
      };
    let currency =
      (
        await stmt(
          this.db,
          "SELECT currency FROM gifts WHERE owner_id=? ORDER BY created_at DESC LIMIT 1",
          this.user.id,
        ).first<{ currency: string }>()
      )?.currency || "RUB";
    if (link) {
      await telegramCall(this.env, "sendChatAction", {
        chat_id: this.user.id,
        action: "typing",
      });
      try {
        const p = await lookupProduct(
          link,
          liveContext(this.env.HELPER_TOKEN ? homeHelper(this.db) : null),
          this.env.AI ? aiNamer(this.env.AI) : undefined,
        );
        if (!title) title = p.title;
        description = p.details || "";
        if (!image && /^https:\/\//.test(p.image_url)) image = p.image_url;
        if (p.price) {
          price = {
            min: p.price.min_minor,
            max: p.price.max_minor,
            range: p.price.max_minor !== null,
          };
          currency = p.price.currency;
        }
      } catch {
        // The shop could not be read: the wish is saved with the link only.
      }
    }
    if (!title) title = link ? "Желание по ссылке" : "Новое желание";
    const values = giftInput({
      title: title.slice(0, 120),
      description: description.slice(0, 2000),
      currency,
      price_minor: price.min,
      price_max_minor: price.range ? price.max : null,
      price_range: price.range,
      priority: 2,
      shop_url: link.slice(0, 2048),
      photo: image.length <= 220000 ? image : "",
    });
    const id = await createGift(this.db, this.out, this.user, values);
    await this.state(null);
    const g = await ownGift(this.db, this.user.id, id);
    if (g)
      await this.card(
        g,
        `✅ Добавлено в вишлист${link && price.min === null && price.max === null ? ". Цену магазин не отдал — укажите её кнопкой «Цена»." : "."}\n`,
      );
  }
  async edit(action: string, g: StoredGift, text: string) {
    const clear = text.trim() === "-";
    if (action === "title") {
      const title = text.trim().slice(0, 120);
      if (!title) return this.say("Название не может быть пустым.");
      await this.set(g, "title", title);
    } else if (action === "desc")
      await this.set(g, "description", clear ? "" : text.trim().slice(0, 2000));
    else if (action === "link") {
      let link = "";
      if (!clear)
        try {
          link = https(text.trim());
        } catch {
          return this.say(
            "Ссылка должна начинаться с https://. Или «-», чтобы убрать.",
          );
        }
      await this.set(g, "shop_url", link);
    } else if (action === "price") {
      if (clear)
        await stmt(
          this.db,
          "UPDATE gifts SET price_minor=NULL,price_max_minor=NULL,price_range=0,updated_at=unixepoch() WHERE id=? AND owner_id=?",
          g.id,
          this.user.id,
        ).run();
      else {
        const p = parsePriceText(text);
        if (!p.exact || (p.min === null && p.max === null))
          return this.say(
            "Не поняла цену. Примеры: <code>2500</code>, <code>1000-3000</code>, <code>от 500</code>, <code>40 €</code>.",
          );
        await stmt(
          this.db,
          "UPDATE gifts SET price_minor=?,price_max_minor=?,price_range=?,currency=?,updated_at=unixepoch() WHERE id=? AND owner_id=?",
          p.min,
          p.range ? p.max : null,
          p.range ? 1 : 0,
          p.currency || g.currency,
          g.id,
          this.user.id,
        ).run();
      }
    } else return;
    await this.state(null);
    const fresh = await ownGift(this.db, this.user.id, g.id);
    if (fresh) await this.card(fresh, "✅ Сохранено\n");
  }
  private async set(g: StoredGift, column: string, value: string) {
    await stmt(
      this.db,
      `UPDATE gifts SET ${column}=?,updated_at=unixepoch() WHERE id=? AND owner_id=?`,
      value,
      g.id,
      this.user.id,
    ).run();
  }
}
const prompts: Record<string, string> = {
  title: "Пришлите новое название.",
  price:
    "Пришлите цену: <code>2500</code>, <code>1000-3000</code>, <code>от 500</code> или <code>40 €</code>. «-» — убрать цену.",
  desc: "Пришлите подсказку для близких (размер, цвет…). «-» — убрать.",
  link: "Пришлите ссылку на товар (https://…). «-» — убрать.",
  photo: "Пришлите фото.",
};
async function handleUpdate(update: Update, env: Env, out: Outbox, rate: Rate) {
  const db = env.DB;
  const callback = update.callback_query;
  const message = update.message;
  const from = callback?.from || message?.from;
  if (!from || from.is_bot || !Number.isSafeInteger(from.id)) return;
  if (message && message.chat.type !== "private") return;
  const user = identity(from);
  const chat = new Chat(env, db, out, user, callback?.message?.message_id);
  try {
    await saveUser(db, user);
    // Writing to the bot means it can write back.
    await stmt(
      db,
      "UPDATE users SET bot_chat_at=?,bot_blocked_at=NULL WHERE id=?",
      now(),
      user.id,
    ).run();
    await rate(db, `bot:${user.id}`, 30);
    if (callback) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
      });
      await onButton(chat, callback.data || "");
    } else if (message) await onMessage(chat, message);
  } catch (e) {
    const text =
      e instanceof ApiError
        ? esc(e.message)
        : "Не получилось. Попробуйте ещё раз.";
    await telegramCall(env, "sendMessage", { chat_id: user.id, text });
  }
}
async function onMessage(chat: Chat, m: NonNullable<Update["message"]>) {
  const text = (m.text || m.caption || "").trim();
  const command = text.split(/[\s@]/)[0];
  if (command === "/start" || command === "/menu" || command === "/help")
    return chat.welcome();
  if (command === "/cancel" || text === "Отмена") {
    await chat.state(null);
    return chat.say("Хорошо, отменила.", "menu");
  }
  if (command === "/add" || text === ADD) return chat.askNew();
  if (command === "/list" || text === LIST) {
    await chat.state(null);
    return chat.list(0);
  }
  if (text === OPEN) return chat.open();
  const state = await stmt(
    chat.db,
    "SELECT action,gift_id FROM bot_states WHERE user_id=? AND updated_at>?",
    chat.user.id,
    now() - 86400,
  ).first<{ action: string; gift_id: string | null }>();
  const photo = m.photo?.length ? await telegramPhoto(chat.env, m.photo) : null;
  if (m.photo?.length && photo === null)
    return chat.say("Не удалось загрузить фото. Попробуйте фото поменьше.");
  if (state?.gift_id) {
    const g = await chat.gift(state.gift_id);
    if (!g) return chat.state(null);
    if (state.action === "photo") {
      if (!photo) return chat.say(prompts.photo);
      await stmt(
        chat.db,
        "UPDATE gifts SET photo=?,updated_at=unixepoch() WHERE id=? AND owner_id=?",
        photo,
        g.id,
        chat.user.id,
      ).run();
      await chat.state(null);
      return chat.card(g, "✅ Фото обновлено\n");
    }
    if (!text) return chat.say(prompts[state.action] || "Пришлите текст.");
    return chat.edit(state.action, g, text);
  }
  // A link or a photo is always a new wish; plain text only after «Добавить».
  if (state?.action === "add" || photo || /https:\/\//.test(text)) {
    if (!text && !photo) return chat.askNew();
    return chat.create(text, photo || "");
  }
  return chat.say(
    `Нажмите <b>${ADD}</b> или пришлите ссылку на товар — я добавлю его в вишлист.`,
    "menu",
  );
}
async function onButton(chat: Chat, data: string) {
  const [kind, a = "", b = ""] = data.split(":");
  const uid = chat.user.id;
  if (kind === "add") {
    chat.messageId = undefined;
    return chat.askNew();
  }
  if (kind === "l") return chat.list(Math.max(0, Number(a) || 0));
  if (kind === "g") {
    const g = await chat.gift(a);
    if (g) await chat.card(g);
    return;
  }
  if (kind === "e" && prompts[a]) {
    const g = await chat.gift(b);
    if (!g) return;
    await chat.state(a, g.id);
    chat.messageId = undefined;
    return chat.say(`«${esc(g.title)}»\n${prompts[a]}\n\n/cancel — отменить`);
  }
  if (kind === "r") {
    const g = await chat.gift(a);
    if (!g) return;
    return chat.say(`Насколько хочется «${esc(g.title)}»?`, [
      [1, 2, 3].map((p) => ({
        text: `${p === g.priority ? "✓ " : ""}${priorities[p]}`,
        callback_data: `p:${p}:${g.id}`,
      })),
      [{ text: "← Назад", callback_data: `g:${g.id}` }],
    ]);
  }
  if (kind === "p" && ["1", "2", "3"].includes(a)) {
    const g = await chat.gift(b);
    if (!g) return;
    await stmt(
      chat.db,
      "UPDATE gifts SET priority=?,updated_at=unixepoch() WHERE id=? AND owner_id=?",
      Number(a),
      g.id,
      uid,
    ).run();
    return chat.card({ ...g, priority: Number(a) }, "✅ Сохранено\n");
  }
  if (kind === "a") {
    const g = await chat.gift(a);
    if (!g) return;
    return chat.say(`Почему убираете «${esc(g.title)}» в архив?`, [
      [
        { text: "Подарили", callback_data: `ar:gifted:${g.id}` },
        { text: "Купил(а) сам(а)", callback_data: `ar:bought_self:${g.id}` },
      ],
      [{ text: "Передумал(а)", callback_data: `ar:changed_mind:${g.id}` }],
      [{ text: "← Назад", callback_data: `g:${g.id}` }],
    ]);
  }
  if (kind === "ar" && ["gifted", "bought_self", "changed_mind"].includes(a)) {
    const g = await chat.gift(b);
    if (!g) return;
    await archiveGift(chat.db, chat.out, chat.user, g.id, a as ArchiveReason);
    return chat.say(
      `🗄 «${esc(g.title)}» в архиве. Вернуть можно в приложении.`,
      [[{ text: "← Все желания", callback_data: "l:0" }]],
    );
  }
  if (kind === "x") {
    const g = await chat.gift(a);
    if (!g) return;
    return chat.say(`Удалить «${esc(g.title)}» навсегда?`, [
      [
        { text: "🗑 Да, удалить", callback_data: `xx:${g.id}` },
        { text: "Нет", callback_data: `g:${g.id}` },
      ],
    ]);
  }
  if (kind === "xx") {
    const g = await chat.gift(a);
    if (!g) return;
    await deleteGift(chat.db, chat.out, chat.user, g.id);
    return chat.say(`«${esc(g.title)}» удалено.`, [
      [{ text: "← Все желания", callback_data: "l:0" }],
    ]);
  }
  // ---- Answers to notifications ----
  if ((kind === "fa" || kind === "fd") && /^\d+$/.test(a)) {
    const [x, y] = pair(uid, a);
    const r = await stmt(
      chat.db,
      kind === "fa"
        ? "UPDATE friendships SET status='accepted',accepted_at=unixepoch() WHERE user_a=? AND user_b=? AND status='pending' AND requested_by=? RETURNING user_a"
        : "DELETE FROM friendships WHERE user_a=? AND user_b=? AND status='pending' AND requested_by=? RETURNING user_a",
      x,
      y,
      a,
    ).first();
    if (!r) return chat.say("Заявка уже неактуальна.");
    if (kind === "fd") return chat.say("Заявка отклонена.");
    chat.out.friendAdded(chat.user, a);
    return chat.say("✅ Теперь вы друзья.", [
      [openButton(chat.env, "Открыть вишлист друга", `l_${a}`)],
    ]);
  }
  if ((kind === "gj" || kind === "gd") && /^[a-f0-9-]{36}$/.test(a)) {
    const r = await stmt(
      chat.db,
      kind === "gj"
        ? "UPDATE reservation_members SET status='joined' WHERE gift_id=? AND user_id=? AND status='invited' RETURNING status"
        : "DELETE FROM reservation_members WHERE gift_id=? AND user_id=? AND status='invited' RETURNING status",
      a,
      uid,
    ).first();
    if (!r) return chat.say("Приглашение уже неактуально.");
    const info = await giftInfo(chat.db, a);
    if (info?.organizer)
      chat.out.memberAnswered(
        chat.user,
        info.organizer,
        info.gift,
        kind === "gj",
      );
    return chat.say(
      kind === "gj"
        ? `✅ Вы участвуете в подарке «${esc(info?.gift.title || "")}». Договоритесь с организатором о покупке.`
        : "Вы отказались от участия.",
      [[openButton(chat.env, "Мои брони", "b")]],
    );
  }
}
/** The biggest size of a Telegram photo that fits a wish photo (data URL ≤ 220 000 chars). */
async function telegramPhoto(
  env: Env,
  sizes: { file_id: string; file_size?: number; width: number }[],
) {
  const fit = [...sizes]
    .sort((x, y) => y.width - x.width)
    .find((s) => (s.file_size || 0) > 0 && (s.file_size || 0) <= 150_000);
  if (!fit) return null;
  const file = await telegramCall(env, "getFile", { file_id: fit.file_id });
  const path = (file.result as { file_path?: string } | undefined)?.file_path;
  if (!file.ok || !path || !/^[\w./-]+$/.test(path)) return null;
  try {
    const res = await fetch(
      `${telegramApi(env)}/file/bot${env.BOT_TOKEN}/${path}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (
      !res.ok ||
      bytes.length > 150_000 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8
    )
      return null;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
