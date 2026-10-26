import { ApiError, fail } from "./security";
// Outbound fetching for link previews, image and spreadsheet imports.
// Every hop (including redirects) is re-validated; responses are size- and time-bounded.
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".intranet",
  ".workers.dev",
];
export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
};
export function publicHttpsUrl(raw: unknown): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    fail(400, "VALIDATION", "Ссылка должна начинаться с https://.");
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) || // IPv4 literal, incl. shorthand forms
    host.startsWith("[") || // IPv6 literal
    /^0x/i.test(host) ||
    host === "localhost" ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s))
  )
    fail(400, "URL_NOT_ALLOWED", "Эту ссылку нельзя открыть автоматически.");
  u.hash = "";
  return u;
}
export interface Limits {
  timeoutMs: number;
  maxBytes: number;
  /** Return the first maxBytes instead of failing (useful for HTML). */
  truncate?: boolean;
  maxRedirects?: number;
  accept?: string;
  /** Extra host policy applied to every hop. */
  allowHost?: (host: string) => boolean;
  headers?: Record<string, string>;
}
export interface Fetched {
  url: URL;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}
async function follow(start: URL, limits: Limits, signal: AbortSignal) {
  let url = start;
  for (let hop = 0; ; hop++) {
    if (limits.allowHost && !limits.allowHost(url.hostname.toLowerCase()))
      fail(400, "URL_NOT_ALLOWED", "Эту ссылку нельзя открыть автоматически.");
    const res = await fetch(url.href, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: limits.accept || "*/*",
        ...limits.headers,
      },
      redirect: "manual",
      signal,
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= (limits.maxRedirects ?? 5))
        fail(502, "FETCH_FAILED", "Слишком много перенаправлений.");
      url = publicHttpsUrl(new URL(location, url).href);
      continue;
    }
    return { url, res };
  }
}
/**
 * Follows redirects without reading any page, until `done(url)` says the address
 * is final. Every hop passes the same public-address check as fetchBytes.
 */
export async function resolveRedirects(
  start: URL,
  done: (url: URL) => boolean,
  headers: Record<string, string>,
  max = 3,
) {
  let url = publicHttpsUrl(start.href);
  const t = timeout(6000);
  try {
    for (let hop = 0; hop < max && !done(url); hop++) {
      const res = await fetch(url.href, {
        headers,
        redirect: "manual",
        signal: t.signal,
      });
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      url = publicHttpsUrl(new URL(location, url).href);
    }
    return url;
  } finally {
    t.done();
  }
}
function timeout(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}
export async function fetchBytes(raw: URL, limits: Limits): Promise<Fetched> {
  const t = timeout(limits.timeoutMs);
  try {
    const { url, res } = await follow(
      publicHttpsUrl(raw.href),
      limits,
      t.signal,
    );
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > limits.maxBytes && !limits.truncate) {
      await res.body?.cancel();
      fail(413, "TOO_LARGE", "Файл по ссылке слишком большой.");
    }
    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > limits.maxBytes) {
        await reader.cancel();
        if (!limits.truncate)
          fail(413, "TOO_LARGE", "Файл по ссылке слишком большой.");
        parts.push(value.subarray(0, limits.maxBytes - length));
        length = limits.maxBytes;
        break;
      }
      parts.push(value);
      length += value.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.length;
    }
    return { url, status: res.status, headers: res.headers, bytes };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    fail(
      504,
      "FETCH_FAILED",
      t.signal.aborted
        ? "Сайт не ответил вовремя."
        : "Не удалось открыть ссылку.",
    );
  } finally {
    t.done();
  }
}
export function decodeHtml(f: Fetched) {
  const head = String.fromCharCode(...f.bytes.subarray(0, 2048));
  const label =
    f.headers.get("content-type")?.match(/charset=["']?([\w-]+)/i)?.[1] ||
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ||
    "utf-8";
  try {
    return new TextDecoder(label).decode(f.bytes);
  } catch {
    return new TextDecoder().decode(f.bytes);
  }
}
/** Identifies real image bytes; SVG and anything scriptable is rejected. */
export function imageType(bytes: Uint8Array) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (
    ascii(4, 8) === "ftyp" &&
    /^(avif|avis|heic|heix|mif1)$/.test(ascii(8, 12))
  )
    return ascii(8, 12).startsWith("avi") ? "image/avif" : "image/heic";
  return "";
}
