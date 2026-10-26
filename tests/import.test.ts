import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { formatPrice, parseAmount, parsePriceText } from "../shared/price";
import { readCsv } from "../src/import/csv";
import {
  normalizeSheet,
  rowPayload,
  unwrapLink,
} from "../src/import/normalize";
import { readXlsx } from "../src/import/xlsx";
test("price cells as people type them", () => {
  const cases: [string, number | null, number | null, boolean, boolean][] = [
    // text, min, max, range, exact
    ["3000.0", 300000, null, false, true],
    ["2 000", 200000, null, false, true],
    ["6 000-40 000", 600000, 4000000, true, true],
    ["8 000 – 15 000 ₽", 800000, 1500000, true, true],
    ["от 1000", 100000, null, true, true],
    ["до 500 руб.", null, 50000, true, true],
    ["1 299,50", 129950, null, false, true],
    ["800/шт (4 800)", 480000, null, false, false],
    ["2500+800 печать", 330000, null, false, false],
    ["Комплектом       45 000", 4500000, null, false, false],
    ["", null, null, false, true],
    ["#N/A", null, null, false, true],
    ["не знаю", null, null, false, false],
  ];
  for (const [text, min, max, range, exact] of cases) {
    const p = parsePriceText(text);
    assert.deepEqual(
      [p.min, p.max, p.range, p.exact],
      [min, max, range, exact],
      text,
    );
    if (!exact) assert.equal(p.note, text.trim());
  }
  assert.equal(parsePriceText("$12.30").currency, "USD");
  assert.equal(parsePriceText("2500 руб").currency, "RUB");
  assert.equal(parsePriceText("10 бел. руб").currency, "BYN");
  assert.equal(parseAmount("1,299"), 129900);
  assert.equal(parseAmount("1.299,90"), 129990);
});
test("price display: exact, range, from, to", () => {
  const f = (min: number | null, max: number | null, range = 0) =>
    formatPrice({
      price_minor: min,
      price_max_minor: max,
      price_range: range,
      currency: "RUB",
    }).replace(/\s/g, " ");
  assert.match(f(600000, 4000000, 1), /^6 000 ₽ – 40 000 ₽$/);
  assert.match(f(100000, null, 1), /^от 1 000 ₽$/);
  assert.match(f(null, 50000, 1), /^до 500 ₽$/);
  assert.match(f(2599, null), /^25,99 ₽$/);
  assert.equal(f(null, null), "Цена не указана");
});
// A small workbook in the same shape as the family spreadsheet.
function workbook() {
  const shared = [
    "Подарок",
    "Картинка",
    "Кому",
    "Цена",
    "Приоритет",
    "Ссылка",
    "Приоритет:",
    "низкий",
    "высокий (больше хочется)",
    "купили",
    "Халаты",
    "всем",
    "2500+800 печать",
    "https://tipoprint.ru/halat",
    "Биокамин",
    "6 000-40 000",
    "https://woodkamin.ru/",
    "Рубашка",
    "Настольная игра",
    "Билеты в театр",
    "от 1000",
    "Книги",
    "Интерфейс. Купер",
    "Живая типографика",
    "Орхидея",
  ];
  const s = (i: number) => `<c r="REF" t="s"><v>${i}</v></c>`;
  const cell = (ref: string, xml: string) => xml.replace("REF", ref);
  const styled = (ref: string, i: number, style: number) =>
    `<c r="${ref}" s="${style}" t="s"><v>${i}</v></c>`;
  const rows = [
    `<row r="1">${["A", "B", "C", "D", "E", "F"].map((c, i) => cell(`${c}1`, s(i))).join("")}</row>`,
    `<row r="2">${cell("A2", s(10))}${cell("C2", s(11))}${cell("D2", s(12))}${cell("F2", s(13))}${cell("I2", s(6))}</row>`,
    `<row r="3">${cell("A3", s(14))}${cell("D3", s(15))}<c r="E3" s="3"/>${cell("F3", s(16))}<c r="G3" t="inlineStr"><is><t>https://www.ozon.ru/product/biokamin-1/</t></is></c><c r="I3" s="1"/>${cell("J3", s(7))}</row>`,
    `<row r="4">${cell("A4", s(17))}${cell("E4", s(9))}<c r="I4" s="2"/></row>`,
    `<row r="5">${styled("A5", 18, 0)}<c r="E5" s="2"/><c r="I5" s="3"/>${cell("J5", s(8))}</row>`,
    `<row r="6">${cell("A6", s(19))}${cell("D6", s(20))}<c r="E6" s="1"/><c r="I6" s="4"/>${cell("J6", s(9))}</row>`,
    `<row r="7">${cell("A7", s(21))}${cell("F7", s(22))}${cell("G7", s(23))}</row>`,
    `<row r="8">${cell("A8", s(24))}<c r="B8"><f>IMAGE("https://cdn.example/orchid.jpg")</f><v></v></c></row>`,
    `<row r="9"><c r="D9"><f>IFERROR(1/0)</f><v>#N/A</v></c></row>`,
  ];
  const sheet = `<worksheet xmlns:r="r"><sheetData>${rows.join("")}</sheetData>
    <hyperlinks><hyperlink ref="F2" r:id="rId1"/><hyperlink ref="A6" r:id="rId2"/></hyperlinks><drawing r:id="rId3"/></worksheet>`;
  const fills = ["", "", "FF00FF00", "FFFFFF00", "FFFF0000", "FFCCCCCC"]
    .map((c) =>
      c
        ? `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/></patternFill></fill>`
        : `<fill><patternFill patternType="none"/></fill>`,
    )
    .join("");
  // style index → fill id: 0 none, 1 green, 2 yellow, 3 red, 4 grey
  const xfs = [0, 2, 3, 4, 5].map((f) => `<xf fillId="${f}"/>`).join("");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  return zipSync({
    "xl/workbook.xml": strToU8(
      `<workbook xmlns:r="r"><sheets><sheet name="Мама" sheetId="1" r:id="rId1"/><sheet name="Скрытый" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(
      `<sst>${shared.map((t) => `<si><t>${t.replace(/&/g, "&amp;")}</t></si>`).join("")}</sst>`,
    ),
    "xl/styles.xml": strToU8(
      `<styleSheet><fills>${fills}</fills><cellXfs>${xfs}</cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/worksheets/sheet2.xml": strToU8(`<worksheet><sheetData/></worksheet>`),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Target="https://clck.yandex.ru/redir/abc"/><Relationship Id="rId2" Target="https://www.google.com/url?q=https://theatre.example/tickets"/><Relationship Id="rId3" Target="../drawings/drawing1.xml"/></Relationships>`,
    ),
    "xl/drawings/drawing1.xml": strToU8(
      `<xdr:wsDr><xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>`,
    ),
    "xl/drawings/_rels/drawing1.xml.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>`,
    ),
    "xl/media/image1.png": png,
  });
}
test("xlsx: values, links, fills, IMAGE() and anchored pictures", () => {
  const wb = readXlsx(workbook());
  assert.deepEqual(
    wb.sheets.map((s) => s.name),
    ["Мама"],
  );
  const sheet = wb.sheets[0];
  assert.equal(sheet.rows[1][0].value, "Халаты");
  assert.equal(sheet.rows[1][5].link, "https://clck.yandex.ru/redir/abc");
  assert.equal(sheet.rows[2][8].fill, "00FF00");
  assert.equal(sheet.rows[7][1].imageUrl, "https://cdn.example/orchid.jpg");
  assert.deepEqual(sheet.images.get("2,1"), {
    path: "xl/media/image1.png",
    type: "image/png",
  });
  assert.equal(wb.image("xl/media/image1.png")?.[1], 0x50);
  assert.throws(() => readXlsx(zipSync({ "a.txt": strToU8("x") })));
});
test("import: messy rows become editable wishes, nothing is lost", () => {
  const rows = normalizeSheet(readXlsx(workbook()).sheets[0], "RUB");
  const by = (t: string) => rows.find((r) => r.title === t)!;
  assert.deepEqual(
    rows.map((r) => r.title),
    [
      "Халаты",
      "Биокамин",
      "Рубашка",
      "Настольная игра",
      "Билеты в театр",
      "Книги",
      "Орхидея",
    ],
  );
  const halat = by("Халаты");
  assert.equal(halat.priceMin, "3300");
  assert.equal(halat.shopUrl, "https://tipoprint.ru/halat");
  assert.match(halat.description, /Кому: всем/);
  assert.match(halat.description, /Цена в таблице: 2500\+800 печать/);
  assert.deepEqual(halat.warnings, ["Проверьте цену"]);
  const kamin = by("Биокамин");
  assert.deepEqual(
    [kamin.priceMode, kamin.priceMin, kamin.priceMax],
    ["range", "6000", "40000"],
  );
  assert.equal(kamin.shopUrl, "https://woodkamin.ru/");
  assert.match(
    kamin.description,
    /Ещё ссылка:\nhttps:\/\/www\.ozon\.ru\/product\/biokamin-1\//,
  );
  assert.equal(kamin.priority, 5); // red, labelled "высокий" in the legend: 5 hearts
  assert.deepEqual(kamin.image, {
    kind: "embedded",
    path: "xl/media/image1.png",
    type: "image/png",
  });
  assert.equal(by("Рубашка").archived, true);
  assert.equal(by("Настольная игра").priority, 3); // yellow: between "низкий" and "высокий"
  const tickets = by("Билеты в театр");
  assert.deepEqual(
    [tickets.priceMode, tickets.priceMin, tickets.priceMax],
    ["range", "1000", ""],
  );
  assert.equal(tickets.shopUrl, "https://theatre.example/tickets");
  assert.equal(tickets.priority, 2); // green = "низкий"
  assert.match(
    by("Книги").description,
    /Ещё:\n— Интерфейс\. Купер\n— Живая типографика/,
  );
  assert.deepEqual(by("Орхидея").image, {
    kind: "url",
    url: "https://cdn.example/orchid.jpg",
  });
  assert.ok(!rows.some((r) => /низкий|высокий/.test(r.description)));
  const payload = rowPayload(kamin);
  assert.deepEqual(
    [payload.price_minor, payload.price_max_minor, payload.price_range],
    [600000, 4000000, true],
  );
  assert.throws(() => rowPayload({ ...kamin, priceMax: "10" }));
});
test("import: long titles are shortened with the full text kept", () => {
  const long = "Набор профессиональных сменных круговых спиц ".repeat(5);
  const [row] = normalizeSheet(
    {
      name: "Настя",
      rows: [[{ value: "Подарок" }], [{ value: long }]],
      images: new Map(),
    },
    "RUB",
  );
  assert.ok(row.title.length <= 120);
  assert.ok(row.title.endsWith("…"));
  assert.ok(row.description.includes(long.trim()));
  assert.deepEqual(row.warnings, ["Название сокращено"]);
});
test("CSV import with semicolons, quotes and a header", () => {
  const sheet = readCsv(
    '﻿Подарок;Цена;Ссылка\n"Кружка ""Утро""";1 500;https://shop.example/1\nПлед;от 3000;\n',
    "list.csv",
  );
  const rows = normalizeSheet(sheet, "EUR");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Кружка "Утро"');
  assert.equal(rows[0].priceMin, "1500");
  assert.equal(rows[0].currency, "EUR");
  assert.equal(rows[1].priceMode, "range");
});
test("tracking wrappers are unwrapped or dropped", () => {
  assert.equal(
    unwrapLink("https://www.google.com/url?q=https://a.example/x"),
    "https://a.example/x",
  );
  assert.equal(
    unwrapLink("https://vk.com/away.php?to=https%3A%2F%2Fb.example"),
    "https://b.example",
  );
  assert.equal(unwrapLink("https://clck.yandex.ru/redir/xyz"), null);
  assert.equal(unwrapLink("https://shop.example/"), "https://shop.example/");
});

