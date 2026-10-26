import { heartsFromLevel } from "../../shared/hearts";
import { parsePriceText, type Currency } from "../../shared/price";
import type { Cell, Sheet, SheetImage } from "./xlsx";
// Turns a loosely filled spreadsheet into editable import rows. The rule is:
// recognise what we can, and put everything else into the comment so nothing is lost.
export type ImportImage =
  | { kind: "embedded"; path: string; type: string }
  | { kind: "url"; url: string };
export interface ImportRow {
  key: string;
  sheet: string;
  /** 1-based row number as shown in the spreadsheet */
  line: number;
  include: boolean;
  title: string;
  priceMode: "none" | "exact" | "range";
  priceMin: string;
  priceMax: string;
  currency: Currency;
  shopUrl: string;
  description: string;
  /** 1–5 hearts */
  priority: number;
  archived: boolean;
  image: ImportImage | null;
  warnings: string[];
}
type Field =
  | "title"
  | "image"
  | "recipient"
  | "price"
  | "priority"
  | "link"
  | "comment"
  | "currency";
const HEADERS: [Field, RegExp][] = [
  [
    "title",
    /^(подар|название|желани|товар|наименован|что|предмет|вещь|позици|хотелк|идея|хочу|title|name|item|gift|product|wish)/i,
  ],
  ["image", /^(картинк|фото|изображ|image|photo|picture|pic)/i],
  ["recipient", /^(кому|для кого|получател|recipient|for)/i],
  ["price", /^(цена|стоимост|бюджет|сумма|руб|₽|price|cost|amount)/i],
  ["priority", /^(приоритет|важност|желанност|очередн|priority|rank)/i],
  [
    "link",
    /^(ссылк|link|url|магазин|где купить|где|сайт|маркетплейс|shop|store)/i,
  ],
  [
    "comment",
    /^(коммент|описани|примечани|подсказк|детали|заметк|note|description|comment|details)/i,
  ],
  ["currency", /^(валют|currency)/i],
];
const TITLE_MAX = 120,
  DESCRIPTION_MAX = 2000;
type Level = 1 | 2 | 3 | "bought" | null;
/** Words people use for priority and status. */
export function levelOf(text: string): Level | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  if (/^(куплен|купили|подарен|подарили|есть|готово|bought|done)/.test(t))
    return "bought";
  if (/выше\s+средн/.test(t)) return 2;
  if (/ниже\s+средн/.test(t)) return 1;
  if (/^(высок|очень|мечта|главн|важно|срочно|top|high|3\b|\+\+\+|!!!)/.test(t))
    return 3;
  if (/^(средн|хочется|норм|medium|2\b|\+\+|!!)/.test(t)) return 2;
  if (/^(низк|приятно|можно|не срочно|low|1\b|\+$|!$)/.test(t)) return 1;
  if (/^(отметка|для себя|note)/.test(t)) return null;
  return undefined;
}
interface Legend {
  colours: Map<string, Level>;
  cells: Set<string>;
}
/**
 * Finds a "Приоритет:" legend placed beside the table: a column of coloured
 * cells with labels to the right. Unlabelled colours between two labels get an
 * interpolated level (the legend in the family sheet labels only the ends).
 */
