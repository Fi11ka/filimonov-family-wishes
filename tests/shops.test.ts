import { test } from "node:test";
import assert from "node:assert/strict";
import { findShop, lookupProduct, shops } from "../worker/shops";
import type { Page, ShopContext } from "../worker/shops/types";
import { wbImage, wbPrice } from "../worker/shops/wildberries";
import { publicHttpsUrl } from "../worker/net";
import { productLink } from "../worker/shops/link";
// Shops change markup often and block datacenter IPs, so these tests pin the
// parsing logic on small synthetic pages in each shop's format.
function ctx(
  pages: Record<string, Partial<Page> & { json?: unknown }>,
): ShopContext {
  const find = (url: URL) => {
    const hit = Object.entries(pages).find(([prefix]) =>
      url.href.startsWith(prefix),
    );
    if (!hit) throw new Error(`unexpected fetch ${url.href}`);
    return hit[1];
  };
  return {
    async page(url) {
      const p = find(url);
      return { url: p.url || url, status: p.status ?? 200, html: p.html ?? "" };
    },
    async json(url) {
      const p = find(url);
      if (p.json === undefined) throw new Error("HTTP 403");
      return p.json;
    },
  };
}
test("every shop module is found by its links", () => {
  const cases: [string, string][] = [
    ["https://www.wildberries.ru/catalog/7840205/detail.aspx", "wildberries"],
    ["https://www.ozon.ru/product/x-1777610454/", "ozon"],
    ["https://ozon.ru/t/4e69EZX", "ozon"],
    [
      "https://market.yandex.ru/product--osmo-pocket-3/18925911",
      "yandex-market",
    ],
    ["https://www.amazon.com/dp/B0BDHWDR12", "amazon"],
    ["https://www.amazon.de/dp/B0BDHWDR12", "amazon"],
    ["https://aliexpress.ru/item/1005007935983752.html", "aliexpress-ru"],
    ["https://sl.aliexpress.ru/p?key=hU2AV3e", "aliexpress-ru"],
    ["https://www.aliexpress.com/item/1005007935983752.html", "aliexpress-com"],
    ["https://www.dns-shop.ru/product/1/", "generic"],
    ["https://notozon.ru/product/1", "generic"],
  ];
  for (const [url, id] of cases)
    assert.equal(findShop(new URL(url)).id, id, url);
  assert.equal(new Set(shops.map((s) => s.id)).size, shops.length);
});
test("Wildberries: card API price in kopecks, sharded image host", async () => {
  assert.deepEqual(
    wbPrice({
      sizes: [
        { price: { basic: 500000, product: 299000 } },
        { price: { product: 349000 } },
      ],
    }),
    { min: 299000, max: 349000, currency: "RUB" },
  );
  assert.deepEqual(wbPrice({ salePriceU: 120000 }), {
    min: 120000,
    max: null,
    currency: "RUB",
  });
  assert.match(
    wbImage(7840205),
    /^https:\/\/basket-01\.wbbasket\.ru\/vol78\/part7840\/7840205\/images\/big\/1\.webp$/,
  );
  assert.match(
    wbImage(458490031),
    /^https:\/\/basket-26\.wbbasket\.ru\/vol4584\//,
  );
  const r = await lookupProduct(
    "https://www.wildberries.ru/catalog/7840205/detail.aspx?targetUrl=EX",
    ctx({
      "https://card.wb.ru/cards/v4/": {
        json: {
          products: [
            {
              brand: "Brand",
              name: "Халат",
              sizes: [{ price: { product: 300000 } }],
            },
          ],
        },
      },
    }),
  );
  assert.equal(r.shop, "Wildberries");
  assert.equal(r.title, "Brand Халат");
  assert.deepEqual(r.price, {
    min_minor: 300000,
    max_minor: null,
    currency: "RUB",
  });
  assert.ok(r.image_url.includes("7840205"));
  // API blocked: still offers the photo, no price, user types it in.
  const blocked = await lookupProduct(
    "https://www.wildberries.ru/catalog/7840205/detail.aspx",
    ctx({}),
  );
  assert.equal(blocked.price, null);
  assert.ok(blocked.image_url);
});
test("Ozon: widget states on the page, composer API fallback for short links", async () => {
  const state = JSON.stringify({
    price: "1 299 ₽",
    cardPrice: "1 199 ₽",
  }).replace(/"/g, "&quot;");
  const page = `<html><head><meta property="og:title" content="Гель для волос"><meta property="og:image" content="https://cdn1.ozone.ru/s3/p.jpg"></head>
    <div id="state-webPrice-123-default-1" data-state='${state}'></div></html>`;
  const r = await lookupProduct(
    "https://www.ozon.ru/product/gel-1777610454/",
    ctx({ "https://www.ozon.ru/product/": { html: page } }),
  );
  assert.equal(r.title, "Гель для волос");
  assert.deepEqual(r.price, {
    min_minor: 129900,
    max_minor: null,
    currency: "RUB",
  });
  assert.equal(r.image_url, "https://cdn1.ozone.ru/s3/p.jpg");
  const short = await lookupProduct(
    "https://ozon.ru/t/4e69EZX",
    ctx({
      "https://ozon.ru/t/": {
        url: new URL("https://www.ozon.ru/product/otvertki-123/"),
        status: 403,
        html: "<html>Доступ ограничен</html>",
      },
      "https://www.ozon.ru/api/": {
        json: {
          widgetStates: {
            "webPrice-1": JSON.stringify({ price: "500 ₽" }),
            "webProductHeading-2": JSON.stringify({ title: "Набор отверток" }),
            "webGallery-3": JSON.stringify({
              coverImage: "https://cdn1.ozone.ru/c.jpg",
            }),
          },
        },
      },
    }),
  );
  assert.equal(short.title, "Набор отверток");
  assert.equal(short.price?.min_minor, 50000);
  assert.equal(short.blocked, false);
});
test("Yandex Market: JSON-LD AggregateOffer becomes a range", async () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"DJI Osmo Pocket 3","image":["https://avatars.mds.yandex.net/a.jpg"],"offers":{"@type":"AggregateOffer","lowPrice":"49990","highPrice":"56990","priceCurrency":"RUR"}}</script>`;
  const r = await lookupProduct(
    "https://market.yandex.ru/product--osmo-pocket-3/18925911",
    ctx({ "https://market.yandex.ru/": { html } }),
  );
  assert.equal(r.title, "DJI Osmo Pocket 3");
  assert.deepEqual(r.price, {
    min_minor: 4999000,
    max_minor: 5699000,
    currency: "RUB",
  });
  assert.equal(r.image_url, "https://avatars.mds.yandex.net/a.jpg");
});
test("Amazon: buy-box price, hi-res image, currency by domain", async () => {
  const html = `<span id="productTitle" class="a-size-large">  Apple AirPods Pro (2nd Gen)  </span>
    <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$249.00</span></span></div>
    <div id="similar"><span class="a-offscreen">$9.99</span></div>
    <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/61f1YfTkTDL._AC_SL1500_.jpg">`;
  const r = await lookupProduct(
    "https://www.amazon.com/dp/B0BDHWDR12",
    ctx({ "https://www.amazon.com/": { html } }),
  );
  assert.equal(r.title, "Apple AirPods Pro (2nd Gen)");
  assert.deepEqual(r.price, {
    min_minor: 24900,
    max_minor: null,
    currency: "USD",
  });
  assert.match(r.image_url, /61f1YfTkTDL/);
  const de = await lookupProduct(
    "https://www.amazon.de/dp/B0BDHWDR12",
    ctx({
      "https://www.amazon.de/": {
        html: `<div id="corePrice_feature_div"><span class="a-offscreen">249,00&nbsp;€</span></div>`,
      },
    }),
  );
  assert.deepEqual(de.price, {
    min_minor: 24900,
    max_minor: null,
    currency: "EUR",
  });
});
test("AliExpress .com and .ru: embedded amount objects", async () => {
  const com = await lookupProduct(
    "https://www.aliexpress.com/item/1005007935983752.html",
    ctx({
      "https://www.aliexpress.com/": {
        html: `<meta property="og:title" content="Car air pump"><script>window.runParams={"priceComponent":{"discountPrice":{"minActivityAmount":{"currency":"USD","formatedAmount":"US $23.10","value":23.1},"maxActivityAmount":{"currency":"USD","value":31.5}}},"imagePathList":["https://ae01.alicdn.com/kf/S1.jpg"]}</script>`,
      },
    }),
  );
  assert.deepEqual(com.price, {
    min_minor: 2310,
    max_minor: 3150,
    currency: "USD",
  });
  assert.equal(com.image_url, "https://ae01.alicdn.com/kf/S1.jpg");
  assert.equal(com.shop, "AliExpress");
  const ru = await lookupProduct(
    "https://aliexpress.ru/item/1005007935983752.html",
    ctx({
      "https://aliexpress.ru/": {
        html: `<meta property="og:image" content="//ae04.alicdn.com/kf/R.jpg"><script>{"price":{"value":2600,"currency":"RUB"}}</script>`,
      },
    }),
  );
  assert.deepEqual(ru.price, {
    min_minor: 260000,
    max_minor: null,
    currency: "RUB",
  });
  assert.equal(ru.image_url, "https://ae04.alicdn.com/kf/R.jpg");
  assert.equal(ru.shop, "AliExpress Россия");
  // Anti-bot stub: nothing found, reported as blocked so the form asks for manual input.
  const stub = await lookupProduct(
    "https://aliexpress.ru/item/1.html",
    ctx({
      "https://aliexpress.ru/": {
        html: `<script>var url = "//aliexpress.ru//item/1.html/_____tmd_____/punish?x5secdata=abc"</script>`,
      },
    }),
  );
  assert.equal(stub.blocked, true);
  assert.equal(stub.price, null);
});
test("generic sites: schema.org Product, then Open Graph", async () => {
  const r = await lookupProduct(
    "https://shop.example/item",
    ctx({
      "https://shop.example/": {
        html: `<title>Shop</title><meta property="og:image" content="/img/p.png">
        <script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Кружка &amp; блюдце","offers":{"@type":"Offer","price":"1 490,50","priceCurrency":"RUB"}}]}</script>`,
      },
    }),
  );
  assert.equal(r.shop, null);
  assert.equal(r.title, "Кружка & блюдце");
  assert.deepEqual(r.price, {
    min_minor: 149050,
    max_minor: null,
    currency: "RUB",
  });
  assert.equal(r.image_url, "https://shop.example/img/p.png");
  const og = await lookupProduct(
    "https://shop.example/og",
    ctx({
      "https://shop.example/": {
        html: `<meta property="og:title" content="Свеча"><meta property="product:price:amount" content="35"><meta property="product:price:currency" content="EUR">`,
      },
    }),
  );
  assert.deepEqual(og.price, {
    min_minor: 3500,
    max_minor: null,
    currency: "EUR",
  });
  // Unsupported currency is not guessed.
  const jpy = await lookupProduct(
    "https://shop.example/jpy",
    ctx({
      "https://shop.example/": {
        html: `<script type="application/ld+json">{"@type":"Product","name":"X","offers":{"price":"1000","priceCurrency":"JPY"}}</script>`,
      },
    }),
  );
  assert.equal(jpy.price, null);
});
test("anti-bot and storefront pages never become a gift title or photo", async () => {
  const challenge = await lookupProduct(
    "https://shop.example/needles",
    ctx({
      "https://shop.example/": {
        status: 403,
        html: `<title>Attention Required! | Cloudflare</title><meta property="og:image" content="https://shop.example/cf.png">`,
      },
    }),
  );
  assert.deepEqual(
    [challenge.title, challenge.image_url, challenge.blocked],
    ["", "", true],
  );
  // Yandex Market sometimes serves its storefront to bots: "Яндекс" + logo.
  const storefront = await lookupProduct(
    "https://market.yandex.ru/product--osmo-pocket-3/18925911",
    ctx({
      "https://market.yandex.ru/": {
        html: `<title>Яндекс</title><meta property="og:image" content="https://yastatic.net/logo.png">${"x".repeat(30000)}`,
      },
    }),
  );
  assert.deepEqual(
    [storefront.title, storefront.image_url, storefront.blocked],
    ["", "", true],
  );
});
test("URL policy rejects internal targets before any request", () => {
  for (const bad of [
    "http://shop.example/",
    "https://10.0.0.1/",
    "https://0x7f.0.0.1/",
    "https://[fd00::1]/",
    "https://router.lan/",
    "https://localhost./",
    "https://a.b@shop.example/",
  ])
    assert.throws(() => publicHttpsUrl(bad), bad);
  assert.equal(
    publicHttpsUrl("https://shop.example/a#frag").href,
    "https://shop.example/a",
  );
});
test("supplied marketplace links keep product/variant identifiers and drop tracking", () => {
  const cases = [
    [
      "https://www.amazon.es/dp/B0C9TP6DD5/ref=asc_df_B0C9TP6DD5?tag=ad&language=pt_PT&psc=1",
      "https://www.amazon.es/dp/B0C9TP6DD5",
    ],
    [
      "https://www.ozon.ru/search/?text=table&product_id=2402035826&from_global=true",
      "https://www.ozon.ru/product/2402035826/",
    ],
    [
      "https://www.wildberries.ru/catalog/212550828/detail.aspx?size=339839029&utm_source=ad",
      "https://www.wildberries.ru/catalog/212550828/detail.aspx?size=339839029",
    ],
    [
      "https://aliexpress.ru/item/1005002333850679.html?spm=ad&sku_id=12000031578956806",
      "https://aliexpress.ru/item/1005002333850679.html?sku_id=12000031578956806",
    ],
    ["https://ozon.ru/t/4e69EZX", "https://ozon.ru/t/4e69EZX"],
    [
      "https://shop.example/item?variant=red",
      "https://shop.example/item?variant=red",
    ],
  ];
  for (const [raw, expected] of cases)
    assert.equal(productLink(new URL(raw)).href, expected);
  assert.throws(() =>
    productLink(new URL("https://www.ozon.ru/search/?text=table")),
  );
  assert.equal(
    productLink(new URL("https://notozon.ru/search/?text=table")).pathname,
    "/search/",
  );
});
test("Amazon.es imports the payable price and main photo, with either attribute order", async () => {
  const r = await lookupProduct(
    "https://www.amazon.es/dp/B0C9TP6DD5/ref=ad?tag=tracking",
    ctx({
      "https://www.amazon.es/dp/B0C9TP6DD5": {
        html: `<img data-old-hires="https://m.media-amazon.com/images/I/accessory.jpg" id="recommendation">
      <span id="productTitle">Набор спиц &amp; аксессуары</span>
      <img src='https://m.media-amazon.com/images/I/main.jpg' id='landingImage'>
      <div id='corePrice_feature_div'><span class='a-price a-text-price'><span class='a-offscreen'>99,00 €</span></span><span class='a-price'><span class='a-offscreen extra'>52,87&nbsp;€</span></span></div>
      <div><span class='a-offscreen'>1,99 €</span></div>`,
      },
    }),
  );
  assert.equal(r.price?.min_minor, 5287);
  assert.equal(r.price?.currency, "EUR");
  assert.equal(r.image_url, "https://m.media-amazon.com/images/I/main.jpg");
  assert.equal(r.title, "Набор спиц & аксессуары");
  assert.equal(r.url, "https://www.amazon.es/dp/B0C9TP6DD5");
  const empty = await lookupProduct(
    "https://www.amazon.es/dp/B0C9TP6DD5",
    ctx({
      "https://www.amazon.es/": {
        html: '<div id="corePrice_feature_div"><div>Unavailable</div></div><div id="recommendations"><span class="a-offscreen">1,99 €</span></div>',
      },
    }),
  );
  assert.equal(empty.price, null);
});
test("Ozon search product_id is looked up as a card, and card-only discounts are not imported", async () => {
  const requested: string[] = [];
  const r = await lookupProduct(
    "https://www.ozon.ru/search/?text=table&product_id=2402035826",
    {
      async page(url) {
        requested.push(url.href);
        return {
          url,
          status: 200,
          html: '<meta property="og:title" content="Столик"><div id="state-webPrice-1" data-state=\'{"price":"1 299 ₽","cardPrice":"1 199 ₽"}\'></div>',
        };
      },
      async json() {
        throw new Error("not expected");
      },
    },
  );
  assert.equal(requested[0], "https://www.ozon.ru/product/2402035826/");
  assert.equal(r.price?.min_minor, 129900);
  const cardOnly = await lookupProduct(
    "https://www.ozon.ru/product/x-2402035826/",
    ctx({
      "https://www.ozon.ru/": {
        html: '<div id="state-webPrice-1" data-state=\'{"cardPrice":"1 199 ₽"}\'></div>',
      },
    }),
  );
  assert.equal(cardOnly.price, null);
});
test("Wildberries prices respect selected size; an unknown variant does not receive another size's price", () => {
  const p = {
    sizes: [
      { chrtId: 339839029, price: { product: 299000 } },
      { chrtId: 339839030, price: { product: 349000 } },
    ],
  };
  assert.deepEqual(wbPrice(p, "339839029"), {
    min: 299000,
    max: null,
    currency: "RUB",
  });
  assert.equal(wbPrice(p, "missing"), null);
  assert.equal(wbPrice({ salePriceU: 123400 }, "339839029"), null);
});

