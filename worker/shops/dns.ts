import { fromPage, ldProduct, openGraph } from "./html";
import type { Shop } from "./types";
// DNS answers servers with a Qrator challenge (HTTP 401); a home browser gets
// the page, which carries a full schema.org Product: name, price in RUB, photos.
// Pages therefore come through the home helper when it is running.
export const dns: Shop = {
  id: "dns",
  name: "DNS",
  matches: (u) => /(^|\.)dns-shop\.(ru|kz)$/.test(u.hostname),
  async parse(url, ctx) {
    const page = await ctx.page(url);
    return fromPage(
      page,
      ldProduct(page.html, page.url),
      openGraph(page.html, page.url),
    );
  },
};