export function findLegend(
  sheet: Sheet,
  headerRow: number,
  lastHeaderCol: number,
): Legend {
  const colours = new Map<string, Level>(),
    cells = new Set<string>();
  for (let r = 0; r < sheet.rows.length; r++)
    for (let c = 0; c < (sheet.rows[r]?.length || 0); c++) {
      const v = sheet.rows[r][c]?.value || "";
      const isLegend =
        /^приоритет\s*:\s*$/i.test(v) ||
        (r !== headerRow && c > lastHeaderCol && /^приоритет/i.test(v));
      if (!isLegend) continue;
      cells.add(`${r},${c}`);
      const entries: {
        row: number;
        fill?: string;
        level: Level | undefined;
      }[] = [];
      for (let rr = r + 1; rr < Math.min(sheet.rows.length, r + 12); rr++) {
        const colour = sheet.rows[rr]?.[c],
          label = sheet.rows[rr]?.[c + 1];
        const fill = colour?.fill || label?.fill;
        if (!fill && !label?.value) break;
        cells.add(`${rr},${c}`);
        cells.add(`${rr},${c + 1}`);
        entries.push({
          row: rr,
          fill,
          level: label?.value ? levelOf(label.value) : undefined,
        });
      }
      const numeric = entries.filter(
        (e): e is { row: number; fill?: string; level: 1 | 2 | 3 } =>
          typeof e.level === "number",
      );
      for (const e of entries) {
        if (!e.fill) continue;
        let level = e.level;
        if (level === undefined && numeric.length) {
          const above = [...numeric].reverse().find((n) => n.row < e.row),
            below = numeric.find((n) => n.row > e.row);
          if (above && below)
            level = Math.round(
              above.level +
                ((below.level - above.level) * (e.row - above.row)) /
                  (below.row - above.row),
            ) as 1 | 2 | 3;
          else level = (above || below)!.level;
        }
        if (level !== undefined && !colours.has(e.fill))
          colours.set(e.fill, level);
      }
    }
  return { colours, cells };
}
const URL_RE = /\bhttps?:\/\/[^\s<>"'«»]+/gi;
/** Search engines and social networks wrap pasted links; recover the target. */
export function unwrapLink(link: string): string | null {
  try {
    const u = new URL(link);
    const target =
      (/(^|\.)google\.[a-z.]+$/.test(u.hostname) &&
        u.pathname === "/url" &&
        u.searchParams.get("q")) ||
      (/(^|\.)vk\.com$/.test(u.hostname) &&
        u.pathname === "/away.php" &&
        u.searchParams.get("to")) ||
      (u.hostname === "l.facebook.com" && u.searchParams.get("u"));
    if (target) return /^https?:\/\//i.test(target) ? target : null;
    // Yandex click-tracking links cannot be decoded offline.
    if (u.hostname === "clck.yandex.ru") return null;
    return link;
  } catch {
    return null;
  }
}
function urlsIn(cell: Cell | undefined) {
  const found = new Set<string>();
  // Text first: the cell often shows the real address while its hyperlink is a tracker.
  for (const m of cell?.value.matchAll(URL_RE) || [])
    found.add(m[0].replace(/[),.;]+$/, ""));
  const link =
    cell?.link && /^https?:\/\//i.test(cell.link)
      ? unwrapLink(cell.link)
      : null;
  if (link) found.add(link);
  return [...found];
}
function textWithoutUrls(cell: Cell | undefined) {
  return (cell?.value || "").replace(URL_RE, " ").replace(/\s+/g, " ").trim();
}
export function amountText(minor: number | null) {
  if (minor === null) return "";
  return minor % 100 ? (minor / 100).toFixed(2) : String(minor / 100);
}
function validShopUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && !url.username && u.length <= 2048;
  } catch {
    return false;
  }
}
/** A cell that is only a price: "2 490 ₽", "1000-3000", "от 500", "2490". */
function looksLikePrice(value: string) {
  const v = value.trim();
  if (!v || v.length > 40 || URL_RE.test(v)) return false;
  URL_RE.lastIndex = 0;
  const p = parsePriceText(v);
  if (!p.exact || (p.min === null && p.max === null)) return false;
  // Bare small numbers are more often a quantity, a size or a row number.
  return !!p.currency || p.range || (p.min ?? p.max ?? 0) >= 10000;
}
/**
 * Which column holds what. A header row is looked up among the first ten rows
 * by known words in any order; columns it does not name are recognised by their
 * contents: links, prices, priority words, and the most wordy column is the title.
 */
