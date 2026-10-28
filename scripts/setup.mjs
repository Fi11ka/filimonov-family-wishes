import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
const cli = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log("Настройка публичных параметров. Не вводите токены или секреты.");
  const id = (
    await cli.question("database_id, полученный после создания D1: ")
  ).trim();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      id,
    ) ||
    id === "00000000-0000-0000-0000-000000000000"
  )
    throw new Error("Некорректный ID базы.");
  const page = (
    await cli.question(
      "Worker URL (https://filimonov-family-wishes-api.<поддомен>.workers.dev): ",
    )
  ).trim();
  if (!/^https:\/\/[^/]+\.workers\.dev\/?$/.test(page))
    throw new Error("Нужен URL Worker на workers.dev.");
  // The Worker serves both the site and the API, so it is the site's address.
  const url = new URL(page);
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
  config.d1_databases[0].database_id = id;
  config.vars.APP_ORIGIN = url.origin;
  config.vars.APP_URL = url.href;
  writeFileSync("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");
  console.log(
    "Готово: wrangler.jsonc. BOT_TOKEN вводится только через Cloudflare Secret.",
  );
} finally {
  cli.close();
}
