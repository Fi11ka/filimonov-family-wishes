// Shared carts and wishlists: the list of product links. Each product is then
// looked up like a single link (/api/fetch/product), so photos, prices and
// short names come from the same shop modules.
import { parsePriceText } from "../../shared/price";
import { shortTitle } from "./naming";
import type { ShopContext } from "./types";
export interface CartItem {
  url: string;
  /** What the cart itself says; complete items need no product lookup. */
  title?: string;
  /** The full shop title when `title` was shortened. */
  details?: string;
  image?: string;
  price_minor?: number | null;
}
export interface Cart {
  shop: "Wildberries" | "Ozon";
  kind: "shop";
  title: string;
  items: CartItem[];
  /** The cart had more products than one import takes. */
  truncated: boolean;
}
export const CART_LIMIT = 100;
const wbHost = /(^|\.)wildberries\.(ru|by|kz|am|kg|uz)$/;
const ozonHost = /(^|\.)ozon\.(ru|by|kz)$/;
/**
 * Recognised links: WB basket (?shareId=), WB wishlist (/wlg/…), Ozon cart
 * (?share=). ChatGPT links are recognised only to explain that they cannot be
 * opened from the server: chatgpt.com does not let it in.
 */
export function cartKind(url: URL) {
  if (
    /^(chatgpt\.com|chat\.openai\.com)$/.test(url.hostname) &&
    /^\/(s|share)\/[A-Za-z0-9_-]{6,80}\/?$/.test(url.pathname)
  )
    return "chatgpt" as const;
  if (wbHost.test(url.hostname)) {
    if (/^[A-Za-z0-9_-]{4,64}$/.test(url.searchParams.get("shareId") || ""))
      return "wb-basket" as const;
    if (/^\/wlg\/[A-Za-z0-9_-]{4,64}\/?$/.test(url.pathname))
      return "wb-wishlist" as const;
  }
  if (
    ozonHost.test(url.hostname) &&
    url.pathname.startsWith("/cart") &&
    /^[A-Za-z0-9_-]{4,128}$/.test(url.searchParams.get("share") || "")
  )
    return "ozon-cart" as const;
  return null;
}
const wbProduct = (id: number) =>
  `https://www.wildberries.ru/catalog/${id}/detail.aspx`;
function finish(shop: Cart["shop"], title: string, items: CartItem[]): Cart {
  const seen = new Set<string>();
  // Items without a link (ChatGPT could not find one) are kept.
  const unique = items
    .filter((i) => !i.url || (!seen.has(i.url) && seen.add(i.url)))
    .map((i) => {
      const named = i.title ? shortTitle(i.title) : null;
      return named ? { ...i, title: named.title, details: named.details } : i;
    });
  return {
    shop,
    kind: "shop",
    title,
    items: unique.slice(0, CART_LIMIT),
    truncated: unique.length > CART_LIMIT,
  };
}
export async function readCart(url: URL, ctx: ShopContext): Promise<Cart> {
  const kind = cartKind(url);
  if (kind === "wb-basket") {
    // The same call the WB site makes when someone opens a shared basket.
    const data = (await ctx.json(
      new URL(
        `https://wbx-api-gateway.wildberries.ru/share-basket/api/v1/basket/${encodeURIComponent(url.searchParams.get("shareId")!)}`,
      ),
    )) as { items?: { nmId?: unknown }[] };
    return finish(
      "Wildberries",
      "Корзина Wildberries",
      (data.items || [])
        .map((i) => Number(i.nmId))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
        .map((id) => ({ url: wbProduct(id) })),
    );
  }
  if (kind === "wb-wishlist") {
    const code = url.pathname.split("/")[2];
    const data = (await ctx.json(
      new URL(
        `https://wishlist.common.geo.paywb.com/wishlist/api/v2/wishlists/${encodeURIComponent(code)}`,
      ),
    )) as {
      result?: {
        title?: string;
        collections?: {
          title?: string;
          product?: { id?: unknown; price?: unknown };
        }[];
      };
    };
    const r = data.result || {};
    return finish(
      "Wildberries",
      typeof r.title === "string" && r.title ? r.title : "Вишлист Wildberries",
      (r.collections || []).flatMap((c) => {
        const id = Number(c.product?.id);
        if (!Number.isSafeInteger(id) || id <= 0) return [];
        const price = Number(c.product?.price);
        return [
          {
            url: wbProduct(id),
            title: typeof c.title === "string" ? c.title : undefined,
            price_minor:
              Number.isSafeInteger(price) && price > 0 ? price : null,
          },
        ];
      }),
    );
  }
  if (kind === "ozon-cart") {
    // The shared cart opens as the modal /modal/shareCartFrom; the /cart page
    // around it is Ozon's own recommendations and is not read.
    const api = new URL(
      `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(`/modal/shareCartFrom?share=${url.searchParams.get("share")}`)}`,
    );
    let data: unknown = null;
    try {
      // Through the home helper when configured: Ozon blocks servers.
      data = jsonFromPage((await ctx.page(api, "application/json")).html);
    } catch {
      data = null;
    }
    if (!data)
      try {
        data = await ctx.json(api);
      } catch {
        data = null;
      }
    return finish("Ozon", "Корзина Ozon", ozonSharedCart(data));
  }
  throw new Error("unsupported");
}
/** A JSON answer as the helper's browser shows it: raw, or inside <pre>. */
function jsonFromPage(text: string): unknown {
  const pre = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
  const raw = (pre ?? text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
type OzonText = { text?: { text?: string } };
type OzonPrice = {
  prices?: {
    elements?: {
      price?: { text?: string }[];
      priceStyle?: { styleType?: string };
    }[];
  };
};
/**
 * Items of the shared-cart modal: widget cartSplit-… holds id, name, photo and
 * prices of each product. The Ozon-card price is skipped, like for single links.
 */
export function ozonSharedCart(data: unknown): CartItem[] {
  const states =
    (data as { widgetStates?: Record<string, unknown> } | null)?.widgetStates ||
    {};
  const items: CartItem[] = [];
  for (const [key, raw] of Object.entries(states)) {
    if (!key.startsWith("cartSplit")) continue;
    let state: { cartItems?: { product?: Record<string, unknown> }[] };
    try {
      state = typeof raw === "string" ? JSON.parse(raw) : (raw as never);
    } catch {
      continue;
    }
    for (const { product: p } of state?.cartItems || []) {
      const id = String(p?.id ?? "");
      if (!/^\d{3,12}$/.test(id)) continue;
      const title = ((p?.titleColumn as OzonText[]) || []).find(
        (c) => c?.text?.text,
      )?.text?.text;
      const prices = ((p?.priceColumn as OzonPrice[]) || []).flatMap(
        (c) => c?.prices?.elements || [],
      );
      const price =
        prices.find((e) => e.priceStyle?.styleType !== "CARD_PRICE") ||
        prices[0];
      const amount = parsePriceText(
        (price?.price || []).map((x) => x.text || "").join(" "),
      );
      const image = String(
        (p?.image as { image?: { url?: unknown } })?.image?.url || "",
      );
      items.push({
        url: `https://www.ozon.ru/product/${id}/`,
        title: typeof title === "string" ? title : undefined,
        price_minor: amount.exact ? amount.min : null,
        image: /^https:\/\/[a-z0-9.-]+\.ozone?\.ru\//i.test(image)
          ? image
          : undefined,
      });
    }
  }
  return items;
}
