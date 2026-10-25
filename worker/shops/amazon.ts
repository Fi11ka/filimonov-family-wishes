import type { Currency } from "../../shared/price";
import {
  absolute,
  clean,
  decodeEntities,
  fromPage,
  ldProduct,
  openGraph,
  priceFromText,
} from "./html";
import type { ProductInfo, Shop } from "./types";
const DOMAIN_CURRENCY: [RegExp, Currency][] = [
  [/\.com$/, "USD"],
  [/\.co\.uk$/, "GBP"],
  [/\.(de|fr|it|es|nl|ie|be)$/, "EUR"],
  [/\.com\.tr$/, "TRY"],
];
export function amazonPage(html: string, base: URL): ProductInfo {
  const fallback =
    DOMAIN_CURRENCY.find(([re]) => re.test(base.hostname))?.[1] || "USD";
  // The buy-box price lives in corePrice*; other a-offscreen spans are accessories.
  const core =
    html.match(
      /id="(?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|corePrice_desktop|apex_desktop)"[\s\S]{0,6000}?class="a-offscreen">([^<]{1,40})</,
    )?.[1] ||
    html.match(
      /id="priceblock_(?:ourprice|dealprice)"[^>]*>([^<]{1,40})</,
    )?.[1];
  const image =
    html.match(/data-old-hires="([^"]+)"/)?.[1] ||
    html.match(/"hiRes":"(https:[^"]+)"/)?.[1] ||
    decodeEntities(
      html.match(/id="landingImage"[^>]*data-a-dynamic-image="([^"]+)"/)?.[1] ||
        "",
    ).match(/"(https:[^"]+)"/)?.[1];
  return {
    title: clean(html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/)?.[1]),
    image: absolute(image, base),
    price: core ? priceFromText(decodeEntities(core), fallback) : null,
  };
}
export const amazon: Shop = {
  id: "amazon",
  name: "Amazon",
  matches: (u) =>
    /(^|\.)amazon\.(com|co\.uk|de|fr|it|es|nl|ie|be|com\.tr|ca|com\.au|co\.jp|in|ae|sa|pl|se|sg|com\.mx|com\.br)$/.test(
      u.hostname,
    ) || /(^|\.)amzn\.(to|eu|asia)$/.test(u.hostname),
  async parse(url, ctx) {
    const page = await ctx.page(url);
    return fromPage(
      page,
      amazonPage(page.html, page.url),
      ldProduct(page.html, page.url),
      openGraph(page.html, page.url),
    );
  },
};
