import { clean } from "./html";
import type { PriceInfo, Shop, ShopContext } from "./types";
// Wildberries pages are rendered by JavaScript and the card API refuses servers.
// Product data comes from the image CDN instead: info/ru/card.json (name, brand)
// and info/price-history.json (weekly price). CDN hosts are sharded by "vol"
// (id / 100000); the current map is published at cdn.wbbasket.ru/api/v3/upstreams.
const UPSTREAMS = "https://cdn.wbbasket.ru/api/v3/upstreams";
/** Last vol of basket-01, basket-02, … as of October 2026; used when the live map is unavailable. */
const VOL_TOPS = [
  143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045,
  2189, 2405, 2621, 2837, 3053, 3269, 3485, 3701, 3917, 4133, 4349, 4565, 4877,
  5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173,
  9605, 10373, 11141, 11909, 12677, 13445, 14213, 14981, 15749, 16517, 17285,
  18053, 18821, 19589, 20357, 21125, 21893, 22661, 23429, 24197, 24965, 25733,
  26501, 27269, 28037, 28805,
];
type Route = [from: number, to: number, host: string];
const fallbackRoutes: Route[] = VOL_TOPS.map((to, i) => [
  i ? VOL_TOPS[i - 1] + 1 : 0,
  to,
  `basket-${String(i + 1).padStart(2, "0")}.wbbasket.ru`,
]);
let liveRoutes: { routes: Route[]; at: number } | null = null;
/** The live map, cached per Worker instance for an hour. */
export async function wbRoutes(ctx: ShopContext): Promise<Route[]> {
  if (liveRoutes && Date.now() - liveRoutes.at < 3600_000)
    return liveRoutes.routes;
  try {
    const data = (await ctx.json(new URL(UPSTREAMS))) as {
      recommend?: {
        mediabasket_route_map?: {
          hosts?: {
            vol_range_from: number;
            vol_range_to: number;
            host: string;
          }[];
        }[];
      };
    };
    const routes = (data.recommend?.mediabasket_route_map?.[0]?.hosts || [])
      .filter(
        (h) =>
          Number.isSafeInteger(h.vol_range_from) &&
          Number.isSafeInteger(h.vol_range_to) &&
          /^basket-\d{2,3}\.wb(content\.net|basket\.ru)$/.test(h.host),
      )
      .map((h): Route => [h.vol_range_from, h.vol_range_to, h.host]);
    if (routes.length) {
      liveRoutes = { routes, at: Date.now() };
      return routes;
    }
  } catch {
    // keep the built-in table
  }
  return fallbackRoutes;
}
/** Folder of a product on the CDN, e.g. https://basket-45.wbcontent.net/vol12873/part1287301/1287301270 */
export function wbBase(id: number, routes: Route[] = fallbackRoutes) {
  const vol = Math.floor(id / 100000),
    part = Math.floor(id / 1000);
  const inRange = ([from, to]: Route) => vol >= from && vol <= to;
  let host = (routes.find(inRange) || fallbackRoutes.find(inRange))?.[2];
  if (!host) {
    // Newer than the table: baskets after the last one hold 768 vols each.
    const last = VOL_TOPS.length,
      extra = Math.max(1, Math.ceil((vol - VOL_TOPS[last - 1]) / 768));
    host = `basket-${String(last + extra).padStart(2, "0")}.wbbasket.ru`;
  }
  return `https://${host}/vol${vol}/part${part}/${id}`;
}
export function wbImage(id: number, routes?: Route[]) {
  return `${wbBase(id, routes)}/images/big/1.webp`;
}
export function wbId(url: URL) {
  const m =
    url.pathname.match(/\/catalog\/(\d{3,12})\//) ||
    url.searchParams.get("nm")?.match(/^(\d{3,12})$/);
  return m ? Number(m[1]) : null;
}
interface WbProduct {
  name?: string;
  brand?: string;
  salePriceU?: number;
  priceU?: number;
  totalQuantity?: number;
  sizes?: {
    chrtId?: number;
    optionId?: number;
    price?: { basic?: number; product?: number; total?: number };
  }[];
}
export function wbPrice(
  p: WbProduct,
  size: string | null = null,
): PriceInfo | null {
  // Card API amounts are already in kopecks.
  const values = (p.sizes || [])
    .filter((s) => !size || String(s.optionId ?? s.chrtId) === size)
    .map((s) => s.price?.product ?? s.price?.total ?? s.price?.basic)
    .filter((v): v is number => Number.isSafeInteger(v) && (v as number) > 0);
  if (!size && !values.length && Number.isSafeInteger(p.salePriceU ?? p.priceU))
    values.push((p.salePriceU ?? p.priceU) as number);
  if (!values.length) return null;
  const min = Math.min(...values),
    max = Math.max(...values);
  return { min, max: max !== min ? max : null, currency: "RUB" };
}
interface WbCdnCard {
  imt_name?: string;
  selling?: { brand_name?: string };
}
/** The most recent weekly price; amounts are kopecks. */
export function wbHistoryPrice(history: unknown): PriceInfo | null {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const v = (history[i] as { price?: { RUB?: unknown } })?.price?.RUB;
    if (Number.isSafeInteger(v) && (v as number) > 0)
      return { min: v as number, max: null, currency: "RUB" };
  }
  return null;
}
export const wildberries: Shop = {
  id: "wildberries",
  name: "Wildberries",
  matches: (u) =>
    /(^|\.)(wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru)$/.test(u.hostname),
  async parse(url, ctx) {
    const id = wbId(url);
    if (!id) return {};
    const base = wbBase(id, await wbRoutes(ctx));
    const image = `${base}/images/big/1.webp`;
    for (const version of ["v4", "v2"])
      try {
        const data = (await ctx.json(
          new URL(
            `https://card.wb.ru/cards/${version}/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${id}`,
          ),
        )) as { products?: WbProduct[]; data?: { products?: WbProduct[] } };
        const p = (data.products || data.data?.products || [])[0];
        if (p)
          return {
            title: clean([p.brand, p.name].filter(Boolean).join(" ")),
            image,
            price: wbPrice(p, url.searchParams.get("size")),
            unavailable: p.totalQuantity === 0,
          };
      } catch {
        // try the next API version, then the CDN
      }
    const [card, history] = await Promise.all([
      ctx.json(new URL(`${base}/info/ru/card.json`)).catch(() => null),
      ctx.json(new URL(`${base}/info/price-history.json`)).catch(() => null),
    ]);
    const c = (card || {}) as WbCdnCard;
    const title = clean(
      [c.selling?.brand_name, c.imt_name].filter(Boolean).join(" "),
    );
    if (!title) return { image, blocked: true };
    return { title, image, price: wbHistoryPrice(history) };
  },
};
