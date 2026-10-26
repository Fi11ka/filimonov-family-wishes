import React, { useEffect, useRef, useState } from "react";
import { Check, Crop, Minus, Plus, RotateCcw } from "lucide-react";
import { encodePhoto } from "./photo";
// The photo editor in the wish form. The frame has the proportions of the photo
// on a gift card, so what is in the frame is exactly what the card will show.
// The preview and the saved photo are drawn by the same function.

/** Width / height of the photo on a gift card (see .photo-wrap in style.css). */
export const CARD_RATIO = 4 / 3;
const OUT_W = 960,
  OUT_H = Math.round(OUT_W / CARD_RATIO);
export interface Framing {
  /** 1 fills the frame (minus margins); less leaves background around the photo. */
  zoom: number;
  /** Photo centre shift, as a share of the frame width / height. */
  x: number;
  y: number;
  /** Margin on each side, as a share of the frame width. */
  pad: number;
  background: string;
}
export const DEFAULT_FRAMING: Framing = {
  zoom: 1,
  x: 0,
  y: 0,
  pad: 0,
  background: "#ffffff",
};
const SWATCHES = [
  "#ffffff",
  "#f3eff8",
  "#f6ead9",
  "#fde4ec",
  "#e3f4ea",
  "#e2ecfa",
  "#2b2733",
];
export const MIN_ZOOM = 0.3,
  MAX_ZOOM = 4;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** Draws the framed photo into a w×h area. */
