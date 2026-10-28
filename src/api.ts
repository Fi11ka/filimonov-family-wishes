export { BOT, profileLink } from "./telegram-links";
import { closesAfterSwitch, telegramAppLink } from "./telegram-links";
import { isAccountId } from "../shared/account-id";
import { isToken } from "../shared/token";
export const telegram = (
  window as unknown as {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready: () => void;
        expand: () => void;
        setHeaderColor: (c: string) => void;
        setBackgroundColor: (c: string) => void;
        openTelegramLink: (u: string) => void;
        /** Opens a link outside Telegram, in the system browser. */
        openLink?: (u: string) => void;
        /** Closes the Mini App. */
        close?: () => void;
        HapticFeedback?: { notificationOccurred: (type: string) => void };
        platform?: string;
        isVersionAtLeast?: (version: string) => boolean;
        // Bot API 8.0+: full-screen mode on mobile and desktop clients.
        isFullscreen?: boolean;
        requestFullscreen?: () => void;
        exitFullscreen?: () => void;
        onEvent?: (
          event: string,
          handler: (e?: { error?: string }) => void,
        ) => void;
        offEvent?: (
          event: string,
          handler: (e?: { error?: string }) => void,
        ) => void;
      };
    };
  }
).Telegram?.WebApp;
const start =
  new URLSearchParams(telegram?.initData || "").get("start_param") ||
  new URLSearchParams(location.search).get("tgWebAppStartParam") ||
  "";
/** The owner's secret guest link: booking by name without an account. */
export const guestToken =
  new URLSearchParams(location.hash.slice(1)).get("guest") ||
  (start.startsWith("g_") ? start.slice(2) : "");
/** A profile to open: t.me/…?startapp=p_<id> or the website's ?p=<id>. */
export const profileTarget =
  [
    start.startsWith("p_") ? start.slice(2) : "",
    new URLSearchParams(location.search).get("p") || "",
  ].find((id) => isAccountId(id)) || "";
/** ?l=<id>: which list kept for someone close a profile link opens first. */
export const listTarget =
  new URLSearchParams(location.search).get("l")?.match(/^[a-f0-9-]{36}$/)?.[0] ||
  "";
/** Old «Поделиться» (s_) and friend invitation (f_) links: the server names whose profile they lead to. */
export const legacyLink =
  start.startsWith("s_") || start.startsWith("f_") ? start.slice(2) : "";
/** Screen to open from a bot button: ?open=l_<user id> (a friend's list) or ?open=b («Мои брони»). */
export const openTarget =
  new URLSearchParams(location.search).get("open") || "";
export interface Notifications {
  enabled: boolean;
  bot_connected: boolean;
  bot_url: string;
}
/** Opens the bot chat: inside Telegram without leaving the Mini App, elsewhere in a new tab. */
export function openBot(url: string) {
  if (telegram?.initData) telegram.openTelegramLink(url);
  else window.open(url, "_blank", "noopener");
}
/**
 * «В браузере» from the Mini App opens the site with #login=<one-time code>.
 * The code is taken out of the address at once, before anything else runs,
 * so it does not stay in the history or in a copied link.
 */
