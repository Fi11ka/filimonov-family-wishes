// Shop titles are long and often foreign ("KnitPro Nova Metal Deluxe … 8mm").
// A wish needs a short Russian name ("Набор спиц"); brand, model, colour and
// sizes belong in the hint for relatives. Cloudflare Workers AI does the
// rewrite; without it (or on any failure) shortTitle() trims Russian titles by rules.

export interface WishName {
  title: string;
  details: string;
}
/** Minimal shape of the Workers AI binding used here. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
export type Namer = (
  title: string,
  shop: string | null,
) => Promise<WishName | null>;

export const NAMING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TIMEOUT_MS = 9000;

const SYSTEM = `Ты помогаешь вести семейный вишлист подарков.
По названию товара из интернет-магазина верни JSON с двумя полями.
"title" — короткое понятное название вещи на русском языке: 1–4 слова, с заглавной буквы, без бренда, модели, артикула, цвета, размеров и количества. Примеры: «Пряжа для вязания», «Набор спиц», «Журнальный столик», «Тапочки».
"details" — всё полезное, что не вошло в название: бренд и модель (в оригинальном написании), цвет, размер, материал, комплектация. Одной строкой через запятую, на русском, до 200 символов. Если добавить нечего — пустая строка.
Пиши только то, что есть в исходном названии, ничего не придумывай.`;

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    details: { type: "string" },
  },
  required: ["title", "details"],
};

const oneLine = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["«»'.,;:\s-]+|["«»'.,;:\s-]+$/g, "")
    .slice(0, max);

/** Already a short Russian name — nothing to gain from a model call. */
export function isShortRussian(title: string) {
  const words = title.trim().split(/\s+/);
  return words.length <= 4 && /^[А-ЯЁа-яё0-9\s-]+$/.test(title.trim());
}

/** Validates a model answer; anything odd means "keep the shop title". */
export function parseWishName(raw: unknown): WishName | null {
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
  const title = oneLine((data as WishName).title, 60),
    details = oneLine((data as WishName).details, 300);
  if (title.length < 2 || !/[А-ЯЁа-яё]/.test(title)) return null;
  return { title: title[0].toUpperCase() + title.slice(1), details };
}

export function aiNamer(
  ai: AiBinding,
  model = NAMING_MODEL,
  timeoutMs = TIMEOUT_MS,
): Namer {
  return async (title, shop) => {
    if (!title || isShortRussian(title)) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        ai.run(model, {
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: `${shop ? `Магазин: ${shop}\n` : ""}Название товара: ${title}`,
            },
          ],
          response_format: { type: "json_schema", json_schema: SCHEMA },
          max_tokens: 200,
          temperature: 0.2,
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      return answer === null ? null : parseWishName(answer);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export { shortTitle } from "../../shared/short-title";
