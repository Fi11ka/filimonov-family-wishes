export { BOT } from "./telegram-links";
import { telegramAppLink } from "./telegram-links";
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
export const guestToken =
  new URLSearchParams(location.hash.slice(1)).get("guest") ||
  (start.startsWith("g_") || start.startsWith("s_") ? start.slice(2) : "");
export const authShare = start.startsWith("s_");
/** Friend invitation opened from t.me/…?startapp=f_<token> */
export const friendInvite = start.startsWith("f_") ? start.slice(2) : "";
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
export const signedIn = () => !!telegram?.initData || !!sessionToken();
export const apiConfigured = !!import.meta.env.VITE_API_URL;
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
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
    res = await fetch(
      `${import.meta.env.VITE_API_URL.replace(/\/$/, "")}${path}`,
      {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      },
    );
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
  telegramAppLink(guestToken, friendInvite, authShare);
export { compressPhoto } from "./photo";
import { compressPhoto } from "./photo";
/** Downloads a picture through the API (shops forbid direct cross-site reads) and compresses it. */
export async function photoFromUrl(url: string) {
  if (demo) throw new Error("В демо картинки по ссылке не загружаются.");
  // Up to ~32 s when the photo comes through the home helper.
  return compressPhoto(await apiBlob("/api/fetch/image", { url }, 40000));
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
