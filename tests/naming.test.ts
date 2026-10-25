import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupProduct } from "../worker/shops";
import {
  aiNamer,
  NAMING_MODEL,
  isShortRussian,
  parseWishName,
  type AiBinding,
} from "../worker/shops/naming";
import type { ShopContext } from "../worker/shops/types";

const amazonTitle =
  "KnitPro Nova Metal Deluxe Knitting Needle Tips Set 3.50 4.00 4.50 5.00 5.50 6.00 7.00 8mm";

function fakeAi(answer: unknown, calls: unknown[] = []): AiBinding {
  return {
    async run(model, input) {
      calls.push({ model, input });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("model answers are validated and normalised", () => {
  assert.deepEqual(
    parseWishName({
      response: { title: "набор спиц", details: "KnitPro Nova Metal Deluxe" },
    }),
    { title: "Набор спиц", details: "KnitPro Nova Metal Deluxe" },
  );
  // Text answers with stray words around the JSON are accepted.
  assert.deepEqual(
    parseWishName({
      response:
        'Вот: {"title":"«Пряжа для вязания»","details":"Пехорка, черная"}',
    }),
    { title: "Пряжа для вязания", details: "Пехорка, черная" },
  );
  // No Russian name, empty or broken output: keep the shop title.
  assert.equal(
    parseWishName({ response: { title: "Needles", details: "" } }),
    null,
  );
  assert.equal(parseWishName({ response: "not json" }), null);
  assert.equal(parseWishName(null), null);
  const long = parseWishName({
    response: { title: "Я".repeat(200), details: "д\n\tе".repeat(400) },
  });
  assert.equal(long?.title.length, 60);
  assert.ok((long?.details.length ?? 0) <= 300);
  assert.doesNotMatch(long?.details ?? "", /[\n\t]/);
});

test("short Russian titles skip the model call", async () => {
  assert.equal(isShortRussian("Набор спиц"), true);
  assert.equal(
    isShortRussian("Пехорка Пряжа для вязания Детская объёмная"),
    false,
  );
  assert.equal(isShortRussian(amazonTitle), false);
  const calls: unknown[] = [];
  const namer = aiNamer(
    fakeAi({ response: { title: "X", details: "" } }, calls),
  );
  assert.equal(await namer("Тапочки", "Яндекс Маркет"), null);
  assert.equal(calls.length, 0);
});

test("model failures and timeouts fall back to the shop title", async () => {
  assert.equal(
    await aiNamer(fakeAi(new Error("quota")))(amazonTitle, null),
    null,
  );
  const slow: AiBinding = { run: () => new Promise(() => {}) };
  const started = Date.now();
  // The real timeout is 9 s; a short one here checks that a hung call resolves.
  const result = await Promise.race([
    aiNamer(slow, NAMING_MODEL, 50)(amazonTitle, null),
    new Promise((r) => setTimeout(() => r("still waiting"), 2000)),
  ]);
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2000);
});

const amazonPage = `<html><head><meta property="og:title" content="${amazonTitle}">
<meta property="og:image" content="https://m.media-amazon.com/images/I/1.jpg"></head>
<body><span id="productTitle">${amazonTitle}</span>
<div id="corePrice_feature_div"><span class="a-offscreen">52,87 €</span></div></body></html>`;
const ctx: ShopContext = {
  async page(url) {
    return { url, status: 200, html: amazonPage };
  },
  async json() {
    throw new Error("HTTP 403");
  },
};

test("lookup shortens the title and moves the details to the hint", async () => {
  const calls: { input: { messages: { content: string }[] } }[] = [];
  const r = await lookupProduct(
    "https://www.amazon.es/dp/B0C9TP6DD5/ref=x?tag=ad-21",
    ctx,
    aiNamer(
      fakeAi(
        {
          response: {
            title: "Набор спиц",
            details: "KnitPro Nova Metal Deluxe, наконечники 3,5–8 мм",
          },
        },
        calls as unknown[],
      ),
    ),
  );
  assert.equal(r.title, "Набор спиц");
  assert.equal(r.details, "KnitPro Nova Metal Deluxe, наконечники 3,5–8 мм");
  assert.match(calls[0].input.messages[1].content, /KnitPro Nova Metal Deluxe/);
  assert.match(calls[0].input.messages[1].content, /Amazon/);
});

test("without details from the model the full shop title becomes the hint", async () => {
  const r = await lookupProduct(
    "https://www.amazon.es/dp/B0C9TP6DD5",
    ctx,
    aiNamer(fakeAi({ response: { title: "Набор спиц", details: "" } })),
  );
  assert.equal(r.title, "Набор спиц");
  assert.equal(r.details, amazonTitle);
});

test("without Workers AI the lookup behaves as before", async () => {
  const r = await lookupProduct("https://www.amazon.es/dp/B0C9TP6DD5", ctx);
  assert.equal(r.title, amazonTitle.slice(0, 120));
  assert.equal(r.details, "");
});
