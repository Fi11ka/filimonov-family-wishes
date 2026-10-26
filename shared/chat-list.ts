// A product list pasted as text: the answer of ChatGPT to CHAT_PROMPT
// ("Название | Цена | Ссылка" lines), a table copied from anywhere, a list of
// links, or a free-form list with numbered/bold titles, prices and links.
import { parseAmount, parsePriceText } from "./price";
export interface ChatItem {
  /** Empty when only a link was given; the shop lookup names it. */
  title: string;
  /** Kopecks; the current price, never the crossed-out one. */
  price_minor: number | null;
  /** Upper bound of a price range ("1000-3000"). */
  price_max_minor?: number | null;
  url: string;
  image?: string;
}
const EMPTY = /^(нет|не указан[аоы]?|неизвестн[оа]|—|–|-|n\/a|none|null)$/i;
/** "Название | Цена | Ссылка", a Markdown table row or tab-separated cells. */
function fieldsOf(line: string): ChatItem | "skip" | null {
  const t = line.replace(/^\|/, "").replace(/\|$/, "");
  const parts = t.includes("|")
    ? t.split("|")
    : t.includes("\t")
      ? t.split("\t")
      : null;
  if (!parts || parts.length < 2) return null;
  const cells = parts.map((p) => p.trim().replace(/^\*\*|\*\*$/g, ""));
  if (cells.every((c) => !c || /^:?-{2,}:?$/.test(c))) return "skip";
  // The header line of the answer or of a table.
  if (
    cells.some((c) => /^(название|наименование|товар|name|item)$/i.test(c)) &&
    cells.some((c) => /^(цена|стоимость|price|ссылка|link|url)$/i.test(c))
  )
    return "skip";
  const url =
    cells
      .map((c) => c.match(SHOP_URL)?.[0])
      .find(Boolean)
      ?.replace(/[.,;]+$/, "") || "";
  let price: ReturnType<typeof parsePriceText> | null = null,
    priceCell = -1;
  cells.forEach((c, i) => {
    if (price || !c || SHOP_URL.test(c) || EMPTY.test(c)) return;
    const p = parsePriceText(c.replace(/~~[^~]*~~/g, ""));
    if (
      p.exact &&
      (p.min !== null || p.max !== null) &&
      /^[\d\s  .,–—-]*(₽|руб\.?|р\.|rub)?$|^(от|до)\s/i.test(c.trim())
    ) {
      price = p;
      priceCell = i;
    }
  });
  const title =
    cells.find(
      (c, i) => c && i !== priceCell && !SHOP_URL.test(c) && !EMPTY.test(c),
    ) || "";
  const parsed = price as ReturnType<typeof parsePriceText> | null;
  if (!title && !url) return null;
  return {
    title: title.replace(/^\d+[.)]\s*/, "").slice(0, 200),
    price_minor: parsed ? (parsed.min ?? null) : null,
    price_max_minor: parsed && parsed.range ? parsed.max : null,
    url,
  };
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
  // Lines in "Name | Price | Link" form are wishes even with a name only.
  const structured = new Set<ChatItem>();
  let current: ChatItem | null = null;
  for (const raw of plain(input).split(/\r?\n/)) {
    const line = raw.trim().replace(/^```\w*$/, "");
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    // One product per line: "Name | Price | Link", a table row, or just a link.
    const fields = fieldsOf(line);
    if (fields === "skip") continue;
    const bare = line.match(/^(?:[-*•]\s*|\d+[.)]\s*)?(https:\/\/\S+)$/)?.[1];
    if (fields || bare) {
      if (current) items.push(current);
      current = null;
      const item = fields || {
        title: "",
        price_minor: null,
        url: bare!.replace(/[.,;]+$/, ""),
      };
      structured.add(item);
      items.push(item);
      continue;
    }
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
    .filter(
      (i) => i.url || i.price_minor !== null || (structured.has(i) && i.title),
    )
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
