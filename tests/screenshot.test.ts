import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCREENSHOT_MODEL,
  parseScreenshot,
  readScreenshot,
  screenshotBytes,
} from "../worker/screenshot";
import type { AiBinding } from "../worker/shops/naming";

const ozonAnswer = {
  response: `Вот данные: {"shop":"Ozon","full_title":"Пехорка Пряжа для вязания Детская объёмная, микрофибра, черная","title":"пряжа для вязания","details":"Пехорка, микрофибра, черная","price":"1 299 ₽","photo_box":[0.05,0.1,0.95,0.55]}`,
};

test("a screenshot answer becomes title, hint, price and photo frame", () => {
  assert.deepEqual(parseScreenshot(ozonAnswer), {
    shop: "Ozon",
    title: "Пряжа для вязания",
    details: "Пехорка, микрофибра, черная",
    price: { min_minor: 129900, max_minor: null, currency: "RUB" },
    photo_box: [0.05, 0.1, 0.95, 0.55],
  });
});

test("odd model answers do not invent data", () => {
  assert.equal(parseScreenshot({ response: "Не могу прочитать" }), null);
  assert.equal(parseScreenshot({ response: '{"title":"","price":""}' }), null);
  const r = parseScreenshot({
    response: JSON.stringify({
      full_title: "KnitPro Nova Metal Deluxe Set",
      title: "Needle set",
      price: "цена по запросу",
      photo_box: [0.5, 0.5, 0.51, 0.51],
    }),
  });
  // No Russian short name: the page title stays; no number, no price; a dot is no photo.
  assert.equal(r?.title, "KnitPro Nova Metal Deluxe Set");
  assert.equal(r?.price, null);
  assert.equal(r?.photo_box, null);
  // A price without a currency is not trusted.
  assert.equal(
    parseScreenshot({ response: '{"title":"Тапочки","price":"1500"}' })?.price,
    null,
  );
  // Percent boxes are converted; the whole screen is not a product photo.
  assert.deepEqual(
    parseScreenshot({
      response: '{"title":"Тапочки","photo_box":[10,20,90,60]}',
    })?.photo_box,
    [0.1, 0.2, 0.9, 0.6],
  );
  assert.equal(
    parseScreenshot({ response: '{"title":"Тапочки","photo_box":[0,0,1,1]}' })
      ?.photo_box,
    null,
  );
});

test("only image data URLs from the form are accepted", () => {
  assert.deepEqual(
    screenshotBytes("data:image/jpeg;base64,AQID"),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(screenshotBytes("data:text/html;base64,AQID"), null);
  assert.equal(screenshotBytes("https://example.com/a.jpg"), null);
});

test("the vision model gets the image and the licence is accepted once", async () => {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  let agreed = false;
  const ai: AiBinding = {
    async run(model, input) {
      calls.push({ model, input });
      if (input.prompt === "agree") {
        agreed = true;
        return { response: "Thank you for agreeing" };
      }
      if (!agreed)
        throw new Error(
          "5016: Prior to using this model, you must submit the prompt 'agree'",
        );
      return ozonAnswer;
    },
  };
  const r = await readScreenshot(ai, new Uint8Array([1, 2, 3]));
  assert.equal(r?.title, "Пряжа для вязания");
  assert.deepEqual(
    calls.map((c) => c.input.prompt ?? "image"),
    ["image", "agree", "image"],
  );
  assert.equal(calls[0].model, SCREENSHOT_MODEL);
  assert.deepEqual(calls[2].input.image, [1, 2, 3]);
});

test("quota errors reach the caller; a slow model gives up", async () => {
  await assert.rejects(
    readScreenshot(
      {
        async run() {
          throw new Error("4006: you have used up your daily free allocation");
        },
      },
      new Uint8Array([1]),
    ),
    /allocation/,
  );
  const slow: AiBinding = { run: () => new Promise(() => undefined) };
  assert.equal(
    await readScreenshot(slow, new Uint8Array([1]), undefined, 20),
    null,
  );
});