test("WB v4 optionId matches the selected variant; an absent variant gets no borrowed price", () => {
  const p = {
    sizes: [
      { optionId: 339839029, price: { product: 17000 } },
      { optionId: 339839030, price: { product: 25000 } },
    ],
  };
  assert.deepEqual(wbPrice(p, "339839029"), {
    min: 17000,
    max: null,
    currency: "RUB",
  });
  assert.equal(wbPrice(p, "999"), null);
});
test("the real WB 212550828 out-of-stock response supplies a photo, never an invented price", async () => {
  const r = await lookupProduct(
    "https://www.wildberries.ru/catalog/212550828/detail.aspx?size=339839029",
    ctx({
      "https://card.wb.ru/cards/v4/": {
        json: {
          products: [
            {
              id: 212550828,
              brand: "Пехорка",
              name: "Пряжа",
              totalQuantity: 0,
              sizes: [{ optionId: 339839029, stocks: [] }],
            },
          ],
        },
      },
    }),
  );
  assert.equal(r.unavailable, true);
  assert.equal(r.price, null);
  assert.equal(r.title, "Пехорка Пряжа");
  assert.equal(
    r.image_url,
    "https://basket-14.wbbasket.ru/vol2125/part212550/212550828/images/big/1.webp",
  );
});
test("Ozon composer fallback still runs after the HTML request throws", async () => {
  let requested = false;
  const r = await lookupProduct("https://www.ozon.ru/product/2402035826/", {
    async page() {
      throw new Error("network timeout");
    },
    async json() {
      requested = true;
      return {
        widgetStates: {
          "webProductHeading-1": { title: "Приставной столик" },
          "webPrice-1": { price: "2 000 ₽" },
          "webGallery-1": {
            coverImage: "https://ir.ozone.ru/s3/multimedia/photo.jpg",
          },
        },
      };
    },
  });
  assert.equal(requested, true);
  assert.equal(r.title, "Приставной столик");
  assert.equal(r.price?.min_minor, 200000);
  assert.equal(r.blocked, false);
});

