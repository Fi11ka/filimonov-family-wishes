const PHOTO_TYPES = /^image\/(jpeg|png|webp|gif|avif|heic|heif)$/;
const MAX_DATA_URL = 215000;
/** Safari silently returns PNG when asked for WebP. Always check the result,
 * try JPEG too, then shrink detailed photos to stay below the API/D1 limit. */
export function encodePhoto(
  image: CanvasImageSource,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
): string {
  if (!width || !height) throw new Error("У фотографии нет размеров.");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось обработать фото.");
  for (const edge of [900, 720, 540, 360]) {
    const ratio = Math.min(1, edge / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    // JPEG has no alpha; product photos get a white rather than black background.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const type of ["image/webp", "image/jpeg"]) {
      for (const quality of [0.82, 0.66, 0.5, 0.35]) {
        const result = canvas.toDataURL(type, quality);
        if (
          /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(
            result,
          ) &&
          result.length < MAX_DATA_URL
        )
          return result;
        // Unsupported encoders return PNG: lowering its quality does nothing.
        if (!result.startsWith(`data:${type};`)) break;
      }
    }
  }
  throw new Error(
    "Не удалось сжать фото. Выберите фотографию меньшего размера.",
  );
}
export async function compressPhoto(file: Blob): Promise<string> {
  if (!PHOTO_TYPES.test(file.type) || file.size > 20 * 1024 * 1024)
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
    return encodePhoto(
      image,
      image.naturalWidth,
      image.naturalHeight,
      document.createElement("canvas"),
    );
  } finally {
    URL.revokeObjectURL(source);
  }
}
