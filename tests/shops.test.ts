import { test } from "node:test";
import assert from "node:assert/strict";
import { findShop, lookupProduct, shops } from "../worker/shops";
import type { Page, ShopContext } from "../worker/shops/types";
import { wbImage, wbPrice } from "../worker/shops/wildberries";
import { publicHttpsUrl } from "../worker/net";
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
    min_minor: 119900,
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
