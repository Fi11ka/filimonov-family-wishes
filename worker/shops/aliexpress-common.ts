import { currencyCode, type Currency } from "../../shared/price";
import {
  absolute,
  fromPage,
  ldProduct,
  money,
  openGraph,
  priceFromText,
} from "./html";
import type { PriceInfo, ProductInfo, ShopContext } from "./types";
// AliExpress (.com and .ru) embeds product data as JSON inside scripts. Field
// names differ between versions, so the parser looks for amount objects by name.
const AMOUNT_KEYS =
  "minActivityAmount|skuActivityAmount|minAmount|skuAmount|maxActivityAmount|maxAmount|activityAmount|salePrice";
export function aliPrice(html: string, fallback: Currency): PriceInfo | null {
  const found: { value: number; currency: Currency }[] = [];
  const re = new RegExp(
    `"(?:${AMOUNT_KEYS})"\\s*:\\s*\\{([^{}]{0,400})\\}`,
    "g",
  );
  for (const m of html.matchAll(re)) {
    const currency = currencyCode(
      m[1].match(/"currency(?:Code)?"\s*:\s*"([A-Z]{3})"/)?.[1],
    );
    const value = m[1].match(/"value"\s*:\s*"?([\d.]+)"?/)?.[1];
    const amount = currency && value ? money(Number(value), currency) : null;
    if (currency && amount !== null && amount > 0)
      found.push({ value: amount, currency });
  }
  if (found.length) {
    const currency = found[0].currency;
    const values = found
      .filter((f) => f.currency === currency)
      .map((f) => f.value);
    const min = Math.min(...values),
      max = Math.max(...values);
    return { min, max: max !== min ? max : null, currency };
  }
  // aliexpress.ru: {"price":{"value":1234,"currency":"RUB"}} or formatted strings.
  const ru = html.match(
    /"price"\s*:\s*\{\s*"value"\s*:\s*"?([\d.]+)"?\s*,\s*"currency"\s*:\s*"([A-Z]{3})"/,
  );
  const ruCurrency = currencyCode(ru?.[2]);
  const ruAmount = ru && ruCurrency ? money(Number(ru[1]), ruCurrency) : null;
  if (ruCurrency && ruAmount !== null)
    return { min: ruAmount, max: null, currency: ruCurrency };
  const formatted =
    html.match(/"formatedActivityPrice"\s*:\s*"([^"]{1,40})"/)?.[1] ||
    html.match(/"formatedPrice"\s*:\s*"([^"]{1,40})"/)?.[1];
  return formatted ? priceFromText(formatted, fallback) : null;
}
export function aliImage(html: string, base: URL) {
  const raw =
    html.match(/"imagePathList"\s*:\s*\[\s*"([^"]+)"/)?.[1] ||
    html.match(
      /"(?:mainImage|imageUrl|image)"\s*:\s*"(https?:\/\/[^"]+alicdn[^"]+)"/,
    )?.[1];
  return absolute(raw?.replace(/\\u002F/g, "/"), base);
}
export async function parseAliExpress(
  url: URL,
  ctx: ShopContext,
  fallback: Currency,
): Promise<ProductInfo> {
  const page = await ctx.page(url);
  return fromPage(
    page,
    ldProduct(page.html, page.url),
    {
      price: aliPrice(page.html, fallback),
      image: aliImage(page.html, page.url),
    },
    openGraph(page.html, page.url),
  );
}
