import { strFromU8, unzipSync } from "fflate";
// Minimal .xlsx reader for wishlist import: values, hyperlinks, fill colours,
// IMAGE() formulas and pictures placed over cells. No DOM APIs, so it also runs
// in Node tests. Spreadsheets are untrusted input: only strings and image bytes
// are extracted, nothing is evaluated.
export interface Cell {
  value: string;
  link?: string;
  /** IMAGE("…") formula target */
  imageUrl?: string;
  /** Background fill as RRGGBB, when set */
  fill?: string;
}
export interface SheetImage {
  path: string;
  type: string;
}
export interface Sheet {
  name: string;
  /** rows[r][c], zero-based */
  rows: Cell[][];
  /** "row,col" (zero-based) → picture anchored at that cell */
  images: Map<string, SheetImage>;
}
export interface Workbook {
  sheets: Sheet[];
  /** Reads a picture's bytes lazily (pictures can be tens of MB in total). */
  image(path: string): Uint8Array | null;
}
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
function decode(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&amp;/g, "&");
}
function attr(tag: string, name: string) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
}
function texts(xml: string) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => decode(m[1]))
    .join("");
}
function rels(xml: string | undefined) {
  const out: Record<string, string> = {};
  for (const m of (xml || "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"),
      target = attr(m[0], "Target");
    if (id && target) out[id] = target;
  }
  return out;
}
function join(base: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}
function relsPath(path: string) {
  const i = path.lastIndexOf("/");
  return `${path.slice(0, i)}/_rels/${path.slice(i + 1)}.rels`;
}
export function colIndex(letters: string) {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
function rgb(xml: string) {
  const v = xml.match(/<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/)?.[1];
  return v ? v.slice(-6).toUpperCase() : undefined;
}
export function readXlsx(data: Uint8Array): Workbook {
  // First pass: XML parts only. Media stays compressed until requested.
  const files = unzipSync(data, {
    filter: (f) => !f.name.startsWith("xl/media/"),
  });
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : undefined);
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new Error("Это не похоже на файл Excel (.xlsx).");
  const shared = [
    ...(read("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) => texts(m[1]));
  const styles = read("xl/styles.xml") || "";
  const fills = [
    ...(styles.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/)?.[1] || "").matchAll(
      /<fill>([\s\S]*?)<\/fill>/g,
    ),
  ].map((m) => rgb(m[1]));
  const xfFills = [
    ...(
      styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || ""
    ).matchAll(/<xf\b[^>]*>/g),
  ].map((m) => Number(attr(m[0], "fillId") || 0));
  const wbRels = rels(read("xl/_rels/workbook.xml.rels"));
  const sheets: Sheet[] = [];
  for (const tag of workbook.match(/<sheet\b[^>]*>/g) || []) {
    const name = attr(tag, "name") || `Лист ${sheets.length + 1}`;
    const rid = attr(tag, "r:id");
    if (attr(tag, "state") === "hidden" || !rid || !wbRels[rid]) continue;
    const path = join("xl/workbook.xml", wbRels[rid]);
    const xml = read(path);
    if (!xml) continue;
    const sheetRels = rels(read(relsPath(path)));
    const rows: Cell[][] = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = ` ${c[1]}`;
      const ref = attr(attrs, "r")?.match(/^([A-Z]+)(\d+)$/);
      if (!ref) continue;
      const r = Number(ref[2]) - 1,
        col = colIndex(ref[1]);
      const inner = c[2] || "",
        type = attr(attrs, "t");
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = texts(inner);
      else if (v !== undefined) value = decode(v);
      const formula = decode(
        inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1] || "",
      );
      const imageUrl = formula.match(/\bIMAGE\(\s*"([^"]+)"/i)?.[1];
      const formulaLink = formula.match(/\bHYPERLINK\(\s*"([^"]+)"/i)?.[1];
      const fill = fills[xfFills[Number(attr(attrs, "s") || 0)] ?? 0];
      if (!value && !imageUrl && !formulaLink && !fill) continue;
      const cell: Cell = { value: value.trim() };
      if (imageUrl) cell.imageUrl = imageUrl;
      if (formulaLink) cell.link = formulaLink;
      if (fill && fill !== "FFFFFF") cell.fill = fill;
      (rows[r] ||= [])[col] = cell;
    }
    for (const h of xml.match(/<hyperlink\b[^>]*>/g) || []) {
      const ref = attr(h, "ref")?.match(/^([A-Z]+)(\d+)/);
      const target = sheetRels[attr(h, "r:id") || ""];
      if (!ref || !target) continue;
      const r = Number(ref[2]) - 1,
        col = colIndex(ref[1]);
      ((rows[r] ||= [])[col] ||= { value: "" }).link = target;
    }
    const images = new Map<string, SheetImage>();
    const drawingRid = xml.match(/<drawing\b[^>]*r:id="([^"]+)"/)?.[1];
    if (drawingRid && sheetRels[drawingRid]) {
      const dPath = join(path, sheetRels[drawingRid]);
      const dXml = read(dPath) || "";
      const dRels = rels(read(relsPath(dPath)));
      for (const a of dXml.matchAll(
        /<xdr:(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g,
      )) {
        const col = a[0].match(
          /<xdr:from>[\s\S]*?<xdr:col>(\d+)<\/xdr:col>/,
        )?.[1];
        const row = a[0].match(
          /<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/,
        )?.[1];
        const embed = a[0].match(/r:embed="([^"]+)"/)?.[1];
        if (col === undefined || row === undefined || !embed || !dRels[embed])
          continue;
        const media = join(dPath, dRels[embed]);
        const type = IMAGE_TYPES[media.split(".").pop()!.toLowerCase()];
        const key = `${row},${col}`;
        if (type && !images.has(key)) images.set(key, { path: media, type });
      }
    }
    for (let i = 0; i < rows.length; i++) rows[i] ||= [];
    sheets.push({ name, rows, images });
  }
  return {
    sheets,
    image(p) {
      return unzipSync(data, { filter: (f) => f.name === p })[p] || null;
    },
  };
}
