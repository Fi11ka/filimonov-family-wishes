import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePhoto } from "../src/photo";
const data = (type: string, size: number) =>
  `data:${type};base64,${"A".repeat(size)}`;
function canvas(
  encode: (type: string, quality: number, width: number) => string,
) {
  const c = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      fillRect() {},
      drawImage() {},
    }),
    toDataURL(type: string, quality: number) {
      return encode(type, quality, c.width);
    },
  };
  return c as unknown as HTMLCanvasElement;
}
const image = {} as CanvasImageSource;
test("Safari PNG fallback over the limit retries JPEG instead of rejecting the shop photo", () => {
  const calls: string[] = [];
  const c = canvas((type) => {
    calls.push(type);
    return data(
      type === "image/webp" ? "image/png" : type,
      type === "image/webp" ? 300000 : 100000,
    );
  });
  assert.match(encodePhoto(image, 1100, 1100, c), /^data:image\/jpeg;/);
  assert.deepEqual(calls, ["image/webp", "image/jpeg"]);
});
test("a detailed photo is resized until it fits, preserving aspect ratio", () => {
  const c = canvas((type, _q, width) =>
    data(type, width > 720 ? 300000 : 100000),
  );
  assert.ok(encodePhoto(image, 2000, 1000, c).length < 215000);
  assert.equal(c.width, 720);
  assert.equal(c.height, 360);
});
test("supported WebP and small Safari PNG are accepted without needless JPEG conversion", () => {
  for (const type of ["image/webp", "image/png"]) {
    const c = canvas(() => data(type, 500));
    assert.equal(encodePhoto(image, 400, 200, c), data(type, 500));
    assert.equal(c.width, 400);
    assert.equal(c.height, 200);
  }
});
test("empty canvas output and oversized output cannot become a saved photo", () => {
  assert.throws(
    () =>
      encodePhoto(
        image,
        0,
        0,
        canvas(() => "data:,"),
      ),
    /размеров/,
  );
  assert.throws(
    () =>
      encodePhoto(
        image,
        900,
        900,
        canvas(() => "data:,"),
      ),
    /сжать/,
  );
  assert.throws(
    () =>
      encodePhoto(
        image,
        900,
        900,
        canvas(() => data("image/png", 300000)),
      ),
    /сжать/,
  );
});
