import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Miniflare } from "miniflare";

// The bot reads product screenshots with Workers AI. Telegram and the model are
// replaced: a local server answers the Bot API and serves the photo file, and a
// fake AI binding answers like the vision model.
const BOT = "123456:TEST_ONLY_NOT_A_REAL_TOKEN";
const secret = createHash("sha256").update(`webhook:${BOT}`).digest("hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1000, 7)]);
let mf: Miniflare;
let db: D1Database;
type Sent = { method: string; body: any };
const telegram: Sent[] = [];
const telegramServer = createServer((req, res) => {
  if (req.url?.startsWith("/file/")) {
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(JPEG);
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const method = String(req.url).split("/").pop()!;
    telegram.push({ method, body: raw ? JSON.parse(raw) : {} });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        result:
          method === "getFile"
            ? { file_path: "photos/file_1.jpg" }
            : { message_id: 1 },
      }),
    );
  });
});
const ANSWER = JSON.stringify({
  shop: "Ozon",
  full_title: "Пехорка Пряжа для вязания Детская объёмная, черная",
  title: "пряжа для вязания",
  details: "Пехорка, черная",
  price: "1 299 ₽",
  photo_box: [0.1, 0.1, 0.9, 0.5],
});
// Inline scripts lose non-ASCII text in Miniflare: the answer goes in as \u escapes.
const ascii = (s: string) =>
  s.replace(
    /[^\x00-\x7f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const FAKE_AI = `export default function () {
  return {
    async run(model, input) {
      if (model !== "@cf/meta/llama-3.2-11b-vision-instruct")
        return { response: "{}" };
      const image = input.messages?.[0]?.content?.[1]?.image_url?.url || "";
      if (!image.startsWith("data:image/jpeg;base64,"))
        throw new Error("5006: no image");
      return { response: ${ascii(JSON.stringify(ANSWER))} };
    },
  };
}`;
async function migrate(file: string) {
  const statements: string[] = [];
  let statement = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!statement && line.trimStart().startsWith("--")) continue;
    statement += line + " ";
    if (
      statement.trimStart().startsWith("CREATE TRIGGER")
        ? !/END;\s*$/.test(statement)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    statements.push(statement.trim());
    statement = "";
  }
  await db.batch(statements.map((sql) => db.prepare(sql)));
}
before(async () => {
  await new Promise<void>((r) => telegramServer.listen(0, "127.0.0.1", r));
  mf = new Miniflare({
    workers: [
      {
        name: "api",
        modules: true,
        scriptPath: ".test/worker.mjs",
        compatibilityDate: "2026-07-01",
        d1Databases: { DB: "test" },
        bindings: {
          BOT_TOKEN: BOT,
          APP_ORIGIN: "https://family.example",
          APP_URL: "https://family.example/app/",
          TELEGRAM_API: `http://127.0.0.1:${(telegramServer.address() as AddressInfo).port}`,
        },
        wrappedBindings: { AI: { scriptName: "fake-ai" } },
      },
      { name: "fake-ai", modules: true, script: FAKE_AI },
    ],
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const f of readdirSync("migrations").sort())
    await migrate(`migrations/${f}`);
});
after(async () => {
  await mf.dispose();
  telegramServer.close();
});

const sent = (chat: number) =>
  telegram.filter(
    (c) =>
      (c.method === "sendMessage" || c.method === "editMessageText") &&
      String(c.body.chat_id) === String(chat),
  );
/** Sends an update and waits for the bot's next message to that chat. */
async function hook(from: number, update: Record<string, unknown>) {
  const before = sent(from).length;
  const res = await mf.dispatchFetch(
    "https://api.example/api/telegram/webhook",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": secret,
      },
      body: JSON.stringify(update),
    },
  );
  assert.equal(res.status, 200);
  await res.text();
  for (let i = 0; i < 200 && sent(from).length <= before; i++)
    await new Promise((r) => setTimeout(r, 20));
  return sent(from).at(-1)!.body;
}
const user = (id: number) => ({ id, first_name: "Анна" });
const message = (from: number, extra: Record<string, unknown>) =>
  hook(from, {
    message: {
      message_id: 1,
      from: user(from),
      chat: { id: from, type: "private" },
      ...extra,
    },
  });
const photo = [
  { file_id: "small", file_size: 5000, width: 320 },
  { file_id: "big", file_size: 200000, width: 1280 },
];
const wishes = (owner: number) =>
  db
    .prepare(
      "SELECT id,title,description,price_minor,currency,photo FROM gifts WHERE owner_id=? ORDER BY created_at",
    )
    .bind(String(owner))
    .all<any>()
    .then((r) => r.results);

test("a screenshot sent to the bot becomes a wish with a name and price", async () => {
  const reply = await message(801, { photo });
  assert.match(reply.text, /Добавлено в вишлист/);
  assert.match(reply.text, /Прочитала фото нейросетью/);
  const [w] = await wishes(801);
  assert.equal(w.title, "Пряжа для вязания");
  assert.equal(w.description, "Пехорка, черная");
  assert.equal(w.price_minor, 129900);
  assert.equal(w.currency, "RUB");
  assert.match(w.photo, /^data:image\/jpeg;base64,/);
  // The larger copy went to the model, the smaller one is the wish photo.
  assert.deepEqual(
    telegram
      .filter((c) => c.method === "getFile")
      .map((c) => c.body.file_id)
      .sort(),
    ["big", "small"],
  );
  // A caption is the user's own name for the wish and is kept.
  await message(801, { photo, caption: "Пряжа для бабушки" });
  assert.equal((await wishes(801))[1].title, "Пряжа для бабушки");
  assert.equal((await wishes(801))[1].price_minor, 129900);
});

test("«По скриншоту» fills an existing wish; other messages end the wait", async () => {
  await message(802, { text: "➕ Добавить в вишлист" });
  const card = await message(802, { text: "Что-то с Ozon" });
  const buttons = card.reply_markup.inline_keyboard.flat();
  const [w] = await wishes(802);
  assert.ok(buttons.some((b: any) => b.callback_data === `e:shot:${w.id}`));
  const press = () =>
    hook(802, {
      callback_query: {
        id: "q",
        from: user(802),
        data: `e:shot:${w.id}`,
        message: { message_id: 9, chat: { id: 802, type: "private" } },
      },
    });
  assert.match((await press()).text, /скриншот карточки товара/);
  const updated = await message(802, { photo });
  assert.match(updated.text, /Обновлено/);
  const [after] = await wishes(802);
  assert.equal(after.title, "Пряжа для вязания");
  assert.equal(after.price_minor, 129900);
  assert.match(after.photo, /^data:image\/jpeg;base64,/);
  assert.equal((await wishes(802)).length, 1);
  // Waiting for a screenshot again, a text message is handled as usual.
  await press();
  await message(802, { text: "просто текст" });
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM bot_states WHERE user_id='802'")
      .first("n"),
    0,
  );
  assert.equal((await wishes(802))[0].title, "Пряжа для вязания");
});
