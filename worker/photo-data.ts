// Photos kept in the database as data URLs (gifts.photo, users.photo).
/** A stored photo: JPEG, PNG or WebP as the browser compresses it (src/photo.ts). */
export const PHOTO_DATA_URL =
  /^data:image\/(jpeg|webp|png);base64,([A-Za-z0-9+/]+=*)$/;
/** Image bytes as a data URL of the given type. */
export function dataUrlOf(bytes: Uint8Array, type: string) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}
/** The bytes of a stored photo; null for anything else. */
export function photoBytes(dataUrl: string): Uint8Array | null {
  const m = dataUrl.match(PHOTO_DATA_URL);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
