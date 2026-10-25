import type { Sheet } from "./xlsx";
/** RFC 4180 CSV with "," or ";" (Excel in Russian locales uses ";"). */
export function readCsv(text: string, name = "CSV"): Sheet {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delimiter =
    (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length
      ? ";"
      : (firstLine.match(/\t/g) || []).length > 0 && !firstLine.includes(",")
        ? "\t"
        : ",";
  const rows: string[][] = [[]];
  let field = "",
    quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && !field) quoted = true;
    else if (ch === delimiter) {
      rows[rows.length - 1].push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      rows[rows.length - 1].push(field);
      field = "";
      rows.push([]);
    } else field += ch;
  }
  rows[rows.length - 1].push(field);
  return {
    name,
    rows: rows
      .filter((r, i) => i < rows.length - 1 || r.some((v) => v))
      .map((r) => r.map((value) => ({ value: value.trim() }))),
    images: new Map(),
  };
}
