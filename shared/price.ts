// Shared by the Worker (shop parsers) and the browser (gift form, import).
// Amounts are minor units (kopecks/cents) as integers, like gifts.price_minor.
export const currencies = [
  "EUR",
  "USD",
  "RUB",
  "GBP",
  "GEL",
  "TRY",
  "KZT",
  "UAH",
  "BYN",
] as const;
export type Currency = (typeof currencies)[number];
export const isCurrency = (value: unknown): value is Currency =>
  typeof value === "string" &&
  (currencies as readonly string[]).includes(value);
export const MAX_MINOR = 100000000000;
export interface ParsedPrice {
  min: number | null;
  max: number | null;
  range: boolean;
  /** True when the whole text was understood; otherwise `note` keeps the original. */
  exact: boolean;
  currency: Currency | null;
  note: string;
}
const symbols: [RegExp, Currency][] = [
  // \b is ASCII-only in JS regexes, so Cyrillic words use a lookbehind instead.
  [/₽|руб|(?<![а-яё])р\.|\brub\b|\brur\b/i, "RUB"],
  [/€|\beur\b|евро/i, "EUR"],
  [/\$|\busd\b|доллар/i, "USD"],
  [/£|\bgbp\b/i, "GBP"],
  [/₾|\bgel\b|лари/i, "GEL"],
  [/₺|\btry\b|лир/i, "TRY"],
  [/₸|\bkzt\b|тенге/i, "KZT"],
  [/₴|\buah\b|грн/i, "UAH"],
  [/\bbyn\b|бел\.?\s*руб/i, "BYN"],
];
export function currencyCode(value: unknown): Currency | null {
  const v = String(value ?? "")
    .trim()
    .toUpperCase();
  if (v === "RUR") return "RUB";
  return isCurrency(v) ? v : null;
}
export function detectCurrency(text: string): Currency | null {
  // BYN must win over the generic "руб" rule.
  if (/\bbyn\b|бел\.?\s*руб/i.test(text)) return "BYN";
  for (const [re, c] of symbols) if (re.test(text)) return c;
  return null;
}
const NUM = String.raw`\d[\d   ']*(?:[.,]\d+)?`;
/** "6 000" → 600000, "3000.0" → 300000, "1 299,50" → 129950, "1,299" → 129900. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[\s  ']/g, "");
  if (!/^\d+(?:[.,]\d+)*$/.test(s)) return null;
  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  if (lastSep >= 0) {
    const tail = s.slice(lastSep + 1);
    const seps = s.match(/[.,]/g)!.length;
    // A single separator followed by exactly three digits is a thousands separator.
    if (tail.length === 3 && seps === 1) s = s.replace(/[.,]/g, "");
    else
      s = s.slice(0, lastSep).replace(/[.,]/g, "") + "." + s.slice(lastSep + 1);
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  const minor = Math.round(n * 100);
  return minor <= MAX_MINOR ? minor : null;
}
function numbers(text: string) {
  return [...text.matchAll(new RegExp(NUM, "g"))]
    .map((m) => parseAmount(m[0]))
    .filter((n): n is number => n !== null);
}
/**
 * Understands what people type in a price cell: "3000.0", "6 000-40 000",
 * "от 1000", "до 500", "2500+800 печать", "800/шт (4 800)", "Комплектом 45 000".
 */
export function parsePriceText(input: unknown): ParsedPrice {
  const original = String(input ?? "").trim();
  const empty = {
    min: null,
    max: null,
    range: false,
    currency: null,
    note: "",
  };
  if (!original || /^#(N\/A|REF!|VALUE!|ERROR!|NAME\?|DIV\/0!)/i.test(original))
    return { ...empty, exact: true };
  const currency = detectCurrency(original);
  const t = original
    .toLowerCase()
    .replace(
      /бел\.?\s*руб[а-яё]*\.?|₽|руб[а-яё]*\.?|(?<![а-яё])р\.|rub|rur|€|eur|\$|usd|£|gbp|₾|₺|₸|₴|грн|byn/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const n = `(${NUM})`;
  let m: RegExpMatchArray | null;
  const ok = (min: number | null, max: number | null, range: boolean) => ({
    min,
    max,
    range,
    exact: true,
    currency,
    note: "",
  });
  if ((m = t.match(new RegExp(`^${n}$`)))) {
    const v = parseAmount(m[1]);
    if (v !== null) return ok(v, null, false);
  }
  if (
    (m = t.match(
      new RegExp(`^(?:от\\s*)?${n}\\s*(?:-|–|—|до)\\s*(?:до\\s*)?${n}$`),
    ))
  ) {
    const a = parseAmount(m[1]),
      b = parseAmount(m[2]);
    if (a !== null && b !== null)
      return a === b
        ? ok(a, null, false)
        : ok(Math.min(a, b), Math.max(a, b), true);
  }
  if ((m = t.match(new RegExp(`^от\\s*${n}$`)))) {
    const v = parseAmount(m[1]);
    if (v !== null) return ok(v, null, true);
  }
  if ((m = t.match(new RegExp(`^до\\s*${n}$`)))) {
    const v = parseAmount(m[1]);
    if (v !== null) return ok(null, v, true);
  }
  // Best guess for free text; the original goes to the note so nothing is lost.
  const guess = (min: number | null, max: number | null = null) => ({
    min,
    max,
    range: max !== null,
    exact: false,
    currency,
    note: original,
  });
  const inParens = t.match(new RegExp(`\\((?:[^)\\d]*)${n}[^)]*\\)`));
  if (inParens) return guess(parseAmount(inParens[1]));
  if (/\+/.test(t)) {
    const parts = numbers(t);
    if (parts.length > 1)
      return guess(
        Math.min(
          MAX_MINOR,
          parts.reduce((s, v) => s + v, 0),
        ),
      );
  }
  const all = numbers(t);
  if (all.length === 1) return guess(all[0]);
  if (all.length > 1) return guess(Math.min(...all), Math.max(...all));
  return guess(null);
}
/** Formats minor units for display: 2599 → "25,99", 600000 → "6 000". */
export function formatAmount(minor: number, currency: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);
}
export function formatPrice(p: {
  price_minor: number | null;
  price_max_minor?: number | null;
  price_range?: number | boolean;
  currency: string;
}) {
  const min = p.price_minor,
    max = p.price_max_minor ?? null;
  if (min !== null && max !== null)
    return `${formatAmount(min, p.currency)} – ${formatAmount(max, p.currency)}`;
  if (p.price_range && min !== null)
    return `от ${formatAmount(min, p.currency)}`;
  if (max !== null) return `до ${formatAmount(max, p.currency)}`;
  if (min !== null) return formatAmount(min, p.currency);
  return "Цена не указана";
}
/** One person's part of a shared gift: every amount divided by the number of people. */
export function sharePrice(
  p: {
    price_minor: number | null;
    price_max_minor?: number | null;
    price_range?: number | boolean;
    currency: string;
  },
  people: number,
) {
  const part = (v: number | null | undefined) =>
    v === null || v === undefined ? null : Math.round(v / Math.max(1, people));
  return formatPrice({
    ...p,
    price_minor: part(p.price_minor),
    price_max_minor: part(p.price_max_minor),
  });
}
