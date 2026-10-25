import {
  absolute,
  clean,
  fromPage,
  ldProduct,
  merge,
  openGraph,
  priceFromText,
} from "./html";
import type { ProductInfo, Shop } from "./types";
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
      const text = String(s.cardPrice || s.price || s.originalPrice || "");
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
export const ozon: Shop = {
  id: "ozon",
  name: "Ozon",
  matches: (u) => /(^|\.)ozon\.(ru|by|kz)$/.test(u.hostname),
  async parse(url, ctx) {
    const page = await ctx.page(url);
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
