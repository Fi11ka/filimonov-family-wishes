// Profile photos. The photo from Telegram is taken automatically only on the
// first sign-in; later it changes only when the person asks for it.
import { telegramPhoto } from "./bot";
import { now, stmt, type Env } from "./core";
import { fetchBytes, imageType } from "./net";
import { telegramCall } from "./notify";
import { fail, isTelegramPhotoHost, type Identity } from "./security";
/** Raw bytes ≤ 80 KB stay under the 120 000-character data URL limit of users.photo. */
const MAX_BYTES = 80_000;
export const MAX_PHOTO_CHARS = 120_000;
function dataUrl(bytes: Uint8Array) {
  const type = imageType(bytes);
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}
/** The current Telegram profile photo of the user, compressed by Telegram, or null if hidden/missing. */
export async function telegramAvatar(env: Env, user: Identity) {
  const r = await telegramCall(env, "getUserProfilePhotos", {
    user_id: Number(user.id),
    limit: 1,
  });
  const sizes = (
    r.result as
      | {
          photos?: { file_id: string; file_size?: number; width: number }[][];
        }
      | undefined
  )?.photos?.[0];
  const fromBot = sizes?.length
    ? await telegramPhoto(env, sizes, MAX_BYTES)
    : null;
  if (fromBot) return fromBot;
  // The bot cannot see everyone's photos; the signed sign-in data may still carry a link.
  if (!user.photo_url) return null;
  try {
    const got = await fetchBytes(new URL(user.photo_url), {
      timeoutMs: 6000,
      maxBytes: MAX_BYTES,
      accept: "image/jpeg,image/png,image/webp",
      allowHost: isTelegramPhotoHost,
    });
    return got.status === 200 ? dataUrl(got.bytes) : null;
  } catch {
    return null;
  }
}
/** First sign-in only: put the Telegram photo in once, never over a photo the person chose. */
export async function firstPhoto(env: Env, user: Identity) {
  const first = await stmt(
    env.DB,
    "UPDATE users SET photo_checked=1 WHERE id=? AND photo_checked=0 RETURNING id",
    user.id,
  ).first();
  if (!first) return;
  const photo = await telegramAvatar(env, user);
  if (photo)
    await stmt(
      env.DB,
      "UPDATE users SET photo=?,photo_at=? WHERE id=? AND photo=''",
      photo,
      now(),
      user.id,
    ).run();
}
/** A photo picked on the device and compressed in the browser. */
export function photoInput(value: unknown) {
  const photo = typeof value === "string" ? value : "";
  const m = photo.match(
    /^data:image\/(jpeg|webp|png);base64,([A-Za-z0-9+/]+=*)$/,
  );
  if (!m || photo.length > MAX_PHOTO_CHARS)
    fail(400, "VALIDATION", "Выберите фото JPEG, PNG или WebP поменьше.");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[2].slice(0, 24)), (c) => c.charCodeAt(0));
  } catch {
    fail(400, "VALIDATION", "Не удалось прочитать фото.");
  }
  // The declared type must match the real file.
  if (imageType(bytes) !== `image/${m[1]}`)
    fail(400, "VALIDATION", "Не удалось прочитать фото.");
  return photo;
}
