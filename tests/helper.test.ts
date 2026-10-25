import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  claimJob,
  cleanupHelperJobs,
  helperRoute,
  homeHelper,
  type HelperTiming,
} from "../worker/helper";
import { ApiError } from "../worker/security";
import { dns } from "../worker/shops/dns";
import { findShop, lookupProduct } from "../worker/shops";
import { productLink } from "../worker/shops/link";
import { ozon } from "../worker/shops/ozon";
import type { ShopContext } from "../worker/shops/types";

// A minimal D1 stand-in on SQLite, enough for the helper queue.
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0006_home_helper.sql", "utf8"));
  const prepare = (sql: string) => {
    const make = (args: unknown[]) => ({
      async first<T>() {
        return (sqlite.prepare(sql).all(...(args as never[]))[0] as T) ?? null;
      },
      async all<T>() {
        return {
          results: sqlite.prepare(sql).all(...(args as never[])) as T[],
        };
      },
      async run() {
        sqlite.prepare(sql).all(...(args as never[]));
        return { success: true };
      },
    });
    return { ...make([]), bind: (...args: unknown[]) => make(args) };
  };
  return {
    db: { prepare } as unknown as D1Database,
    sqlite,
  };
}

const fast: HelperTiming = {
  waitMs: 3000,
  pollMs: 20,
  holdMs: 400,
  claimMs: 20,
};
const SECRET = "test-helper-secret-0123456789abcdef";
const req = (path: string, body?: unknown, secret = SECRET) =>
  new Request(`https://api.example${path}`, {
    method: path.endsWith("status") ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body:
      body === undefined || path.endsWith("status")
        ? undefined
        : JSON.stringify(body),
  });

async function rejects(p: Promise<unknown>, status: number) {
  await assert.rejects(
    p,
    (e: unknown) => e instanceof ApiError && e.status === status,
  );
}

test("helper endpoints are hidden without a secret and need the right key", async () => {
  const { db } = fakeD1();
  await rejects(helperRoute(req("/api/helper/next"), db, undefined, fast), 404);
  await rejects(
    helperRoute(req("/api/helper/next", {}, "wrong-key"), db, SECRET, fast),
    401,
  );
  const empty = (await helperRoute(
    req("/api/helper/next", {}),
    db,
    SECRET,
    fast,
  )) as {
    job: unknown;
  };
  assert.equal(empty.job, null);
  // Polling marks the helper as online.
  assert.deepEqual(
    await helperRoute(req("/api/helper/status"), db, SECRET, fast),
    {
      online: true,
    },
  );
});

