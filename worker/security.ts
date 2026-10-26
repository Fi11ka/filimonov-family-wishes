import { MAX_MINOR, isCurrency } from "../shared/price";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
const encoder = new TextEncoder();
export async function hash(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function token(bytes = 32) {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function hmac(key: Uint8Array<ArrayBuffer>, value: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(value));
}
export interface Identity {
  id: string;
  name: string;
  /** Telegram @username, lowercase, from the signed payload only. */
  username: string | null;
  /** Profile photo link from the same signed payload; used only to fetch the photo once. */
  photo_url?: string;
}
export async function validateInitData(
  raw: string,
  botToken: string,
  now = Math.floor(Date.now() / 1000),
): Promise<Identity> {
  if (!raw || raw.length > 16384)
    fail(401, "AUTH_REQUIRED", "Откройте приложение через Telegram.");
  const p = new URLSearchParams(raw);
  const keys = [...p.keys()];
  if (new Set(keys).size !== keys.length)
    fail(401, "AUTH_INVALID", "Некорректные данные входа.");
  const received = p.get("hash") || "";
  if (!/^[a-f0-9]{64}$/i.test(received))
    fail(401, "AUTH_INVALID", "Не удалось подтвердить вход.");
  p.delete("hash");
  const data = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = new Uint8Array(
    await hmac(encoder.encode("WebAppData"), botToken),
  );
  const expected = hex(await hmac(secret, data));
  let diff = 0;
  for (let i = 0; i < 64; i++)
    diff |= expected.charCodeAt(i) ^ received.toLowerCase().charCodeAt(i);
  if (diff) fail(401, "AUTH_INVALID", "Не удалось подтвердить вход.");
  const date = Number(p.get("auth_date"));
  if (
    !Number.isSafeInteger(date) ||
    date <= 0 ||
    date > now + 30 ||
    now - date > 3600
  )
    fail(
      401,
      "AUTH_EXPIRED",
      "Время входа истекло. Закройте и снова откройте приложение в Telegram.",
    );
  let user: {
    id?: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    photo_url?: string;
    is_bot?: boolean;
  };
  try {
    user = JSON.parse(p.get("user") || "{}");
  } catch {
    fail(401, "AUTH_INVALID", "Некорректный пользователь.");
  }
  if (
    !user ||
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0 ||
    typeof user.first_name !== "string" ||
    user.is_bot
  )
    fail(401, "AUTH_INVALID", "Некорректный пользователь.");
  return {
    id: String(user.id),
    name:
      [
        user.first_name,
        typeof user.last_name === "string" ? user.last_name : "",
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 160) || "Участник",
    username: usernameOf(user.username),
    ...(telegramPhotoUrl(user.photo_url)
      ? { photo_url: telegramPhotoUrl(user.photo_url) }
      : {}),
  };
}
/** Profile photo links Telegram signs into initData (photo_url) and the OIDC token (picture). */
export function telegramPhotoUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 512) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && isTelegramPhotoHost(u.hostname)
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function isTelegramPhotoHost(host: string) {
  host = host.toLowerCase();
  return ["t.me", "telesco.pe", "telegram.org"].some(
    (h) => host === h || host.endsWith(`.${h}`),
  );
}
/** Telegram usernames: 4–32 latin letters, digits and underscores. */
export function usernameOf(value: unknown) {
  const v = typeof value === "string" ? value.trim().replace(/^@/, "") : "";
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v) ? v.toLowerCase() : null;
}
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string")
    fail(400, "VALIDATION", "Проверьте заполненные поля.");
  const v = value.trim();
  if (v.length > max || (required && !v))
    fail(400, "VALIDATION", "Проверьте длину заполненных полей.");
  return v;
}
export function https(value: unknown) {
  const v = text(value ?? "", 2048);
  if (!v) return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) throw 0;
    return u.href;
  } catch {
    fail(400, "VALIDATION", "Ссылка должна начинаться с https://.");
  }
}
export function giftInput(b: Record<string, unknown>) {
  const title = text(b.title, 120, true),
    description = text(b.description ?? "", 2000);
  const currency = text(b.currency, 3);
  if (!isCurrency(currency)) fail(400, "VALIDATION", "Выберите валюту.");
  const amount = (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > MAX_MINOR)
      fail(400, "VALIDATION", "Некорректная цена.");
    return v as number;
  };
  if (b.price_minor === undefined)
    fail(400, "VALIDATION", "Некорректная цена.");
  const price = amount(b.price_minor),
    range = b.price_range === true,
    max = range ? amount(b.price_max_minor) : null;
  if (!range && b.price_max_minor !== undefined && b.price_max_minor !== null)
    fail(400, "VALIDATION", "Некорректная цена.");
  if (price !== null && max !== null && max < price)
    fail(400, "VALIDATION", "Цена «до» должна быть больше цены «от».");
  if (
    ![1, 2, 3, 4, 5].includes(Number(b.priority)) ||
    typeof b.priority !== "number"
  )
    fail(400, "VALIDATION", "Выберите приоритет.");
  const photo = text(b.photo ?? "", 220000);
  if (
    photo &&
    !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+=*$/.test(photo)
  )
    https(photo);
  return {
    title,
    description,
    currency,
    price_minor: price,
    price_max_minor: max,
    price_range: range && (price !== null || max !== null) ? 1 : 0,
    priority: b.priority as number,
    shop_url: https(b.shop_url),
    photo,
  };
}
