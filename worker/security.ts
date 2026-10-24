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
  };
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
  if (
    !["EUR", "USD", "RUB", "GBP", "GEL", "TRY", "KZT", "UAH", "BYN"].includes(
      currency,
    )
  )
    fail(400, "VALIDATION", "Выберите валюту.");
  const price = b.price_minor;
  if (
    price !== null &&
    (!Number.isSafeInteger(price) ||
      Number(price) < 0 ||
      Number(price) > 100000000000)
  )
    fail(400, "VALIDATION", "Некорректная цена.");
  if (![1, 2, 3].includes(Number(b.priority)) || typeof b.priority !== "number")
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
    price_minor: price as number | null,
    priority: b.priority as number,
    shop_url: https(b.shop_url),
    photo,
  };
}