test("offline helper: no job is queued and the lookup is told why", async () => {
  const { db, sqlite } = fakeD1();
  const helper = homeHelper(db, fast);
  const started = Date.now();
  assert.equal(
    await helper.page(new URL("https://www.ozon.ru/product/1/")),
    null,
  );
  assert.ok(Date.now() - started < 500);
  assert.equal(helper.status(), "offline");
  assert.equal(
    (
      sqlite.prepare("SELECT COUNT(*) AS n FROM helper_jobs").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

// Condensed page in the format the helper program sends for Ozon.
const ozonHtml = `<html><head>
<title>Столик журнальный круглый — купить на OZON</title>
<meta property="og:image" content="https://ir.ozone.ru/s3/multimedia-1-x/wc1000/7000000001.jpg">
<div id="state-webProductHeading-3385933-default-1" data-state='{"title":"Столик журнальный круглый металлический Sheffilton, сo\\u0027 стеклом"}'></div>
<div id="state-webPrice-3121879-default-1" data-state='{"isAvailable":true,"price":"7 490 ₽","originalPrice":"12 990 ₽"}'></div>
<div id="state-webGallery-3311629-default-1" data-state='{"coverImage":"https://ir.ozone.ru/s3/multimedia-1-x/wc1000/7000000001.jpg"}'></div>
</head><body></body></html>`;

/** Plays the helper program: takes the next job and answers it. */
async function answerOne(
  db: D1Database,
  answer: (job: { id: string; kind: string; url: string }) => unknown,
) {
  for (let i = 0; i < 50; i++) {
    const r = (await helperRoute(
      req("/api/helper/next", {}),
      db,
      SECRET,
      fast,
    )) as {
      job: { id: string; kind: string; url: string } | null;
    };
    if (r.job) {
      await helperRoute(
        req("/api/helper/result", {
          id: r.job.id,
          ...(answer(r.job) as object),
        }),
        db,
        SECRET,
        fast,
      );
      return r.job;
    }
  }
  throw new Error("no job");
}

test("Ozon lookup goes through the helper and parses title, price and photo", async () => {
  const { db, sqlite } = fakeD1();
  await helperRoute(req("/api/helper/next", {}), db, SECRET, fast); // helper is polling
  const helper = homeHelper(db, fast);
  const ctx: ShopContext = {
    async page(url) {
      const p = await helper.page(url);
      if (!p) throw new Error("direct fetch is blocked");
      return p;
    },
    async json() {
      throw new Error("HTTP 403");
    },
    helperStatus: () => helper.status(),
  };
  const [result, job] = await Promise.all([
    lookupProduct(
      "https://www.ozon.ru/product/stolik-zhurnalnyy-kruglyy-1588518859/?at=abc&sh=x",
      ctx,
    ),
    answerOne(db, (j) => ({ status: 200, url: j.url, body: ozonHtml })),
  ]);
  assert.equal(job.kind, "page");
  assert.equal(result.shop, "Ozon");
  assert.match(
    result.title,
    /^Столик журнальный круглый металлический Sheffilton, сo' стеклом/,
  );
  assert.deepEqual(result.price, {
    min_minor: 749000,
    max_minor: null,
    currency: "RUB",
  });
  assert.equal(
    result.image_url,
    "https://ir.ozone.ru/s3/multimedia-1-x/wc1000/7000000001.jpg",
  );
  assert.equal(result.blocked, false);
  assert.equal(result.helper_offline, false);
  // The job row is removed as soon as the lookup has its answer.
  assert.equal(
    (
      sqlite.prepare("SELECT COUNT(*) AS n FROM helper_jobs").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test("a page the helper could not get through stays blocked", async () => {
  const { db } = fakeD1();
  await helperRoute(req("/api/helper/next", {}), db, SECRET, fast);
  const helper = homeHelper(db, fast);
  const challenge = `<html><head><title>Antibot Captcha</title></head></html>`;
  const [page] = await Promise.all([
    helper.page(new URL("https://www.ozon.ru/product/1588518859/")),
    answerOne(db, (j) => ({ status: 403, url: j.url, body: challenge })),
  ]);
  const info = await ozon.parse(
    new URL("https://www.ozon.ru/product/1588518859/"),
    {
      page: async () => page!,
      json: async () => {
        throw new Error("HTTP 403");
      },
    },
  );
  assert.equal(info.blocked, true);
  assert.equal(info.title, undefined);
});

test("helper errors and timeouts fall back without hanging", async () => {
  const { db } = fakeD1();
  await helperRoute(req("/api/helper/next", {}), db, SECRET, fast);
  const helper = homeHelper(db, fast);
  const [failed] = await Promise.all([
    helper.page(new URL("https://www.dns-shop.ru/product/0bcabdaf10297734/x/")),
    answerOne(db, () => ({ error: "Магазин перенаправил на другой сайт." })),
  ]);
  assert.equal(failed, null);
  // Nobody answers: the wait ends after waitMs.
  const slow = homeHelper(db, { ...fast, waitMs: 200 });
  const started = Date.now();
  assert.equal(
    await slow.page(new URL("https://www.ozon.ru/product/2/")),
    null,
  );
  assert.ok(Date.now() - started < 1500);
});

test("results are validated: foreign final URLs dropped, stale jobs not claimed", async () => {
  const { db, sqlite } = fakeD1();
  await helperRoute(req("/api/helper/next", {}), db, SECRET, fast);
  const helper = homeHelper(db, fast);
  const [page] = await Promise.all([
    helper.page(new URL("https://www.ozon.ru/product/3/")),
    answerOne(db, () => ({
      status: 200,
      url: "https://evil.example/x",
      body: "<html></html>",
    })),
  ]);
  assert.equal(page?.url.href, "https://www.ozon.ru/product/3/");
  await rejects(
    helperRoute(
      req("/api/helper/result", { id: "not-a-job" }),
      db,
      SECRET,
      fast,
    ),
    400,
  );
  await rejects(
    helperRoute(
      req("/api/helper/result", {
        id: "a".repeat(22),
        body: "x".repeat(1_500_001),
      }),
      db,
      SECRET,
      fast,
    ),
    413,
  );
  const old = Math.floor(Date.now() / 1000) - 7200;
  sqlite
    .prepare(
      "INSERT INTO helper_jobs(id,kind,url,status,created_at) VALUES('b','page','https://www.ozon.ru/','queued',?)",
    )
    .run(old);
  assert.equal(await claimJob(db), null);
  await cleanupHelperJobs(db).run();
  assert.equal(
    (
      sqlite.prepare("SELECT COUNT(*) AS n FROM helper_jobs").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test("images come back as bytes through the helper", async () => {
  const { db } = fakeD1();
  await helperRoute(req("/api/helper/next", {}), db, SECRET, fast);
  const helper = homeHelper(db, fast);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const url = new URL("https://c.dns-shop.ru/thumb/st1/fit/300/300/a/b.png");
  assert.equal(helper.handlesImage(url), true);
  assert.equal(
    helper.handlesImage(new URL("https://example.com/a.png")),
    false,
  );
  const [img] = await Promise.all([
    helper.image(url),
    answerOne(db, (j) => ({
      status: 200,
      url: j.url,
      type: "image/png",
      body: png.toString("base64"),
    })),
  ]);
  assert.deepEqual([...img!.bytes], [...png]);
  assert.equal(img!.type, "image/png");
});

test("DNS: links are cleaned and schema.org data is read", async () => {
  const link = productLink(
    new URL(
      "https://www.dns-shop.ru/product/0bcabdaf10297734/142-noutbuk-apple-macbook-pro-m5-max-cernyj/?utm_source=x",
    ),
  );
  assert.equal(
    link.href,
    "https://www.dns-shop.ru/product/0bcabdaf10297734/142-noutbuk-apple-macbook-pro-m5-max-cernyj/",
  );
  assert.equal(findShop(link).id, "dns");
  const html = `<html><head><title>Купить 14.2" Ноутбук Apple MacBook Pro M5 Max черный в интернет-магазине DNS</title>
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"14.2\\" Ноутбук Apple MacBook Pro M5 Max черный","offers":{"@type":"Offer","availability":"https://schema.org/InStock","price":410999,"priceCurrency":"RUB"},"image":["https://c.dns-shop.ru/thumb/st1/fit/300/300/2147/5ab9.png"]}</script>
</head></html>`;
  const info = await dns.parse(link, {
    page: async (url) => ({ url, status: 200, html }),
    json: async () => {
      throw new Error("unused");
    },
  });
  assert.equal(info.title, '14.2" Ноутбук Apple MacBook Pro M5 Max черный');
  assert.deepEqual(info.price, { min: 41099900, max: null, currency: "RUB" });
  assert.equal(
    info.image,
    "https://c.dns-shop.ru/thumb/st1/fit/300/300/2147/5ab9.png",
  );
  // Without the helper DNS answers 401 (Qrator) and the lookup reports a block.
  const blocked = await dns.parse(link, {
    page: async (url) => ({ url, status: 401, html: "<html></html>" }),
    json: async () => {
      throw new Error("unused");
    },
  });
  assert.equal(blocked.blocked, true);
});
