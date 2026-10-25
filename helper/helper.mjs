// Домашний помощник Filimonov Family Wishes.
//
// Открывает страницы Ozon, DNS, Яндекс Маркета и AliExpress.ru в обычном Chrome
// на этом компьютере и передаёт приложению название, цену и фото товара.
// Компьютер сам обращается к приложению за заданиями: открывать порты на
// роутере не нужно. Открываются только страницы этих магазинов и их картинки.
//
// Запуск:   node helper.mjs            (окно Chrome скрыто)
//           node helper.mjs --show     (видно окно Chrome: пройти капчу, войти)
//           node helper.mjs --setup    (заново ввести адрес и ключ)
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "helper.config.json");
const PROFILE = join(here, "chrome-profile");
const args = new Set(process.argv.slice(2));
const SHOW = args.has("--show");

const PAGE_HOSTS =
  /(^|\.)(ozon\.(ru|by|kz)|dns-shop\.(ru|kz)|market\.yandex\.(ru|by|kz|uz)|aliexpress\.ru)$/;
const IMAGE_HOSTS =
  /(^|\.)(ozon\.(ru|by|kz)|ozone\.ru|dns-shop\.(ru|kz)|aliexpress\.ru|alicdn\.com|aliexpress-media\.com|avatars\.mds\.yandex\.net)$/;
const CHALLENGE =
  /antibot|captcha|не робот|пройдите проверку|подтвердите, что|похоже, нет соединения|just a moment|attention required|доступ ограничен/i;
const MAX_PAGE_CHARS = 400_000;
const MAX_IMAGE_BYTES = 1_000_000;
const WORKERS = 2;

const log = (...a) =>
  console.log(new Date().toLocaleTimeString("ru-RU"), "—", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG) && !args.has("--setup"))
    cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  if (cfg.api && cfg.token) return cfg;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nНастройка помощника (один раз).");
  cfg.api = (
    await rl.question(
      "Адрес приложения (например https://filimonov-family-wishes-api.xxx.workers.dev): ",
    )
  )
    .trim()
    .replace(/\/$/, "");
  cfg.token = (await rl.question("Ключ помощника: ")).trim();
  rl.close();
  if (!/^https:\/\/[^/]+$/.test(cfg.api) || cfg.token.length < 20) {
    console.error(
      "Адрес должен начинаться с https://, ключ — не короче 20 символов.",
    );
    process.exit(1);
  }
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  console.log("Сохранено в helper.config.json\n");
  return cfg;
}

async function launch() {
  mkdirSync(PROFILE, { recursive: true });
  const options = {
    headless: !SHOW,
    viewport: SHOW ? null : { width: 1366, height: 900 },
    locale: "ru-RU",
  };
  // Обычный установленный Chrome; если его нет — Microsoft Edge.
  for (const channel of ["chrome", "msedge"])
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE, {
        ...options,
        channel,
      });
      log(`Браузер запущен (${channel}${SHOW ? ", окно видно" : ""}).`);
      return ctx;
    } catch (e) {
      if (channel === "msedge") throw e;
    }
}

/**
 * Короткая версия страницы: заголовок, meta-теги, schema.org, состояния
 * виджетов Ozon и скрипты с ценами. Этого хватает парсерам приложения.
 */
