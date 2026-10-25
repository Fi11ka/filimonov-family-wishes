// Home helper: a small program on an always-on computer in Russia that opens
// shop pages in a real Chrome. Ozon, DNS, Yandex Market and AliExpress.ru answer
// servers (Cloudflare, Yandex Cloud, link-preview services) with anti-bot pages,
// but show the product to an ordinary browser on a home connection.
//
// The helper connects out to this Worker (no open ports, no tunnel): it long-polls
// /api/helper/next for a job and posts the result to /api/helper/result. Jobs
// live in D1 for a few seconds. D1 allows 50 queries per invocation on the free
// plan, so every loop below has a fixed query budget.
import { fail, hash, token } from "./security";
import type { Page } from "./shops/types";

/** Shops that block servers but not a home browser, and their image CDNs. */
export const HELPER_PAGE_HOSTS =
  /(^|\.)(ozon\.(ru|by|kz)|dns-shop\.(ru|kz)|market\.yandex\.(ru|by|kz|uz)|aliexpress\.ru)$/;
export const HELPER_IMAGE_HOSTS =
  /(^|\.)(ozon\.(ru|by|kz)|ozone\.ru|dns-shop\.(ru|kz)|aliexpress\.ru|alicdn\.com|aliexpress-media\.com|avatars\.mds\.yandex\.net)$/;

/** The helper is considered online if it polled within this many seconds. */
export const ONLINE_SECONDS = 60;
/** Results larger than this are refused (D1 rows are limited to 2 MB). */
export const MAX_RESULT_CHARS = 1_500_000;
const JOB_TTL_SECONDS = 3600;

export interface HelperTiming {
  /** How long a lookup waits for the helper. */
  waitMs: number;
  /** Interval between D1 checks while waiting for a result. */
  pollMs: number;
  /** How long /api/helper/next holds the helper's request. */
  holdMs: number;
  /** Interval between D1 checks for a new job. */
  claimMs: number;
}
export const DEFAULT_TIMING: HelperTiming = {
  waitMs: 22000,
  pollMs: 750,
  holdMs: 20000,
  claimMs: 1000,
};

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stmt = (db: D1Database, sql: string, ...args: unknown[]) =>
  db.prepare(sql).bind(...args);

export type JobKind = "page" | "image";
interface JobRow {
  status: string;
  result_status: number | null;
  result_url: string | null;
  result_type: string | null;
  body: string | null;
}
export interface ImageResult {
  status: number;
  type: string;
  bytes: Uint8Array;
}

export interface HomeHelper {
  handlesPage(url: URL): boolean;
  handlesImage(url: URL): boolean;
  /** "offline" once a lookup found the helper not polling. */
  status(): "unused" | "offline" | "used";
  page(url: URL): Promise<Page | null>;
  image(url: URL): Promise<ImageResult | null>;
}

export async function helperOnline(db: D1Database) {
  const r = await stmt(
    db,
    "SELECT seen_at FROM helper_state WHERE id=1",
  ).first<{ seen_at: number }>();
  return !!r && now() - r.seen_at <= ONLINE_SECONDS;
}

/** Queues one job and waits for its result; null if offline or too slow. */
async function run(
  db: D1Database,
  kind: JobKind,
  url: URL,
  timing: HelperTiming,
): Promise<JobRow | null> {
  const id = token(16);
  await stmt(
    db,
    "INSERT INTO helper_jobs(id,kind,url,status,created_at) VALUES(?,?,?,'queued',?)",
    id,
    kind,
    url.href,
    now(),
  ).run();
  try {
    const deadline = Date.now() + timing.waitMs;
    while (Date.now() < deadline) {
      await sleep(timing.pollMs);
      const row = await stmt(
        db,
        "SELECT status,result_status,result_url,result_type,body FROM helper_jobs WHERE id=? AND status IN ('done','error')",
        id,
      ).first<JobRow>();
      if (row) return row.status === "done" ? row : null;
    }
    return null;
  } finally {
    await stmt(db, "DELETE FROM helper_jobs WHERE id=?", id).run();
  }
}

