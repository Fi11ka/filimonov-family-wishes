import { currencyCode } from "../../shared/price";
import { fromPage, ldProduct, money, openGraph } from "./html";
import type { PriceInfo, Shop } from "./types";
/** Fallback for pages without JSON-LD: the first price object in embedded state. */
export function marketStatePrice(html: string): PriceInfo | null {
  const m = html.match(
    /"price"\s*:\s*\{\s*"value"\s*:\s*"?([\d.]+)"?\s*,\s*"currency"\s*:\s*"([A-Z]{3})"/,
  );
  const currency = currencyCode(m?.[2]);
  const amount = m && currency ? money(Number(m[1]), currency) : null;
  return currency && amount !== null
    ? { min: amount, max: null, currency }
    : null;
}
export const yandexMarket: Shop = {
  id: "yandex-market",
  name: "Яндекс Маркет",
  matches: (u) => /(^|\.)market\.yandex\.(ru|by|kz|uz)$/.test(u.hostname),
  async parse(url, ctx) {
    const page = await ctx.page(url);
    const product = ldProduct(page.html, page.url),
      price = marketStatePrice(page.html);
    // Bots often get the generic storefront ("Яндекс Маркет" + logo) instead of
    // the product; without product data the page tells us nothing.
    if (!product.title && !price) return { blocked: true };
    return fromPage(page, product, { price }, openGraph(page.html, page.url));
  },
};
