import { fromPage, ldProduct, openGraph } from "./html";
import type { Shop } from "./types";
/** Any other site: schema.org Product first, then Open Graph tags. */
export const generic: Shop = {
  id: "generic",
  name: "Сайт магазина",
  matches: () => true,
  async parse(url, ctx) {
    const page = await ctx.page(url);
    return fromPage(
      page,
      ldProduct(page.html, page.url),
      openGraph(page.html, page.url),
    );
  },
};