function fromBase64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Per-request client. Pages are cached so a fallback parser costs no new job. */
export function homeHelper(
  db: D1Database,
  timing: HelperTiming = DEFAULT_TIMING,
): HomeHelper {
  let online: Promise<boolean> | null = null;
  let state: "unused" | "offline" | "used" = "unused";
  const pages = new Map<string, Promise<Page | null>>();
  const isOnline = async () => {
    online ??= helperOnline(db).catch(() => false);
    const ok = await online;
    if (!ok) state = "offline";
    return ok;
  };
  return {
    handlesPage: (u) => HELPER_PAGE_HOSTS.test(u.hostname.toLowerCase()),
    handlesImage: (u) => HELPER_IMAGE_HOSTS.test(u.hostname.toLowerCase()),
    status: () => state,
    page(url) {
      const key = url.href;
      if (!pages.has(key))
        pages.set(
          key,
          (async () => {
            if (!(await isOnline())) return null;
            const row = await run(db, "page", url, timing).catch(() => null);
            if (!row) return null;
            state = "used";
            let final = url;
            try {
              final = new URL(row.result_url || url.href);
            } catch {
              // keep the requested URL
            }
            return {
              url: final,
              status: row.result_status ?? 200,
              html: row.body || "",
            };
          })(),
        );
      return pages.get(key)!;
    },
    async image(url) {
      if (!(await isOnline())) return null;
      const row = await run(db, "image", url, timing).catch(() => null);
      if (!row?.body) return null;
      try {
        return {
          status: row.result_status ?? 200,
          type: row.result_type || "",
          bytes: fromBase64(row.body),
        };
      } catch {
        return null;
      }
    },
  };
}

// ---- Endpoints used by the helper program ----

async function authorize(req: Request, secret: string | undefined) {
  if (!secret) fail(404, "NOT_FOUND", "Раздел не найден.");
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  // Compare digests so the comparison time does not depend on the secret.
  if (!given || (await hash(given)) !== (await hash(secret)))
    fail(401, "HELPER_AUTH", "Неверный ключ помощника.");
}

async function readJson(req: Request, max: number) {
  const reader = req.body?.getReader();
  if (!reader) fail(400, "VALIDATION", "Пустой запрос.");
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      fail(413, "TOO_LARGE", "Ответ помощника слишком большой.");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  try {
    const b = JSON.parse(new TextDecoder().decode(bytes));
    if (!b || typeof b !== "object" || Array.isArray(b)) throw 0;
    return b as Record<string, unknown>;
  } catch {
    fail(400, "VALIDATION", "Некорректный JSON.");
  }
}

/** Atomically takes the oldest fresh job, or null. */
export async function claimJob(db: D1Database) {
  return stmt(
    db,
    `UPDATE helper_jobs SET status='taken',taken_at=?1
     WHERE id=(SELECT id FROM helper_jobs WHERE status='queued' AND created_at>=?2 ORDER BY created_at LIMIT 1)
     RETURNING id,kind,url`,
    now(),
    now() - 30,
  ).first<{ id: string; kind: JobKind; url: string }>();
}

export async function helperRoute(
  req: Request,
  db: D1Database,
  secret: string | undefined,
  timing: HelperTiming = DEFAULT_TIMING,
): Promise<unknown> {
  const path = new URL(req.url).pathname;
  await authorize(req, secret);
  if (path === "/api/helper/next" && req.method === "POST") {
    await stmt(
      db,
      "INSERT INTO helper_state(id,seen_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at",
      now(),
    ).run();
    const deadline = Date.now() + timing.holdMs;
    for (;;) {
      const job = await claimJob(db);
      if (job) return { job };
      if (Date.now() + timing.claimMs >= deadline) return { job: null };
      await sleep(timing.claimMs);
    }
  }
  if (path === "/api/helper/result" && req.method === "POST") {
    const b = await readJson(req, MAX_RESULT_CHARS + 10000);
    const id = String(b.id ?? "");
    if (!/^[A-Za-z0-9_-]{22}$/.test(id))
      fail(400, "VALIDATION", "Неизвестное задание.");
    const ok = typeof b.error !== "string";
    const text = typeof b.body === "string" ? b.body : "";
    if (text.length > MAX_RESULT_CHARS)
      fail(413, "TOO_LARGE", "Ответ помощника слишком большой.");
    let finalUrl = "";
    try {
      // Only an https address on the same allowed shops may be reported back.
      const u = new URL(String(b.url ?? ""));
      if (
        u.protocol === "https:" &&
        (HELPER_PAGE_HOSTS.test(u.hostname) ||
          HELPER_IMAGE_HOSTS.test(u.hostname))
      )
        finalUrl = u.href;
    } catch {
      // ignore an invalid address
    }
    const status = Number(b.status);
    await stmt(
      db,
      "UPDATE helper_jobs SET status=?,result_status=?,result_url=?,result_type=?,body=? WHERE id=? AND status='taken'",
      ok ? "done" : "error",
      Number.isInteger(status) && status >= 100 && status < 600 ? status : 200,
      finalUrl || null,
      String(b.type ?? "").slice(0, 100),
      ok ? text : null,
      id,
    ).run();
    return { ok: true };
  }
  if (path === "/api/helper/status" && req.method === "GET")
    return { online: await helperOnline(db) };
  fail(404, "NOT_FOUND", "Раздел не найден.");
}

export function cleanupHelperJobs(db: D1Database) {
  return stmt(
    db,
    "DELETE FROM helper_jobs WHERE created_at<?",
    now() - JOB_TTL_SECONDS,
  );
}
