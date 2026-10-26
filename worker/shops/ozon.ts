import {
  absolute,
  clean,
  fromPage,
  ldProduct,
  merge,
  openGraph,
  priceFromText,
} from "./html";
import type { Page, ProductInfo, Shop, ShopContext } from "./types";
// Ozon embeds widget states as JSON strings. The same states are returned by the
// composer API, which is tried when the page itself is an anti-bot stub.
export function ozonWidgets(
  states: Record<string, unknown>,
  base: URL,
): ProductInfo {
  const out: ProductInfo = {};
  for (const [key, raw] of Object.entries(states)) {
    let s: Record<string, unknown>;
    try {
      s =
        typeof raw === "string"
          ? JSON.parse(raw)
          : (raw as Record<string, unknown>);
    } catch {
      continue;
    }
    if (!s || typeof s !== "object") continue;
    if (key.startsWith("webPrice") && !out.price) {
      // The card-only discount is not the price available to every family member.
      const text = String(s.price || s.originalPrice || "");
      out.price = text ? priceFromText(text, "RUB") : null;
    }
    if (key.startsWith("webProductHeading") && !out.title)
      out.title = clean(s.title);
    if (key.startsWith("webGallery") && !out.image) {
      const images = s.images as { src?: string }[] | undefined;
      out.image = absolute(
        String(s.coverImage || images?.[0]?.src || ""),
        base,
      );
    }
  }
  return out;
}
function statesFromHtml(html: string) {
  const states: Record<string, string> = {};
  for (const m of html.matchAll(
    /<div[^>]+id="state-(web(?:Price|ProductHeading|Gallery)[^"]*)"[^>]+data-state='([^']*)'/g,
  ))
    states[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return states;
}
// Ozon slugs are Russian names in Latin letters without ь/ъ:
// "zhurnalnyy-stolik-loft-…-1348747111" → "журналный столик лофт …".
const TRANSLIT: [string, string][] = [
  ["shch", "щ"],
  ["sch", "щ"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ts", "ц"],
  ["ch", "ч"],
  ["sh", "ш"],
  ["yu", "ю"],
  ["ya", "я"],
  ["yo", "ё"],
  ["iy", "ий"],
  ["yy", "ый"],
  ["ey", "ей"],
  ["oy", "ой"],
  ["ay", "ай"],
  ["uy", "уй"],
  ["a", "а"],
  ["b", "б"],
  ["v", "в"],
  ["g", "г"],
  ["d", "д"],
  ["e", "е"],
  ["z", "з"],
  ["i", "и"],
  ["k", "к"],
  ["l", "л"],
  ["m", "м"],
  ["n", "н"],
  ["o", "о"],
  ["p", "п"],
  ["r", "р"],
  ["s", "с"],
  ["t", "т"],
  ["u", "у"],
  ["f", "ф"],
  ["h", "х"],
  ["c", "ц"],
  ["y", "ы"],
  ["j", "дж"],
  ["w", "в"],
  ["x", "кс"],
  ["q", "к"],
];
function cyrillic(word: string) {
  // Numbers, sizes and model codes stay as they are.
  if (!/^[a-z]+$/.test(word)) return word;
  let out = "";
  for (let i = 0; i < word.length;) {
    // "e" at the start of a word is usually "э": "elektricheskiy", "ekomekh".
    if (i === 0 && word[0] === "e" && word.length > 2) {
      out += "э";
      i++;
      continue;
    }
    // "iy", "ey"… are "ий", "ей" only before a consonant or at the end:
    // "bizhuteriya" is "бижутерия", "sheyu" is "шею".
    const [lat, cyr] = TRANSLIT.find(
      ([l]) =>
        word.startsWith(l, i) &&
        !(l.length === 2 && l[1] === "y" && /[aeiouy]/.test(word[i + 2] || "")),
    )!;
    out += cyr;
    i += lat.length;
  }
  return out;
}
/** Name from /product/<slug>-<id>/; null for addresses without a slug. */
export function ozonSlugTitle(url: URL): string | null {
  const slug = url.pathname.match(/^\/product\/([a-z0-9-]+)-\d{5,}\/?$/i)?.[1];
  if (!slug) return null;
  const words = slug
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .map(cyrillic)
    // Sellers repeat words: "kole-kole".
    .filter((w, i, all) => w !== all[i - 1]);
  const title = words
    .join(" ")
    .replace(/(\d) h (\d)/g, "$1 х $2")
    // The most frequent lost soft signs: "журнальный", "спальное", "колье".
    .replace(/л(н(?:ый|ая|ое|ые|ого|ой))(?=\s|$)/g, "ль$1")
    .replace(/(^|\s)коле(?=\s|$)/g, "$1колье")
    .replace(/(^|\s)ожереле(?=\s|$)/g, "$1ожерелье")
    .trim();
  if (!/[а-яё]/.test(title)) return null;
  return (title[0].toUpperCase() + title.slice(1)).slice(0, 120);
}
export const ozon: Shop & {
  read(page: Page, url: URL, ctx: ShopContext): Promise<ProductInfo>;
} = {
  id: "ozon",
  name: "Ozon",
  matches: (u) => /(^|\.)ozon\.(ru|by|kz)$/.test(u.hostname),
  async parse(url, ctx) {
    // Short links: ozon.ru/t/… (without www) answers with a plain redirect to
    // the product address, while www.ozon.ru/t/… is an anti-bot page.
    let target = url;
    if (/^\/t\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
      target = new URL(`https://ozon.ru${url.pathname}`);
      const resolved = await ctx.resolve?.(target).catch(() => null);
      if (resolved?.pathname.startsWith("/product/")) target = resolved;
    }
    let page: Page;
    try {
      page = await ctx.page(target);
    } catch {
      // A transport failure must not skip the existing composer fallback.
      page = { url: target, status: 503, html: "" };
    }
    const info = await this.read(page, url, ctx);
    const address = page.url.pathname.startsWith("/product/")
      ? page.url
      : target;
    const canonical = address.pathname.startsWith("/product/")
      ? `https://www.ozon.ru${address.pathname}`
      : undefined;
    // Ozon closed the card: the address still names the product.
    const fromLink = info.title ? null : ozonSlugTitle(address);
    return {
      ...info,
      ...(fromLink ? { title: fromLink, titleFromLink: true } : {}),
      ...(canonical && canonical !== url.href.split("?")[0]
        ? { canonicalUrl: canonical }
        : {}),
    };
  },
  async read(page: Page, url: URL, ctx: ShopContext): Promise<ProductInfo> {
    const onPage = fromPage(
      page,
      ozonWidgets(statesFromHtml(page.html), page.url),
      ldProduct(page.html, page.url),
      openGraph(page.html, page.url),
    );
    if (onPage.price && onPage.title) return onPage;
    // Short links (ozon.ru/t/…) resolve to /product/…; the API needs that path.
    const path = page.url.pathname.startsWith("/product/")
      ? page.url.pathname
      : url.pathname;
    try {
      const api = (await ctx.json(
        new URL(
          `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
        ),
      )) as { widgetStates?: Record<string, unknown> };
      // The API answered, so the page-level block flag no longer applies.
      return merge(
        { ...onPage, blocked: false },
        ozonWidgets(api.widgetStates || {}, page.url),
      );
    } catch {
      return onPage;
    }
  },
};