export function drawFramed(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  image: HTMLImageElement,
  f: Framing,
) {
  ctx.fillStyle = f.background;
  ctx.fillRect(0, 0, w, h);
  const pad = f.pad * w,
    iw = w - pad * 2,
    ih = h - pad * 2;
  if (iw <= 0 || ih <= 0) return;
  const nw = image.naturalWidth,
    nh = image.naturalHeight;
  // zoom 1 = the photo covers the area inside the margins.
  const scale = Math.max(iw / nw, ih / nh) * f.zoom;
  const dw = nw * scale,
    dh = nh * scale;
  const cx = w / 2 + f.x * w,
    cy = h / 2 + f.y * h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, pad, iw, ih);
  ctx.clip();
  ctx.drawImage(image, cx - dw / 2, cy - dh / 2, dw, dh);
  ctx.restore();
}
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось открыть фото."));
    image.src = src;
  });
}
/** The photo as saved: the frame contents, compressed like any other photo. */
export async function renderFramed(src: string, f: Framing) {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  drawFramed(canvas.getContext("2d")!, OUT_W, OUT_H, image, f);
  return encodePhoto(canvas, OUT_W, OUT_H, document.createElement("canvas"));
}
export function PhotoFrame({
  src,
  framing,
  onChange,
}: {
  /** A data: URL (pictures from other sites are loaded through the API first). */
  src: string;
  framing: Framing;
  onChange: (f: Framing) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const latest = useRef(framing);
  latest.current = framing;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  // Locked until «Настроить кадр»: scrolling the form over the photo must not
  // move or zoom it by accident.
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    let alive = true;
    setImage(null);
    setError("");
    loadImage(src)
      .then((img) => alive && setImage(img))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [src]);
  // Redraw on every change, at the screen's pixel density.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !image) return;
    const draw = () => {
      const w = c.clientWidth,
        h = c.clientHeight,
        dpr = window.devicePixelRatio || 1;
      if (!w || !h) return;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFramed(ctx, w, h, image, framing);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(c);
    return () => observer.disconnect();
  }, [image, framing]);
  // Wheel zoom without scrolling the form (React wheel handlers are passive).
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const wheel = (e: WheelEvent) => {
      if (!editingRef.current) return;
      e.preventDefault();
      onChange({
        ...latest.current,
        zoom: clamp(
          latest.current.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08),
          MIN_ZOOM,
          MAX_ZOOM,
        ),
      });
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, [onChange]);
  const update = (patch: Partial<Framing>) =>
    onChange({ ...latest.current, ...patch });
  const zoomBy = (factor: number) =>
    update({ zoom: clamp(latest.current.zoom * factor, MIN_ZOOM, MAX_ZOOM) });
  return (
    <div className={`photo-frame ${editing ? "editing" : ""}`}>
      <div className="photo-frame-stage">
      <canvas
        ref={canvas}
        className="photo-frame-canvas"
        role="img"
        aria-label={
          editing
            ? "Фото в рамке карточки. Перетащите, чтобы сдвинуть; колесо или два пальца — приблизить."
            : "Фото в рамке карточки"
        }
        onPointerDown={(e) => {
          if (!editing) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinch.current = {
              distance: Math.hypot(a.x - b.x, a.y - b.y),
              zoom: latest.current.zoom,
            };
          }
        }}
        onPointerMove={(e) => {
          const last = pointers.current.get(e.pointerId);
          if (!last) return;
          const now = { x: e.clientX, y: e.clientY };
          pointers.current.set(e.pointerId, now);
          if (pointers.current.size === 2 && pinch.current) {
            const [a, b] = [...pointers.current.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            update({
              zoom: clamp(
                (pinch.current.zoom * d) / pinch.current.distance,
                MIN_ZOOM,
                MAX_ZOOM,
              ),
            });
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          update({
            x: clamp(latest.current.x + (now.x - last.x) / rect.width, -1, 1),
            y: clamp(latest.current.y + (now.y - last.y) / rect.height, -1, 1),
          });
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          pinch.current = null;
        }}
      />
      <button
        type="button"
        className={`photo-frame-toggle ${editing ? "done" : ""}`}
        onClick={() => setEditing(!editing)}
      >
        {editing ? (
          <>
            <Check size={15} /> Готово
          </>
        ) : (
          <>
            <Crop size={15} /> Настроить кадр
          </>
        )}
      </button>
      </div>
      {error && (
        <p className="photo-note" role="alert">
          {error}
        </p>
      )}
      {editing && (
      <div className="photo-frame-controls">
        <p className="small-text">
          Перетащите фото, чтобы сдвинуть; колесо мыши или два пальца —
          приблизить.
        </p>
        <div className="photo-frame-row">
          <span>Масштаб</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Отдалить"
            onClick={() => zoomBy(1 / 1.15)}
          >
            <Minus size={15} />
          </button>
          <input
            type="range"
            aria-label="Масштаб"
            min={Math.log(MIN_ZOOM)}
            max={Math.log(MAX_ZOOM)}
            step={0.01}
            value={Math.log(framing.zoom)}
            onChange={(e) => update({ zoom: Math.exp(Number(e.target.value)) })}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Приблизить"
            onClick={() => zoomBy(1.15)}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="photo-frame-row">
          <span>Поля</span>
          <input
            type="range"
            aria-label="Поля вокруг фото"
            min={0}
            max={0.25}
            step={0.005}
            value={framing.pad}
            onChange={(e) => update({ pad: Number(e.target.value) })}
          />
        </div>
        <div className="photo-frame-row">
          <span>Фон</span>
          <div className="swatches" role="radiogroup" aria-label="Цвет фона">
            {SWATCHES.map((color) => (
              <button
                type="button"
                key={color}
                role="radio"
                aria-checked={framing.background === color}
                aria-label={`Фон ${color}`}
                className={`swatch ${framing.background === color ? "selected" : ""}`}
                style={{ background: color }}
                onClick={() => update({ background: color })}
              />
            ))}
            <label
              className="swatch custom"
              title="Свой цвет"
              style={{ background: framing.background }}
            >
              <input
                type="color"
                aria-label="Свой цвет фона"
                value={framing.background}
                onChange={(e) => update({ background: e.target.value })}
              />
            </label>
          </div>
          <button
            type="button"
            className="text-link"
            onClick={() => onChange(DEFAULT_FRAMING)}
          >
            <RotateCcw size={14} /> Сбросить
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
