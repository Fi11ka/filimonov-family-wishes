import React, { useEffect, useRef, useState } from "react";
import { Pencil, Send, Upload } from "lucide-react";
import { api, demo } from "./api";
import { avatarPhoto } from "./photo";
import { type User, initials } from "./types";
// Photos are fetched once per person and version (photo_at changes with every new photo).
const photos = new Map<string, Promise<string>>();
function loadPhoto(id: string, version: number) {
  const key = `${id}:${version}`;
  let p = photos.get(key);
  if (!p) {
    p = api<{ photo: string }>(`/api/users/${id}/photo`).then((r) => r.photo);
    // A failed load is retried next time instead of being remembered.
    p.catch(() => photos.delete(key));
    photos.set(key, p);
  }
  return p;
}
/** The person's photo, or their initials while there is none (or it is still loading). */
export function Face({
  user,
  fallback = "Гость",
}: {
  user: Pick<User, "id" | "name" | "photo_at"> | null | undefined;
  fallback?: string;
}) {
  const [src, setSrc] = useState("");
  const id = user?.id,
    version = user?.photo_at;
  useEffect(() => {
    setSrc("");
    if (!id || !version || demo) return;
    let alive = true;
    loadPhoto(id, version)
      .then((photo) => alive && setSrc(photo))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, version]);
  return src ? (
    <img className="avatar-photo" src={src} alt="" />
  ) : (
    <>{initials(user?.name || fallback)}</>
  );
}
/** Own profile photo with a pencil: «Взять из Telegram» or «Загрузить своё». */
export function AvatarEditor({
  user,
  onUpdated,
}: {
  user: User | null;
  onUpdated: (user: User) => void;
}) {
  const [open, setOpen] = useState(false),
    [telegramPhoto, setTelegramPhoto] = useState<boolean | null>(null),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null),
    file = useRef<HTMLInputElement>(null);
  // The menu closes on a tap outside it or on Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    // Captured first, so Escape closes only the menu, not the profile window around it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open || telegramPhoto !== null || demo) return;
    api<{ available: boolean }>("/api/me/photo/telegram")
      .then((r) => setTelegramPhoto(r.available))
      // If the check fails, let the person try; the answer will explain.
      .catch(() => setTelegramPhoto(true));
  }, [open, telegramPhoto]);
  async function save(run: () => Promise<{ user: User }>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await run();
      onUpdated(r.user);
      setPreview("");
      setMessage("Фото обновлено");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function picked(f: File | undefined) {
    if (!f) return;
    setError("");
    setMessage("");
    try {
      setPreview(await avatarPhoto(f));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!user) return <span className="avatar large">{initials("Гость")}</span>;
  return (
    <div className="avatar-editor" ref={box}>
      <span className="avatar large">
        {preview ? (
          <img className="avatar-photo" src={preview} alt="" />
        ) : (
          <Face user={user} />
        )}
        <button
          type="button"
          className="avatar-pencil"
          aria-label="Изменить фото"
          title="Изменить фото"
          aria-expanded={open}
          aria-haspopup="menu"
          disabled={busy}
          onClick={() => setOpen(!open)}
        >
          <Pencil size={13} />
        </button>
      </span>
      {open && (
        <div className="avatar-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={busy || demo || telegramPhoto === false}
            onClick={() => {
              setOpen(false);
              void save(() => api("/api/me/photo/telegram", "POST"));
            }}
          >
            <Send size={15} /> Взять из Telegram
          </button>
          {telegramPhoto === false && (
            <small>В Telegram фото скрыто настройками или не установлено</small>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={busy || demo}
            onClick={() => {
              setOpen(false);
              file.current?.click();
            }}
          >
            <Upload size={15} /> Загрузить своё
          </button>
          {demo && <small>В демо фото не меняется</small>}
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void picked(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {preview && (
        <div className="avatar-preview-actions">
          <button
            type="button"
            className="button primary small-button"
            disabled={busy}
            onClick={() =>
              void save(() => api("/api/me/photo", "PUT", { photo: preview }))
            }
          >
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
          <button
            type="button"
            className="button secondary small-button"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            Другое фото
          </button>
        </div>
      )}
      {message && <p className="small-text">{message}</p>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
