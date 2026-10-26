// «Добавить скриншот»: Ozon, Яндекс Маркет and others do not let servers read
// product pages, but the user has the page open. A screenshot of it goes to a
// Workers AI vision model, which reads the name, price and where the product
// photo is. Everything it answers is validated; anything odd is left empty.

import { currencyCode, detectCurrency, parsePriceText } from "../shared/price";
import { shortTitle } from "../shared/short-title";
import type { AiBinding } from "./shops/naming";

/** The cheapest vision model in Workers AI (about 40 neurons per screenshot). */
export const SCREENSHOT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const TIMEOUT_MS = 30000;

export interface ScreenshotResult {
  shop: string | null;
  title: string;
  details: string;
  price: {
    min_minor: number | null;
    max_minor: number | null;
    currency: string;
  } | null;
  /** Product photo on the screenshot, shares of width/height: [left, top, right, bottom]. */
  photo_box: [number, number, number, number] | null;
}

const PROMPT = `На изображении — скриншот страницы товара из интернет-магазина.
Верни только JSON без пояснений:
{"shop": "название магазина или пустая строка",
 "full_title": "полное название товара, как написано на странице",
 "title": "короткое название вещи на русском, 1–4 слова, без бренда, модели, цвета и размеров",
 "details": "бренд, модель, цвет, размер, материал из названия, одной строкой через запятую",
 "price": "текущая цена товара вместе с валютой, как на странице (не зачёркнутая старая цена и не цена по карте магазина); пустая строка, если цены не видно",
 "photo_box": [left, top, right, bottom]}
photo_box — рамка основной фотографии товара в долях ширины и высоты скриншота (числа от 0 до 1); null, если фотографии нет.
Пиши только то, что видно на скриншоте, ничего не придумывай.`;

const oneLine = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["«»'.,;:\s-]+|["«»'.,;:\s-]+$/g, "")
    .slice(0, max);

/** The box must be a real part of the screenshot, not a dot or the whole screen. */
function photoBox(raw: unknown): ScreenshotResult["photo_box"] {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  let [l, t, r, b] = raw.map(Number);
  if (![l, t, r, b].every((v) => Number.isFinite(v))) return null;
  // Some answers come in percent.
  if (Math.max(l, t, r, b) > 1 && Math.max(l, t, r, b) <= 100)
    [l, t, r, b] = [l, t, r, b].map((v) => v / 100);
  if (Math.min(l, t, r, b) < 0 || Math.max(l, t, r, b) > 1) return null;
  const w = r - l,
    h = b - t;
  if (w < 0.15 || h < 0.08 || w * h > 0.9) return null;
  return [l, t, r, b].map((v) => Math.round(v * 1000) / 1000) as [
    number,
    number,
    number,
    number,
  ];
}

/** Validates a model answer. Null when nothing useful was read. */
export function parseScreenshot(raw: unknown): ScreenshotResult | null {
  let data: unknown = raw;
  if (data && typeof data === "object" && "response" in data)
    data = (data as { response: unknown }).response;
  if (typeof data === "string") {
    const json = data.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    try {
      data = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const full = oneLine(d.full_title, 300);
  let title = oneLine(d.title, 60),
    details = oneLine(d.details, 300);
  // A short name must be Russian; otherwise shorten the page title by rules.
  if (title.length < 2 || !/[А-ЯЁа-яё]/.test(title)) {
    const short = full ? shortTitle(full) : null;
    title = (short?.title || full).slice(0, 120);
    details = short?.details || details;
  } else if (!details && full && full !== title) details = full;
  if (title) title = title[0].toUpperCase() + title.slice(1);

  const priceText = oneLine(d.price, 80);
  const parsed = priceText ? parsePriceText(priceText) : null;
  const currency =
    parsed?.currency || currencyCode(d.currency) || detectCurrency(priceText);
  const price =
    parsed && currency && (parsed.min !== null || parsed.max !== null)
      ? {
          min_minor: parsed.min,
          max_minor: parsed.range ? parsed.max : null,
          currency,
        }
      : null;
  const result: ScreenshotResult = {
    shop: oneLine(d.shop, 40) || null,
    title,
    details: details === title ? "" : details,
    price,
    photo_box: photoBox(d.photo_box),
  };
  return result.title || result.price ? result : null;
}

/** "data:image/jpeg;base64,…" → bytes, only for images the form produces. */
export function screenshotBytes(dataUrl: string): Uint8Array | null {
  const m = dataUrl.match(
    /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/,
  );
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Errors that another request format cannot fix. */
export const isQuotaError = (e: unknown) =>
  /allocation|quota|neurons|4006|3036/i.test(
    String((e as Error)?.message ?? e),
  );

/**
 * Reads a screenshot with the vision model. The image goes inside `messages`
 * (the current format); if the model refuses it, the older documented
 * `prompt` + `image` bytes format is tried. Meta's licence has to be accepted
 * once per Cloudflare account by sending "agree"; done here on the first refusal.
 */
export async function readScreenshot(
  ai: AiBinding,
  dataUrl: string,
  model = SCREENSHOT_MODEL,
  timeoutMs = TIMEOUT_MS,
): Promise<ScreenshotResult | null> {
  const bytes = screenshotBytes(dataUrl);
  if (!bytes) return null;
  const options = { max_tokens: 400, temperature: 0.1 };
  const formats = [
    () =>
      ai.run(model, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        ...options,
      }),
    () => ai.run(model, { prompt: PROMPT, image: [...bytes], ...options }),
  ];
  const withLicence = async (ask: () => Promise<unknown>) => {
    try {
      return await ask();
    } catch (e) {
      if (!/agree/i.test(String((e as Error)?.message ?? e))) throw e;
      await ai.run(model, { prompt: "agree" });
      return ask();
    }
  };
  const run = async () => {
    let last: unknown;
    for (const ask of formats) {
      try {
        return await withLicence(ask);
      } catch (e) {
        if (isQuotaError(e)) throw e;
        console.error("screenshot: model refused the request", e);
        last = e;
      }
    }
    throw last;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return answer === null ? null : parseScreenshot(answer);
  } finally {
    clearTimeout(timer);
  }
}
