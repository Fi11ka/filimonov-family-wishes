// Shared carts and wishlists: the list of product links. Each product is then
// looked up like a single link (/api/fetch/product), so photos, prices and
// short names come from the same shop modules.
import type { ShopContext } from "./types";
export interface CartItem {
  url: string;
  /** What the cart itself says; used when the product lookup finds nothing. */
  title?: string;
  price_minor?: number | null;
}
export interface Cart {
  shop: "Wildberries" | "Ozon";
  title: string;
  items: CartItem[];
  /** The cart had more products than one import takes. */
  truncated: boolean;
}
export const CART_LIMIT = 100;
const wbHost = /(^|\.)wildberries\.(ru|by|kz|am|kg|uz)$/;
const ozonHost = /(^|\.)ozon\.(ru|by|kz)$/;
/** Recognised links: WB basket (?shareId=), WB wishlist (/wlg/…), Ozon cart (?share=). */
export function cartKind(url: URL) {
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
  const unique = items.filter((i) => !seen.has(i.url) && seen.add(i.url));
  return {
    shop,
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
    // Ozon renders the shared cart on its page; product links are collected from
    // the page and, if it is an anti-bot stub, from the page API.
    const path = `${url.pathname}${url.search}`;
    let text = "";
    try {
      text = (await ctx.page(url)).html;
    } catch {
      text = "";
    }
    let items = ozonProducts(text);
    if (!items.length)
      try {
        const api = await ctx.json(
          new URL(
            `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
          ),
        );
        items = ozonProducts(JSON.stringify(api));
      } catch {
        items = [];
      }
    return finish("Ozon", "Корзина Ozon", items);
  }
  throw new Error("unsupported");
}
/** Product links anywhere in Ozon HTML or JSON: /product/<slug>-<id>/ or /product/<id>/. */
export function ozonProducts(text: string): CartItem[] {
  const ids = new Set<string>();
  for (const m of text
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .matchAll(/\/product\/(?:[a-z0-9-]*-)?(\d{5,12})(?=[/?"'\\])/gi))
    ids.add(m[1]);
  return [...ids].map((id) => ({ url: `https://www.ozon.ru/product/${id}/` }));
}