test("import: tables of any layout — no header, other header words, columns in any order", () => {
  const titles = (csv: string) =>
    normalizeSheet(readCsv(csv, "list.csv"), "RUB").map((r) => ({
      title: r.title,
      price: r.priceMin,
      url: r.shopUrl,
      note: r.description,
    }));
  // No header at all: link first, then the name, then the price.
  assert.deepEqual(
    titles(
      "https://www.ozon.ru/product/1/;Наушники Sony WH-1000XM5;24 990 ₽\nhttps://shop.example/2;Плед шерстяной;3000\n",
    ),
    [
      {
        title: "Наушники Sony WH-1000XM5",
        price: "24990",
        url: "https://www.ozon.ru/product/1/",
        note: "",
      },
      {
        title: "Плед шерстяной",
        price: "3000",
        url: "https://shop.example/2",
        note: "",
      },
    ],
  );
  // Row numbers, a header the importer half-knows, a price column named oddly.
  assert.deepEqual(
    titles(
      "№;Хотелка;Размер;Сколько стоит;Где\n1;Кроссовки;38;5 990 руб;https://shop.example/a\n2;Шапка;M;1200 ₽;\n",
    ),
    [
      {
        title: "Кроссовки",
        price: "5990",
        url: "https://shop.example/a",
        note: "Размер: 38",
      },
      { title: "Шапка", price: "1200", url: "", note: "Размер: M" },
    ],
  );
  // English headers and a header that is not on the first line.
  assert.deepEqual(
    titles(
      "Мой список на Новый год;;\n;;\nItem;Price;Link\nLEGO Technic;7 500;https://shop.example/l\n",
    ),
    [
      {
        title: "LEGO Technic",
        price: "7500",
        url: "https://shop.example/l",
        note: "",
      },
    ],
  );
  // A long first data line is never taken for a header.
  assert.equal(
    titles("Подарок для мамы на юбилей;2000 ₽\nКнига;500 ₽\n")[0].title,
    "Подарок для мамы на юбилей",
  );
});
