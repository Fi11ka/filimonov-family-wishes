import {
  currencyCode,
  detectCurrency,
  parseAmount,
  type Currency,
} from "../../shared/price";
import type { Page, PriceInfo, ProductInfo } from "./types";
// Small, dependency-free HTML helpers. Pages are untrusted: everything here only
// extracts strings; nothing is executed or rendered on the server.
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
export function decodeEntities(s: string) {
  return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : m;
    }
    return entities[e.toLowerCase()] ?? m;
  });
}
export function clean(s: unknown, max = 120) {
  return decodeEntities(String(s ?? ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function attr(tag: string, name: string) {
  return tag
    .match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))
    ?.slice(1)
    .find((v) => v !== undefined);
}
/** <meta property|name|itemprop="key" content="…"> */
export function meta(html: string, ...keys: string[]) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (
      attr(tag, "property") ||
      attr(tag, "name") ||
      attr(tag, "itemprop") ||
      ""
    ).toLowerCase();
    if (keys.includes(key)) {
      const v = attr(tag, "content");
      if (v) return decodeEntities(v).trim();
    }
  }
  return "";
}
export function titleTag(html: string) {
  return clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
}
export function absolute(value: string | undefined, base: URL) {
  if (!value) return "";
  try {
    const u = new URL(decodeEntities(value.trim()), base);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}
/** All JSON-LD objects, flattened through @graph and arrays. */
export function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      out.push(v as Record<string, unknown>);
      const graph = (v as Record<string, unknown>)["@graph"];
      if (graph) visit(graph);
    }
  };
  for (const m of html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ))
    try {
      visit(JSON.parse(m[1].trim()));
    } catch {
      // Broken JSON-LD is common; skip it.
    }
  return out;
}
const isType = (o: Record<string, unknown>, t: string) =>
  ([] as unknown[])
    .concat(o["@type"])
    .some((v) => String(v).toLowerCase() === t);
export function money(value: unknown, currency: Currency | null) {
  if (value === null || value === undefined || value === "") return null;
  const n =
    typeof value === "number"
      ? Math.round(value * 100)
      : parseAmount(String(value));
  return currency && n !== null && n >= 0 ? n : null;
}
function firstImage(v: unknown, base: URL): string {
  if (typeof v === "string") return absolute(v, base);
  if (Array.isArray(v)) return firstImage(v[0], base);
  if (v && typeof v === "object")
    return firstImage(
      (v as Record<string, unknown>).url ||
        (v as Record<string, unknown>).contentUrl,
      base,
    );
  return "";
}
/** schema.org Product with Offer / AggregateOffer. */
export function ldProduct(html: string, base: URL): ProductInfo {
  const product = jsonLd(html).find((o) => isType(o, "product"));
  if (!product) return {};
  const offers = ([] as unknown[])
    .concat(product.offers ?? [])
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
  let price: PriceInfo | null = null;
  for (const o of offers) {
    const spec = (o.priceSpecification ?? {}) as Record<string, unknown>;
    const currency = currencyCode(o.priceCurrency ?? spec.priceCurrency);
    if (!currency) continue;
    const low = money(o.lowPrice ?? o.price ?? spec.price, currency),
      high = money(o.highPrice, currency);
    if (low === null && high === null) continue;
    price = {
      min: low,
      max: high !== null && high !== low ? high : null,
      currency,
    };
    break;
  }
  return {
    title: clean(product.name),
    image: firstImage(product.image, base),
    price,
  };
}
/** Open Graph / Twitter / microdata fallbacks that most shops expose. */
export function openGraph(html: string, base: URL): ProductInfo {
  const currency =
    currencyCode(
      meta(
        html,
        "product:price:currency",
        "og:price:currency",
        "pricecurrency",
      ),
    ) || null;
  const amount = money(
    meta(html, "product:price:amount", "og:price:amount", "price"),
    currency,
  );
  return {
    title: clean(meta(html, "og:title", "twitter:title") || titleTag(html)),
    image: absolute(
      meta(html, "og:image:secure_url", "og:image", "twitter:image", "image") ||
        attr(
          html.match(/<link[^>]+rel=["']image_src["'][^>]*>/i)?.[0] || "",
          "href",
        ),
      base,
    ),
    price:
      currency && amount !== null ? { min: amount, max: null, currency } : null,
  };
}
export function priceFromText(
  text: string,
  fallback: Currency,
): PriceInfo | null {
  const currency = detectCurrency(text) || fallback;
  const n = parseAmount(
    text
      .replace(/[^\d\s  .,]/g, " ")
      .trim()
      .split(/\s{2,}/)[0] || "",
  );
  return n === null ? null : { min: n, max: null, currency };
}
const BOT_MARKERS =
  /showcaptcha|captcha-?page|smartcaptcha|_____tmd_____\/punish|x5secdata|Robot Check|antibot|challenge-platform|cf-chl|Attention Required|Just a moment\.\.\.|Доступ ограничен|Подтвердите, что запросы отправляли вы/i;
export function looksBlocked(p: Page) {
  return (
    [401, 403, 429, 498, 503].includes(p.status) ||
    (p.html.length < 20000 && BOT_MARKERS.test(p.html))
  );
}
/**
 * Data from an anti-bot page is not product data ("Attention Required!" is not
 * a gift title), so a blocked page contributes nothing but the flag.
 */
export function fromPage(page: Page, ...parts: ProductInfo[]): ProductInfo {
  return looksBlocked(page) ? { blocked: true } : merge(...parts);
}
/** Combines results, earlier sources win field by field. */
export function merge(...parts: ProductInfo[]): ProductInfo {
  const out: ProductInfo = {};
  for (const p of parts) {
    if (!out.title && p.title) out.title = p.title;
    if (!out.image && p.image) out.image = p.image;
    if (!out.price && p.price) out.price = p.price;
    if (p.blocked) out.blocked = true;
    if (p.unavailable) out.unavailable = true;
  }
  return out;
}
