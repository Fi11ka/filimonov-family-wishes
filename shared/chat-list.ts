// A product list written by ChatGPT (or pasted from anywhere): one item per
// numbered or bold title, with a price in roubles and a link to the product.
// Used for shared ChatGPT links (Worker) and for pasted text (browser).
import { parseAmount } from "./price";
export interface ChatItem {
  title: string;
  /** Kopecks; the current price, never the crossed-out one. */
  price_minor: number | null;
  url: string;
  image?: string;
}
const PRICE = /(\d[\d\s  ]*(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)/i;
const SHOP_URL = /https:\/\/[^\s)\]<>"'«»]+/i;
/** ChatGPT's inline entities: "url…Ссылка на Ozon…https://…" and image_group{…}. */
function plain(text: string) {
  return text
    .replace(/url[^]*([^]*)/g, " $1 ")
    .replace(/[^]*/g, "")
    .replace(/\\([.\-*_()[\]#!])/g, "$1");
}
/** Line that starts a new product: "**1. Name**", "### 2. Name", "3. **Name**", "**Name**". */
function titleOf(line: string): string | null {
  const t = line.trim();
  if (/^(итого|всего|сумма|общая)/i.test(t.replace(/[*#_\s]/g, "")))
    return null;
  const m =
    t.match(/^#{1,4}\s*(?:\d+[.)]\s*)?(.+)$/) ||
    t.match(/^(?:\d+[.)]\s*)?\*\*(.+?)\*\*\s*$/) ||
    t.match(/^\*\*\s*\d+[.)]\s*(.+?)\*\*/) ||
    t.match(/^\d+[.)]\s+(.+)$/);
  if (!m) return null;
  const name = m[1]
    .replace(/\*\*/g, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/\s*[—–-]\s*\d[\d\s  ]*(?:₽|руб).*$/i, "")
    .trim();
  // "## 249 ₽" is a price heading, not a product.
  if (!name || (PRICE.test(name) && name.replace(PRICE, "").trim().length < 2))
    return null;
  return name.slice(0, 200);
}
function priceOf(line: string): number | null {
  // Old prices are crossed out: ~~252 ₽~~.
  const m = line.replace(/~~[^~]*~~/g, "").match(PRICE);
  return m ? parseAmount(m[1].replace(/[\s  ]/g, "")) : null;
}
export function parseChatList(input: string, limit = 100): ChatItem[] {
  const items: ChatItem[] = [];
  let current: ChatItem | null = null;
  for (const raw of plain(input).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    const title = titleOf(line);
    if (title) {
      if (current) items.push(current);
      current = { title, price_minor: null, url: "" };
      // "1. Name — 249 ₽ — https://…" on one line.
      const rest = line.replace(/\*\*[^*]*\*\*/, "");
      current.price_minor = priceOf(rest);
      current.url = rest.match(SHOP_URL)?.[0] || "";
      continue;
    }
    if (!current) continue;
    if (/^(итого|всего)/i.test(line.replace(/[*#_\s]/g, ""))) {
      items.push(current);
      current = null;
      continue;
    }
    const image = line.match(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/)?.[1];
    if (image && !current.image) current.image = image;
    const withoutImages = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    if (current.price_minor === null)
      current.price_minor = priceOf(withoutImages);
    const link = withoutImages.match(SHOP_URL)?.[0];
    if (link && !current.url) current.url = link.replace(/[.,;]+$/, "");
  }
  if (current) items.push(current);
  return items
    .filter((i) => i.url || i.price_minor !== null)
    .map((i) => {
      // Tracking added by ChatGPT is not part of the product address.
      try {
        if (i.url) {
          const u = new URL(i.url);
          u.searchParams.delete("utm_source");
          i.url = u.href;
        }
      } catch {
        i.url = "";
      }
      return i;
    })
    .slice(0, limit);
}
/**
 * The answer text inside a shared ChatGPT page. The page streams its data as
 * React Router "turbo-stream" chunks: enqueue("…JSON…"). Message texts are plain
 * strings in that array; the one listing the most products is the answer.
 */
export function chatShareText(html: string): string {
  const chunks = [...html.matchAll(/enqueue\(("(?:[^"\\]|\\.)*")\)/g)];
  let stream = "";
  for (const c of chunks)
    try {
      stream += JSON.parse(c[1]);
    } catch {
      // a chunk that is not a plain string literal
    }
  let best = "",
    bestCount = 0;
  for (const line of stream.split("\n")) {
    let values: unknown;
    try {
      values = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(values)) continue;
    for (const v of values)
      if (
        typeof v === "string" &&
        v.length > 40 &&
        /₽|руб|https:\/\//i.test(v)
      ) {
        const n = parseChatList(v).length;
        if (n > bestCount || (n === bestCount && n > 0)) {
          best = v;
          bestCount = n;
        }
      }
  }
  return best;
}