export function detectColumns(sheet: Sheet) {
  let headerRow = -1;
  const columns = new Map<Field, number>();
  const labels = new Map<number, string>();
  for (let r = 0; r < Math.min(10, sheet.rows.length) && headerRow < 0; r++) {
    const row = sheet.rows[r] || [];
    const found = new Map<Field, number>();
    row.forEach((cell, c) => {
      const v = cell?.value.trim() || "";
      // Headers are short: "Подарок для мамы на юбилей" is data.
      if (!v || v.length > 30 || v.split(/\s+/).length > 3 || URL_RE.test(v))
        return;
      URL_RE.lastIndex = 0;
      const field = HEADERS.find(([, re]) => re.test(v))?.[0];
      if (field && !found.has(field)) found.set(field, c);
    });
    // One known word is enough for the title; otherwise two different ones.
    if (!found.has("title") && found.size < 2) continue;
    headerRow = r;
    found.forEach((c, f) => columns.set(f, c));
    row.forEach((cell, c) => {
      if (cell?.value.trim()) labels.set(c, cell.value.trim().slice(0, 40));
    });
  }
  const data = sheet.rows.slice(headerRow + 1, headerRow + 81);
  const width = Math.max(0, ...data.map((r) => r?.length || 0));
  const used = () => new Set(columns.values());
  const stats = Array.from({ length: width }, (_, c) => {
    let filled = 0,
      urls = 0,
      prices = 0,
      levels = 0,
      words = 0,
      letters = 0;
    for (const row of data) {
      const cell = row?.[c];
      const v = cell?.value.trim() || "";
      if (!v && !cell?.link) continue;
      filled++;
      if (urlsIn(cell).length) urls++;
      if (looksLikePrice(v)) prices++;
      // Priority by content only from words: bare digits are usually row numbers.
      else if (!/^\d+$/.test(v) && levelOf(v) !== undefined) levels++;
      const text = textWithoutUrls(cell);
      if (/[A-Za-zА-ЯЁа-яё]{2,}/.test(text) && !looksLikePrice(text)) {
        words++;
        letters += text.length;
      }
    }
    return { c, filled, urls, prices, levels, words, letters };
  });
  const pick = (
    field: Field,
    score: (s: (typeof stats)[number]) => number,
    enough: (s: (typeof stats)[number]) => boolean,
  ) => {
    if (columns.has(field)) return;
    const taken = used();
    const best = stats
      .filter((s) => !taken.has(s.c) && s.filled && enough(s))
      .sort((a, b) => score(b) - score(a) || a.c - b.c)[0];
    if (best) columns.set(field, best.c);
  };
  pick(
    "link",
    (s) => s.urls,
    (s) => s.urls >= Math.max(1, s.filled * 0.3),
  );
  pick(
    "price",
    (s) => s.prices,
    (s) => s.prices >= Math.max(1, s.filled * 0.6),
  );
  pick(
    "priority",
    (s) => s.levels,
    (s) => s.levels >= Math.max(1, s.filled * 0.6),
  );
  // The title: the column with the most words, preferring longer texts.
  pick(
    "title",
    (s) => s.words * 1000 + s.letters / Math.max(1, s.words),
    (s) => s.words > 0,
  );
  if (!columns.has("title")) columns.set("title", columns.get("link") ?? 0);
  // Row numbers 1, 2, 3… carry nothing worth keeping.
  const skip = new Set<number>();
  for (const st of stats) {
    if (used().has(st.c) || st.filled < 2) continue;
    const values = data
      .map((r) => r?.[st.c]?.value.trim() || "")
      .filter(Boolean);
    if (values.every((v, i) => v === String(Number(values[0]) + i)))
      skip.add(st.c);
  }
  return { headerRow, columns, labels, skip };
}
export function normalizeSheet(sheet: Sheet, currency: Currency): ImportRow[] {
  const { headerRow, columns, labels, skip } = detectColumns(sheet);
  const lastHeaderCol =
    headerRow < 0 ? 0 : (sheet.rows[headerRow]?.length || 1) - 1;
  const legend = findLegend(sheet, headerRow, lastHeaderCol);
  const mapped = new Set(columns.values());
  const at = (r: number, f: Field) => {
    const c = columns.get(f);
    return c === undefined || legend.cells.has(`${r},${c}`)
      ? undefined
      : sheet.rows[r]?.[c];
  };
  const out: ImportRow[] = [];
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const warnings: string[] = [],
      notes: string[] = [];
    const titleCell = at(r, "title");
    let title = textWithoutUrls(titleCell) || titleCell?.value || "";
    // Links: the link column, columns to its right, and any link on the title.
    const linkCol = columns.get("link");
    const extraCells: Cell[] = [];
    row.forEach((cell, c) => {
      if (!cell || legend.cells.has(`${r},${c}`)) return;
      // Leftover legend labels far to the right of the table ("высокий (больше хочется)").
      if (
        c >= lastHeaderCol + 3 &&
        levelOf(cell.value) !== undefined &&
        !urlsIn(cell).length
      )
        return;
      // Everything the columns above did not take is kept in the hint.
      if (c === linkCol || (!mapped.has(c) && !skip.has(c)))
        extraCells.push(cell);
    });
    const urls = [
      ...new Set([...urlsIn(titleCell), ...extraCells.flatMap(urlsIn)]),
    ];
    const extraText = extraCells
      .map((cell) => {
        const text = textWithoutUrls(cell);
        const c = row.indexOf(cell);
        const label = c !== linkCol ? labels.get(c) : undefined;
        return text && label ? `${label}: ${text}` : text;
      })
      .filter((t) => t && !/^#(N\/A|REF!|VALUE!|ERROR!)/i.test(t));
    const priceCell = at(r, "price");
    const parsed = parsePriceText(priceCell?.value);
    const priorityCell = at(r, "priority");
    const imageCell = at(r, "image");
    const recipient = at(r, "recipient")?.value || "";
    const comment = at(r, "comment")?.value || "";
    const meaningful =
      title ||
      urls.length ||
      parsed.min !== null ||
      parsed.max !== null ||
      extraText.length ||
      comment;
    if (!meaningful) continue;
    if (!title) {
      title = "Без названия";
      warnings.push("Нет названия");
    }
    if (title.length > TITLE_MAX) {
      notes.push(`Полное название: ${title}`);
      title = title.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, "") + "…";
      warnings.push("Название сокращено");
    }
    // Priority: words first, then the legend colour of the priority (or title) cell.
    let priority = 3,
      archived = false,
      known = false;
    const word = priorityCell?.value ? levelOf(priorityCell.value) : undefined;
    if (word === "bought") archived = known = true;
    else if (typeof word === "number") {
      priority = heartsFromLevel(word);
      known = true;
    } else if (priorityCell?.value && word === undefined)
      notes.push(`Приоритет в таблице: ${priorityCell.value}`);
    const fill = priorityCell?.fill || titleCell?.fill;
    const colour = fill ? legend.colours.get(fill) : undefined;
    if (colour === "bought") archived = true;
    else if (typeof colour === "number" && !(known && typeof word === "number"))
      priority = heartsFromLevel(colour);
    // Price
    let priceMode: ImportRow["priceMode"] = "none";
    if (parsed.min !== null || parsed.max !== null)
      priceMode = parsed.range || parsed.max !== null ? "range" : "exact";
    if (!parsed.exact && priceCell?.value) {
      notes.push(`Цена в таблице: ${priceCell.value}`);
      warnings.push(
        parsed.min === null && parsed.max === null
          ? "Цена не распознана"
          : "Проверьте цену",
      );
    }
    // Links: first https link goes to the shop field, the rest to the comment.
    const shopUrl = urls.find(validShopUrl) || "";
    const otherUrls = urls.filter((u) => u !== shopUrl);
    if (recipient) notes.unshift(`Кому: ${recipient}`);
    if (comment) notes.unshift(comment);
    if (extraText.length)
      notes.push(
        extraText.length === 1
          ? extraText[0]
          : `Ещё:\n${extraText.map((t) => `— ${t}`).join("\n")}`,
      );
    if (otherUrls.length)
      notes.push(
        `${otherUrls.length === 1 ? "Ещё ссылка" : "Ещё ссылки"}:\n${otherUrls.join("\n")}`,
      );
    let description = notes.join("\n");
    if (description.length > DESCRIPTION_MAX) {
      description = description.slice(0, DESCRIPTION_MAX - 1) + "…";
      warnings.push("Комментарий сокращён");
    }
    // Picture placed over the row, or IMAGE("…") formula in it.
    let image: ImportImage | null = null;
    const imageCol = columns.get("image");
    const anchored: SheetImage | undefined =
      (imageCol !== undefined
        ? sheet.images.get(`${r},${imageCol}`)
        : undefined) ||
      [...sheet.images.entries()].find(([k]) => k.startsWith(`${r},`))?.[1];
    if (anchored) image = { kind: "embedded", ...anchored };
    else {
      const url = imageCell?.imageUrl || row.find((c) => c?.imageUrl)?.imageUrl;
      if (url && /^https:\/\//i.test(url)) image = { kind: "url", url };
    }
    out.push({
      key: `${sheet.name}:${r}`,
      sheet: sheet.name,
      line: r + 1,
      include: true,
      title,
      priceMode,
      priceMin: amountText(parsed.min),
      priceMax: amountText(parsed.max),
      currency: parsed.currency || currency,
      shopUrl,
      description,
      priority,
      archived,
      image,
      warnings,
    });
  }
  return out;
}
/** Converts an edited row into the API payload (without the photo). */
export function rowPayload(row: ImportRow) {
  const minor = (s: string) => {
    const v = s.trim().replace(/\s/g, "").replace(",", ".");
    if (!v) return null;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(v))
      throw new Error(`Строка ${row.line}: проверьте цену.`);
    return Math.round(Number(v) * 100);
  };
  const min = row.priceMode === "none" ? null : minor(row.priceMin),
    max = row.priceMode === "range" ? minor(row.priceMax) : null;
  if (min !== null && max !== null && max < min)
    throw new Error(`Строка ${row.line}: цена «до» меньше цены «от».`);
  return {
    title: row.title.trim().slice(0, TITLE_MAX) || "Без названия",
    price_minor: min,
    price_max_minor: max,
    price_range: row.priceMode === "range",
    currency: row.currency,
    shop_url: validShopUrl(row.shopUrl.trim()) ? row.shopUrl.trim() : "",
    description: row.description.slice(0, DESCRIPTION_MAX),
    priority: row.priority,
    archived: row.archived,
  };
}
