import { parseAliExpress } from "./aliexpress-common";
import type { Shop } from "./types";
/** aliexpress.ru, including share links like sl.aliexpress.ru/p?key=… */
export const aliexpressRu: Shop = {
  id: "aliexpress-ru",
  name: "AliExpress Россия",
  matches: (u) => /(^|\.)aliexpress\.ru$/.test(u.hostname),
  parse: (url, ctx) => parseAliExpress(url, ctx, "RUB"),
};
