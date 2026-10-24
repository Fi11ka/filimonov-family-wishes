export const BOT = "FilimonovFamilyWishes_bot";
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
  (start.startsWith("g_") ? start.slice(2) : "");
export const demo = new URLSearchParams(location.search).get("demo") === "1";
export const apiConfigured = !!import.meta.env.VITE_API_URL;
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  if (!apiConfigured)
    throw new Error(
      "Адрес API ещё не настроен. Завершите подключение Cloudflare по инструкции DEPLOY.md.",
    );
  const headers: Record<string, string> = {};
  if (telegram?.initData) headers.Authorization = `tma ${telegram.initData}`;
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
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new Error(
      "Нет связи с приложением. Проверьте интернет и попробуйте ещё раз.",
    );
  }
  const value: any = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new RequestError(
      res.status,
      value.error?.message || "Не удалось выполнить запрос.",
    );
  return value;
}
export const telegramLink = () =>
  `https://t.me/${BOT}?startapp${guestToken ? `=g_${guestToken}` : ""}`;
export async function compressPhoto(file: File): Promise<string> {
  if (
    !/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) ||
    file.size > 20 * 1024 * 1024
  )
    throw new Error("Выберите фотографию JPEG, PNG или WebP до 20 МБ.");
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode().catch(() => {
      throw new Error(
        "Не удалось открыть фото. Для HEIC выберите экспорт в JPEG.",
      );
    });
    const canvas = document.createElement("canvas"),
      ratio = Math.min(1, 900 / Math.max(image.width, image.height));
    canvas.width = Math.round(image.width * ratio);
    canvas.height = Math.round(image.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Не удалось обработать фото.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.66, 0.5, 0.35]) {
      const result = canvas.toDataURL("image/webp", quality);
      if (result.length < 215000) return result;
    }
    throw new Error(
      "Фото слишком детальное. Выберите фотографию меньшего размера.",
    );
  } finally {
    URL.revokeObjectURL(source);
  }
}
