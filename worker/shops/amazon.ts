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
function buyBoxPrice(html: string) {
  for (const root of html.matchAll(
    /<div\b[^>]*\bid=["'](?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|corePrice_desktop)["'][^>]*>/gi,
  )) {
    const start = root.index! + root[0].length;
    const tail = html.slice(start, start + 30000);
    let depth = 1,
      end = tail.length;
    for (const tag of tail.matchAll(/<\/?div\b[^>]*>/gi)) {
      depth += /^<\//.test(tag[0]) ? -1 : 1;
      if (depth === 0) {
        end = tag.index!;
        break;
      }
    }
    // Old/list prices use a-text-price; their first a-offscreen is not the amount to pay.
    const block = tail
      .slice(0, end)
      .replace(
        /<span\b[^>]*class=["'][^"']*\ba-text-price\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
        "",
      );
    const value = block.match(
      /<span\b[^>]*class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([^<]{1,80})</i,
    )?.[1];
    if (value) return value;
  }
  return html.match(
    /id=["']priceblock_(?:ourprice|dealprice)["'][^>]*>([^<]{1,80})</i,
  )?.[1];
}
export function amazonPage(html: string, base: URL): ProductInfo {
  const fallback =
    DOMAIN_CURRENCY.find(([re]) => re.test(base.hostname))?.[1] || "USD";
  // The buy-box price lives in corePrice*; other a-offscreen spans are accessories.
  const core = buyBoxPrice(html);
  const mainImage =
    [...html.matchAll(/<img\b[^>]{0,6000}>/gi)].find((m) =>
      /\bid=["'](?:landingImage|imgBlkFront)["']/i.test(m[0]),
    )?.[0] || "";
  const image =
    mainImage.match(/data-old-hires=["']([^"']+)["']/i)?.[1] ||
    decodeEntities(
      mainImage.match(/data-a-dynamic-image=["']([^"']+)["']/i)?.[1] || "",
    ).match(/"(https:[^"]+)"/)?.[1] ||
    mainImage.match(/\ssrc=["']([^"']+)["']/i)?.[1];
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
