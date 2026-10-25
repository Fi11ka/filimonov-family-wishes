import { decodeHtml, fetchBytes, publicHttpsUrl } from "../net";
import { aliexpressCom } from "./aliexpress-com";
import { aliexpressRu } from "./aliexpress-ru";
import { amazon } from "./amazon";
import { generic } from "./generic";
import { merge } from "./html";
import { ozon } from "./ozon";
import type { ProductInfo, Shop, ShopContext } from "./types";
import { wildberries } from "./wildberries";
import { yandexMarket } from "./yandex-market";
import { productLink } from "./link";
/** Order matters only for overlapping hosts; the generic parser is always last. */
export const shops: Shop[] = [
  wildberries,
  ozon,
  yandexMarket,
  amazon,
  aliexpressRu,
  aliexpressCom,
];
export function findShop(url: URL) {
  return shops.find((s) => s.matches(url)) || generic;
}
const TOTAL_MS = 12000;
/** Real network access with the SSRF and size limits from net.ts. */
export function liveContext(): ShopContext {
  return {
    async page(
      url,
      accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    ) {
      const f = await fetchBytes(url, {
        timeoutMs: 8000,
        maxBytes: 2_000_000,
        truncate: true,
        accept,
      });
      return { url: f.url, status: f.status, html: decodeHtml(f) };
    },
    async json(url, headers) {
      const f = await fetchBytes(url, {
        timeoutMs: 6000,
        maxBytes: 1_000_000,
        accept: "application/json",
        headers,
      });
      if (f.status !== 200) throw new Error(`HTTP ${f.status}`);
      return JSON.parse(new TextDecoder().decode(f.bytes));
    },
  };
}
export interface LookupResult {
  shop: string | null;
  url: string;
  title: string;
  image_url: string;
  price: {
    min_minor: number | null;
    max_minor: number | null;
    currency: string;
  } | null;
  blocked: boolean;
  unavailable: boolean;
}
export async function lookupProduct(
  raw: unknown,
  ctx: ShopContext = liveContext(),
): Promise<LookupResult> {
  const url = productLink(publicHttpsUrl(raw));
  const shop = findShop(url);
  const attempt = async (s: Shop) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<ProductInfo>([
        s.parse(url, ctx).catch(() => ({ blocked: true })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ blocked: true }), TOTAL_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let info = await attempt(shop);
  // A shop module may only know prices; fill title/photo from the page itself.
  if (shop !== generic && (!info.title || !info.image) && !info.blocked)
    info = merge(info, await attempt(generic));
  const price =
    info.price && (info.price.min !== null || info.price.max !== null)
      ? {
          min_minor: info.price.min,
          max_minor: info.price.max,
          currency: info.price.currency,
        }
      : null;
  return {
    shop:
      info.source === "aliexpress-global"
        ? "AliExpress (международный сайт)"
        : shop === generic
          ? null
          : shop.name,
    url: url.href,
    title: info.title || "",
    image_url: info.image || "",
    price,
    unavailable: !!info.unavailable,
    blocked: !!info.blocked && !price && !info.image,
  };
}
