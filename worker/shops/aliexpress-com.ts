import { parseAliExpress } from "./aliexpress-common";
import type { Shop } from "./types";
export const aliexpressCom: Shop = {
  id: "aliexpress-com",
  name: "AliExpress",
  matches: (u) =>
    /(^|\.)aliexpress\.(com|us)$/.test(u.hostname) ||
    u.hostname === "a.aliexpress.com",
  parse: (url, ctx) => parseAliExpress(url, ctx, "USD"),
};
