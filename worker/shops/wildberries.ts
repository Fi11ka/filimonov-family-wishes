import { clean } from "./html";
import type { PriceInfo, Shop } from "./types";
// Wildberries pages are rendered by JavaScript; prices come from the public card API.
// Image hosts are sharded by "vol" (id / 100000). The table grows over time: when
// photos of new products stop loading, extend it from any product page in a browser.
const BASKETS: [number, number][] = [
  [143, 1],
  [287, 2],
  [431, 3],
  [719, 4],
  [1007, 5],
  [1061, 6],
  [1115, 7],
  [1169, 8],
  [1313, 9],
  [1601, 10],
  [1655, 11],
  [1919, 12],
  [2045, 13],
  [2189, 14],
  [2405, 15],
  [2621, 16],
  [2837, 17],
  [3053, 18],
  [3269, 19],
  [3485, 20],
  [3701, 21],
  [3917, 22],
  [4133, 23],
  [4349, 24],
  [4565, 25],
  [4877, 26],
  [5189, 27],
  [5501, 28],
  [5813, 29],
  [6125, 30],
  [6437, 31],
];
export function wbImage(id: number) {
  const vol = Math.floor(id / 100000),
    part = Math.floor(id / 1000);
  const basket = BASKETS.find(([max]) => vol <= max)?.[1] ?? 32;
  return `https://basket-${String(basket).padStart(2, "0")}.wbbasket.ru/vol${vol}/part${part}/${id}/images/big/1.webp`;
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
  sizes?: { price?: { basic?: number; product?: number; total?: number } }[];
}
export function wbPrice(p: WbProduct): PriceInfo | null {
  // Card API amounts are already in kopecks.
  const values = (p.sizes || [])
    .map((s) => s.price?.product ?? s.price?.total ?? s.price?.basic)
    .filter((v): v is number => Number.isSafeInteger(v) && (v as number) > 0);
  if (!values.length && Number.isSafeInteger(p.salePriceU ?? p.priceU))
    values.push((p.salePriceU ?? p.priceU) as number);
  if (!values.length) return null;
  const min = Math.min(...values),
    max = Math.max(...values);
  return { min, max: max !== min ? max : null, currency: "RUB" };
}
export const wildberries: Shop = {
  id: "wildberries",
  name: "Wildberries",
  matches: (u) =>
    /(^|\.)(wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru)$/.test(u.hostname),
  async parse(url, ctx) {
    const id = wbId(url);
    if (!id) return {};
    const image = wbImage(id);
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
            price: wbPrice(p),
          };
      } catch {
        // try the next API version
      }
    return { image, blocked: true };
  },
};