export const handoffCode = (() => {
  const hash = new URLSearchParams(location.hash.slice(1));
  const code = hash.get("login") || "";
  if (!code) return "";
  hash.delete("login");
  const rest = hash.toString();
  history.replaceState(
    null,
    "",
    location.pathname + location.search + (rest ? `#${rest}` : ""),
  );
  return isToken(code) ? code : "";
})();
export const demo = new URLSearchParams(location.search).get("demo") === "1";
// Website sign-in: session token from POST /api/auth/telegram-login. The Mini App
// never uses it; there Telegram's signed initData identifies the user.
const SESSION_KEY = "fw:session";
export function sessionToken() {
  if (telegram?.initData) return "";
  try {
    return localStorage.getItem(SESSION_KEY) || "";
  } catch {
    return "";
  }
}
export function setSessionToken(value: string | null) {
  try {
    if (value) localStorage.setItem(SESSION_KEY, value);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Without storage the website cannot stay signed in; the Mini App is unaffected.
  }
}
// Guests cancel their booking with the code the API returned; it stays in this browser only.
const GUEST_CODES_KEY = "fw:guest-codes";
export function guestCodes(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(GUEST_CODES_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
export function setGuestCode(giftId: string, code: string | null) {
  const codes = guestCodes();
  if (code) codes[giftId] = code;
  else delete codes[giftId];
  try {
    localStorage.setItem(GUEST_CODES_KEY, JSON.stringify(codes));
  } catch {
    // Without storage the guest cannot cancel later; the booking itself is saved.
  }
}
// «Отправить близким» is offered once, after the first wish added on this device.
const SHARE_OFFERED_KEY = "fw:share-offered";
export function shareOffered() {
  try {
    return localStorage.getItem(SHARE_OFFERED_KEY) === "1";
  } catch {
    return true;
  }
}
export function rememberShareOffered() {
  try {
    localStorage.setItem(SHARE_OFFERED_KEY, "1");
  } catch {
    // Without storage it is simply not offered.
  }
}
// A guest's name, offered again the next time they book from this browser.
const GUEST_NAME_KEY = "fw:guest-name";
export function savedGuestName() {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) || "";
  } catch {
    return "";
  }
}
export function saveGuestName(name: string) {
  try {
    localStorage.setItem(GUEST_NAME_KEY, name);
  } catch {
    // Without storage the guest just types the name again.
  }
}
export const signedIn = () => !!telegram?.initData || !!sessionToken();
// Set after the first sign-in on this device: an expired session gets a short «Войдите снова».
const SIGNED_IN_BEFORE_KEY = "fw:signed-in-before";
export function signedInBefore() {
  try {
    return localStorage.getItem(SIGNED_IN_BEFORE_KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberSignIn() {
  try {
    localStorage.setItem(SIGNED_IN_BEFORE_KEY, "1");
  } catch {
    // Without storage a returning person just sees the full sign-in screen.
  }
}
/** Website only: turns the one-time code from the Mini App into a normal sign-in. */
export async function redeemHandoff() {
  if (!handoffCode || telegram?.initData) return false;
  const r = await api<{ token: string }>("/api/auth/handoff/redeem", "POST", {
    code: handoffCode,
  });
  setSessionToken(r.token);
  return true;
}
/** Mini App: opens this site in the system browser, already signed in, then closes itself. */
export async function openInBrowser() {
  const { code } = await api<{ code: string }>("/api/auth/handoff", "POST");
  const url = `${location.origin}${location.pathname}#login=${code}`;
  if (!telegram?.openLink) {
    window.open(url, "_blank", "noopener");
    return;
  }
  telegram.openLink(url);
  if (telegram.close && closesAfterSwitch(telegram.platform))
    // A short pause lets Telegram hand the link to the browser first.
    setTimeout(() => telegram?.close?.(), 400);
}
// The published site and the API are one Worker, so a production build talks
// to its own address; VITE_API_URL points the dev server at a local API.
export const apiConfigured =
  !!import.meta.env.VITE_API_URL || import.meta.env.PROD;
const apiBase = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The API's error code, e.g. TAKEN when someone booked the gift first. */
    public code = "",
  ) {
    super(message);
  }
}
async function request(
  path: string,
  method: string,
  data: unknown,
  timeout: number,
): Promise<Response> {
  if (!apiConfigured)
    throw new Error(
      "Адрес API ещё не настроен. Завершите подключение Cloudflare по инструкции DEPLOY.md.",
    );
  const headers: Record<string, string> = {};
  const session = sessionToken();
  if (telegram?.initData) headers.Authorization = `tma ${telegram.initData}`;
  else if (session) headers.Authorization = `Session ${session}`;
  if (guestToken) headers["X-Guest-Token"] = guestToken;
  if (data !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error(
      "Нет связи с приложением. Проверьте интернет и попробуйте ещё раз.",
    );
  }
  if (!res.ok) {
    const value: any = await res.json().catch(() => ({}));
    // An expired or revoked website session: forget it so the sign-in button shows again.
    if (res.status === 401 && session) setSessionToken(null);
    throw new RequestError(
      res.status,
      value.error?.message || "Не удалось выполнить запрос.",
      typeof value.error?.code === "string" ? value.error.code : "",
    );
  }
  return res;
}
export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
  timeout = 20000,
): Promise<T> {
  const res = await request(path, method, data, timeout);
  return (await res.json().catch(() => ({}))) as T;
}
/** Binary answers (images fetched by link, spreadsheets). */
export async function apiBlob(path: string, data: unknown, timeout = 30000) {
  return (await request(path, "POST", data, timeout)).blob();
}
export const telegramLink = () =>
  telegramAppLink(
    guestToken ? `g_${guestToken}` : profileTarget ? `p_${profileTarget}` : "",
  );
export { compressPhoto, compressScreenshot, cropPhoto } from "./photo";
import { compressPhoto } from "./photo";
/** Downloads a picture through the API (shops forbid direct cross-site reads) and compresses it. */
export async function photoFromUrl(url: string) {
  if (demo) throw new Error("В демо картинки по ссылке не загружаются.");
  // Up to ~32 s when the photo comes through the home helper.
  return compressPhoto(await apiBlob("/api/fetch/image", { url }, 40000));
}
/** POST /api/fetch/cart: a shared WB basket, WB wishlist or Ozon cart. */
export interface CartItem {
  url: string;
  title?: string;
  /** Full shop title when `title` was shortened. */
  details?: string;
  image?: string;
  price_minor?: number | null;
  price_max_minor?: number | null;
}
export interface Cart {
  shop: string;
  /** "chat": names and prices from ChatGPT or a person win over the shop's. */
  kind: "shop" | "chat";
  title: string;
  items: CartItem[];
  truncated: boolean;
}
export interface ProductLookup {
  shop: string | null;
  url: string;
  title: string;
  /** Details moved out of a shortened title, for «Подсказка близким». */
  details?: string;
  image_url: string;
  price: {
    min_minor: number | null;
    max_minor: number | null;
    currency: string;
  } | null;
  blocked: boolean;
  /** Ozon/DNS/…: the home helper is needed but not running. */
  helper_offline?: boolean;
  unavailable?: boolean;
}
/** POST /api/fetch/screenshot: what the vision model read on a product screenshot. */
export interface ScreenshotLookup {
  shop: string | null;
  title: string;
  details: string;
  price: ProductLookup["price"];
  /** Product photo on the screenshot, shares: [left, top, right, bottom]. */
  photo_box: [number, number, number, number] | null;
}