async function condensed(page) {
  return page.evaluate(
    async ({ max }) => {
      const parts = [];
      const esc = (s) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const state = (id, json) =>
        `<div id="state-${esc(id)}" data-state='${String(json).replace(/'/g, "\\u0027")}'></div>`;
      parts.push(`<title>${esc(document.title)}</title>`);
      for (const m of document.querySelectorAll(
        "meta[property],meta[name],meta[itemprop]",
      ))
        // Служебные токены сессии браузера в приложение не передаются.
        if (!/csrf|token|nonce|verification/i.test(m.outerHTML.slice(0, 80)))
          parts.push(m.outerHTML);
      for (const l of document.querySelectorAll('link[rel="image_src"]'))
        parts.push(l.outerHTML);
      for (const s of document.querySelectorAll(
        'script[type="application/ld+json"]',
      ))
        parts.push(s.outerHTML);
      let hasOzonPrice = false;
      for (const el of document.querySelectorAll(
        '[id^="state-"][data-state]',
      )) {
        if (!/^state-web(Price|ProductHeading|Gallery)/.test(el.id)) continue;
        if (el.id.startsWith("state-webPrice")) hasOzonPrice = true;
        parts.push(state(el.id.slice(6), el.getAttribute("data-state")));
      }
      // Ozon: те же данные из API сайта, если на странице их не оказалось.
      if (
        /(^|\.)ozon\.(ru|by|kz)$/.test(location.hostname) &&
        location.pathname.startsWith("/product/") &&
        !hasOzonPrice
      )
        try {
          const r = await fetch(
            `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(location.pathname)}`,
            { credentials: "include" },
          );
          const j = await r.json();
          for (const [k, v] of Object.entries(j.widgetStates || {}))
            if (/^web(Price|ProductHeading|Gallery)/.test(k))
              parts.push(
                state(k, typeof v === "string" ? v : JSON.stringify(v)),
              );
        } catch {}
      // Яндекс Маркет и AliExpress держат цену во встроенных скриптах.
      let left = max - parts.join("\n").length - 200;
      for (const s of document.scripts) {
        if (s.type === "application/ld+json" || left <= 0) continue;
        const t = s.textContent || "";
        if (!/"price"|Amount"|imagePathList/.test(t)) continue;
        const cut = t.slice(0, Math.min(t.length, 150_000, left));
        left -= cut.length + 20;
        parts.push(
          `<script>${cut.replace(/<\/script/gi, "<\\/script")}</script>`,
        );
      }
      return `<html><head>\n${parts.join("\n")}\n</head><body></body></html>`;
    },
    { max: MAX_PAGE_CHARS },
  );
}

async function openPage(ctx, url) {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    // Проверка браузера у Ozon/DNS проходит сама за несколько секунд.
    let blocked = true;
    for (let i = 0; i < 24; i++) {
      const title = await page.title().catch(() => "");
      if (
        !CHALLENGE.test(title) &&
        // Ozon keeps ?__rr=N in the address even after the check passes.
        !/showcaptcha|_____tmd_____|\/punish/.test(page.url())
      ) {
        blocked = false;
        break;
      }
      await page.waitForTimeout(500);
    }
    await page.waitForLoadState("load", { timeout: 6000 }).catch(() => {});
    if (blocked)
      log(
        "Магазин просит пройти проверку. Запустите помощника с окном (start --show) и пройдите её один раз.",
      );
    const finalUrl = new URL(page.url());
    if (!PAGE_HOSTS.test(finalUrl.hostname))
      throw new Error("Магазин перенаправил на другой сайт.");
    const html = await condensed(page);
    return {
      // The first response is often the challenge itself; what matters is
      // whether the product page was reached in the end.
      status: blocked
        ? 403
        : res && res.status() >= 400 && res.status() !== 403
          ? res.status()
          : 200,
      url: finalUrl.href,
      body: html.slice(0, MAX_PAGE_CHARS),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchImage(ctx, url) {
  const res = await ctx.request.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
    },
  });
  const finalUrl = new URL(res.url());
  if (!IMAGE_HOSTS.test(finalUrl.hostname))
    throw new Error("Картинка перенаправлена на другой сайт.");
  const bytes = await res.body();
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Картинка слишком большая.");
  return {
    status: res.status(),
    url: finalUrl.href,
    type: res.headers()["content-type"] || "",
    body: bytes.toString("base64"),
  };
}

async function call(cfg, path, payload) {
  const res = await fetch(cfg.api + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(40000),
  });
  if (res.status === 401) throw new Error("AUTH");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function worker(cfg, ctx, n) {
  let pause = 0;
  for (;;) {
    try {
      const { job } = await call(cfg, "/api/helper/next");
      pause = 0;
      if (!job) continue;
      const u = new URL(job.url);
      const allowed =
        u.protocol === "https:" &&
        (job.kind === "page" ? PAGE_HOSTS : IMAGE_HOSTS).test(u.hostname);
      let result;
      try {
        if (!allowed) throw new Error("Этот сайт помощник не открывает.");
        log(
          `[${n}] ${job.kind === "page" ? "Страница" : "Картинка"}: ${u.hostname}${u.pathname.slice(0, 60)}`,
        );
        result =
          job.kind === "page"
            ? await openPage(ctx, u.href)
            : await fetchImage(ctx, u.href);
      } catch (e) {
        log(`[${n}] Не получилось: ${e.message}`);
        result = { error: String(e.message || e).slice(0, 200) };
      }
      await call(cfg, "/api/helper/result", { id: job.id, ...result });
    } catch (e) {
      if (e.message === "AUTH") {
        log(
          "Приложение не приняло ключ. Запустите помощника с --setup и введите ключ заново.",
        );
        process.exit(1);
      }
      pause = Math.min(60000, pause ? pause * 2 : 2000);
      log(
        `Нет связи с приложением (${e.message}). Повтор через ${pause / 1000} с.`,
      );
      await sleep(pause);
    }
  }
}

const cfg = await loadConfig();
const ctx = await launch();
if (SHOW) {
  const p = ctx.pages()[0] || (await ctx.newPage());
  await p.goto("https://www.ozon.ru/").catch(() => {});
  log(
    "Окно открыто: если Ozon просит проверку — пройдите её. Окно можно не закрывать.",
  );
}
log(`Помощник работает. Приложение: ${cfg.api}`);
await Promise.all(
  Array.from({ length: WORKERS }, (_, i) => worker(cfg, ctx, i + 1)),
);
