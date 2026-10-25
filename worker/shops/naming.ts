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

// Words after which a shop title only describes the thing: "Шуба … из экомеха",
// "Набор мельниц для специй", "Пижама со штанами".
const PREPOSITION = /^(?:из|для|с|со|на|в|во|под|от|по|без|и|или|до|к)$/i;
/**
 * Rule-based fallback for long Russian shop titles: drops a leading brand (Latin
 * or capitals), cuts at the first describing part and keeps up to three words.
 * The full shop title goes to the hint. Null when there is nothing to shorten.
 */
export function shortTitle(title: string): WishName | null {
  const original = title.replace(/\s+/g, " ").trim();
  const words = original.split(" ");
  // Up to four words is short enough ("Гель для волос", "Набор спиц & аксессуары").
  if (words.length <= 4) return null;
  // Leading brand: Latin words or capitals in any script ("ТЕЛОДВИЖЕНИЯ Шуба …", "NEED MORЕ").
  while (
    words.length > 1 &&
    (/^[A-Za-z0-9&'.+-]+$/.test(words[0]) ||
      /^(?=.*[A-ZА-ЯЁ].*[A-ZА-ЯЁ])[^a-zа-яё]+$/.test(words[0]))
  )
    words.shift();
  // Russian words only, up to the first describing part or model name.
  const kept: string[] = [];
  for (let i = 0; i < words.length && kept.length < 3; i++) {
    const w = words[i];
    if (PREPOSITION.test(w)) {
      // "Подставка для ноутбука": one word alone says too little.
      if (kept.length === 1 && /^[А-ЯЁа-яё-]+$/.test(words[i + 1] || ""))
        kept.push(w.toLowerCase(), words[i + 1]);
      break;
    }
    const clean = w.replace(/[,;:)]+$/, "");
    if (!/^[А-ЯЁа-яё-]+$/.test(clean)) break;
    kept.push(clean);
    if (clean !== w) break;
  }
  const name = kept.join(" ");
  if (!name || name === original) return null;
  return {
    title: name[0].toUpperCase() + name.slice(1).toLowerCase(),
    details: original,
  };
}
