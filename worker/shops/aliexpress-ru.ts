import { parseAliExpress } from "./aliexpress-common";
import type { ProductInfo, Shop, ShopContext } from "./types";
/** Read only the same item's public preview; regional price/availability can differ. */
async function internationalPreview(url: URL, ctx: ShopContext) {
  const id = url.pathname.match(/^\/item\/(\d{5,20})\.html$/)?.[1];
  if (!id) return null; // Do not guess item IDs in short links or search pages.
  const target = new URL(`https://www.aliexpress.com/item/${id}.html`);
  const sku = url.searchParams.get("sku_id");
  if (sku && /^\d{1,20}$/.test(sku)) target.searchParams.set("sku_id", sku);
  try {
    const info = await parseAliExpress(
      target,
      {
        ...ctx,
        async page(u, accept) {
          const p = await ctx.page(u, accept);
          // A redirect to the homepage, another item or another site is not evidence.
          if (
            !/(^|\.)aliexpress\.com$/.test(p.url.hostname) ||
            p.url.pathname !== `/item/${id}.html`
          )
            throw new Error("Different item");
          return p;
        },
      },
      "USD",
    );
    return info.title && info.image
      ? { title: info.title, image: info.image }
      : null;
  } catch {
    return null;
  }
}
/** aliexpress.ru, including share links like sl.aliexpress.ru/p?key=… */
export const aliexpressRu: Shop = {
  id: "aliexpress-ru",
  name: "AliExpress Россия",
  matches: (u) => /(^|\.)aliexpress\.ru$/.test(u.hostname),
  async parse(url, ctx) {
    let primary: ProductInfo;
    try {
      primary = await parseAliExpress(url, ctx, "RUB");
    } catch {
      primary = { blocked: true };
    }
    if (primary.title && primary.image) return primary;
    const preview = await internationalPreview(url, ctx);
    if (!preview) return primary;
    return {
      ...primary,
      title: primary.title || preview.title,
      image: primary.image || preview.image,
      // Never copy the international price into a Russian SKU's wish.
      source: "aliexpress-global",
      blocked: false,
    };
  },
};
