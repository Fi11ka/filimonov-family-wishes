import {
  decodeHtml,
  fetchBytes,
  publicHttpsUrl,
  resolveRedirects,
} from "../net";
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
import { dns } from "./dns";
import type { HomeHelper } from "../helper";
import { shortTitle, type Namer } from "./naming";
import { slugTitle } from "./slug";
/** Order matters only for overlapping hosts; the generic parser is always last. */
export const shops: Shop[] = [
  wildberries,
  ozon,
  yandexMarket,
  amazon,
  aliexpressRu,
  aliexpressCom,
  dns,
];
export function findShop(url: URL) {
  return shops.find((s) => s.matches(url)) || generic;
}
const TOTAL_MS = 12000;
/** Pages through the home helper: its wait plus one direct attempt. */
const HELPER_TOTAL_MS = 32000;
/**
 * Real network access with the SSRF and size limits from net.ts. Shops that
 * block servers are first asked through the home helper when it is configured.
 */
export function liveContext(helper?: HomeHelper | null): ShopContext {
  return {
    budgetMs: helper ? HELPER_TOTAL_MS : TOTAL_MS,
    helperStatus: helper ? () => helper.status() : undefined,
    async page(
      url,
      accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    ) {
      if (helper?.handlesPage(url)) {
        const p = await helper.page(url);
        if (p) return p;
      }
      const f = await fetchBytes(url, {
        timeoutMs: 8000,
        maxBytes: 2_000_000,
        truncate: true,
        accept,
      });
      return { url: f.url, status: f.status, html: decodeHtml(f) };
    },
    async resolve(url) {
      // A plain User-Agent: Ozon answers a full Chrome one without a real
      // browser behind it with an anti-bot page instead of the redirect.
      return resolveRedirects(url, (u) => u.pathname.startsWith("/product/"), {
        "User-Agent": "Mozilla/5.0",
      });
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
  /** Brand, model, colour, sizes moved out of a shortened title; for the hint. */
  details: string;
  image_url: string;
  price: {
    min_minor: number | null;
    max_minor: number | null;
    currency: string;
  } | null;
  blocked: boolean;
  unavailable: boolean;
  /** The shop needs the home helper, and it is not running right now. */
  helper_offline: boolean;
}
export async function lookupProduct(
  raw: unknown,
  ctx: ShopContext = liveContext(),
  namer?: Namer,
): Promise<LookupResult> {
  const url = productLink(publicHttpsUrl(raw));
  const shop = findShop(url);
  const attempt = async (s: Shop) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<ProductInfo>([
        s.parse(url, ctx).catch(() => ({ blocked: true })),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ blocked: true }),
            ctx.budgetMs ?? TOTAL_MS,
          );
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
  const shopName =
    info.source === "aliexpress-global"
      ? "AliExpress (международный сайт)"
      : shop === generic
        ? null
        : shop.name;
  // The shop did not give a name: most shops write it into the address.
  if (!info.title) {
    const fromLink = slugTitle(new URL(info.canonicalUrl || url.href));
    if (fromLink) info = { ...info, title: fromLink, titleFromLink: true };
  }
  let title = info.title || "",
    details = "";
  // Workers AI first; if it is unavailable or slow, shorten by rules.
  const named =
    (title && namer
      ? await namer(
          title,
          info.titleFromLink
            ? `${shopName || url.hostname}. Название восстановлено из адреса ссылки транслитом, без мягких знаков — исправь орфографию`
            : shopName,
        )
      : null) || (title ? shortTitle(title) : null);
  if (named && named.title !== title) {
    // Nothing from the shop title is lost: it goes to the hint if the model
    // did not list the details itself.
    details = named.details || title;
    title = named.title;
  }
  return {
    shop: shopName,
    url: info.canonicalUrl || url.href,
    title,
    details,
    image_url: info.image || "",
    price,
    unavailable: !!info.unavailable,
    blocked: !!info.blocked && !price && !info.image,
    helper_offline: ctx.helperStatus?.() === "offline",
  };
}