test("AliExpress.ru falls back to the SAME international item preview, never its regional price", async () => {
  let fallbackUrl = "";
  const raw =
    "https://aliexpress.ru/item/1005002333850679.html?sku_id=12000031578956806";
  const r = await lookupProduct(raw, {
    async json() {
      throw new Error("unexpected json");
    },
    async page(url) {
      if (url.hostname === "aliexpress.ru")
        return {
          url,
          status: 429,
          html: "Пройдите проверку _____tmd_____/punish",
        };
      fallbackUrl = url.href;
      return {
        url: new URL(
          url.href.replace("www.aliexpress.com", "pt.aliexpress.com"),
        ),
        status: 200,
        html: `<meta property="og:type" content="product"><meta property="og:title" content="Zipper Cable Organizer"><meta property="og:image" content="https://ae-pic-a1.aliexpress-media.com/kf/product.jpg"><meta property="product:price:amount" content="9.99"><meta property="product:price:currency" content="USD">`,
      };
    },
  });
  assert.equal(
    fallbackUrl,
    "https://www.aliexpress.com/item/1005002333850679.html?sku_id=12000031578956806",
  );
  assert.equal(r.url, raw);
  assert.equal(r.title, "Zipper Cable Organizer");
  assert.equal(
    r.image_url,
    "https://ae-pic-a1.aliexpress-media.com/kf/product.jpg",
  );
  assert.equal(r.price, null);
  assert.equal(r.blocked, false);
  assert.equal(r.shop, "AliExpress (международный сайт)");
});
test("AliExpress preview rejects unrelated redirects and another bot page", async () => {
  for (const target of [
    "https://www.aliexpress.com/item/9999999999999.html",
    "https://www.aliexpress.com/",
    "https://aliexpress.com.example.org/item/1005002333850679.html",
    "https://www.aliexpress.com/item/1005002333850679.html",
  ]) {
    const r = await lookupProduct(
      "https://aliexpress.ru/item/1005002333850679.html",
      {
        async json() {
          throw new Error("unexpected json");
        },
        async page(url) {
          if (url.hostname === "aliexpress.ru") throw new Error("timeout");
          return {
            url: new URL(target),
            status: target.endsWith("1005002333850679.html") ? 429 : 200,
            html: `<meta property="og:title" content="Wrong"><meta property="og:image" content="https://example.org/wrong.jpg">`,
          };
        },
      },
    );
    assert.equal(r.title, "");
    assert.equal(r.image_url, "");
    assert.equal(r.price, null);
    assert.equal(r.blocked, true);
  }
});
test("AliExpress.ru uses no fallback when the original card is complete or has no item ID", async () => {
  for (const raw of [
    "https://aliexpress.ru/item/1005002333850679.html",
    "https://sl.aliexpress.ru/p?key=unknown",
  ]) {
    let calls = 0;
    const short = raw.includes("/p?");
    const r = await lookupProduct(raw, {
      async json() {
        throw new Error("unexpected json");
      },
      async page(url) {
        ++calls;
        return {
          url,
          status: short ? 429 : 200,
          html: `<meta property="og:title" content="Оригинальное название"><meta property="og:image" content="https://img.alicdn.com/product.jpg">`,
        };
      },
    });
    assert.equal(calls, 1);
    assert.equal(r.title, short ? "" : "Оригинальное название");
    assert.equal(r.shop, "AliExpress Россия");
  }
});

test("AliExpress preview preserves a price obtained from the original Russian card", async () => {
  const r = await lookupProduct(
    "https://aliexpress.ru/item/1005002333850679.html",
    {
      async json() {
        throw new Error("unexpected json");
      },
      async page(url) {
        return {
          url,
          status: 200,
          html: url.hostname.endsWith(".ru")
            ? `<script>const p={"price":{"value":1234,"currency":"RUB"}}</script>`
            : `<meta property="og:title" content="Organizer"><meta property="og:image" content="https://img.alicdn.com/product.jpg"><meta property="product:price:amount" content="9.99"><meta property="product:price:currency" content="USD">`,
        };
      },
    },
  );
  assert.equal(r.price?.min_minor, 123400);
  assert.equal(r.price?.currency, "RUB");
});
