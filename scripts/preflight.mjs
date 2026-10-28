import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
const db = config.d1_databases[0];
if (
  !db?.database_id ||
  db.database_id === "00000000-0000-0000-0000-000000000000"
)
  throw new Error("Укажите настоящий database_id D1: pnpm run setup.");
if (
  !/^https:\/\//.test(config.vars.APP_ORIGIN) ||
  new URL(config.vars.APP_ORIGIN).origin !== config.vars.APP_ORIGIN
)
  throw new Error("APP_ORIGIN должен содержать только HTTPS origin, без пути.");
if (new URL(config.vars.APP_URL).origin !== config.vars.APP_ORIGIN)
  throw new Error("APP_URL и APP_ORIGIN должны относиться к одному сайту.");
console.log("Конфигурация публикации проверена.");
