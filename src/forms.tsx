import React, { useEffect, useRef, useState } from "react";
import {
  Gift,
  Heart,
  X,
  Check,
  Copy,
  ImagePlus,
  Link as LinkIcon,
  RefreshCw,
  ClipboardPaste,
  Sparkles,
  ImageOff,
  ScanText,
  Users,
} from "lucide-react";
import {
  api,
  compressPhoto,
  compressScreenshot,
  cropPhoto,
  demo,
  photoFromUrl,
  type ProductLookup,
  type ScreenshotLookup,
} from "./api";
import { type Friend, type Wish } from "./types";
import { Hearts } from "./hearts";
import { currencies } from "../shared/price";
import { LookupState } from "./lookup-state";
import {
  DEFAULT_FRAMING,
  PhotoFrame,
  renderFramed,
  type Framing,
} from "./photo-frame";
const modalStack: symbol[] = [];
let originalBodyOverflow = "";
export function Modal({
  title,
  onClose,
  children,
  wide,
  closeOnBackdrop = true,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  closeOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = React.useId();
  useEffect(() => {
    const modalId = Symbol();
    if (!modalStack.length) originalBodyOverflow = document.body.style.overflow;
    modalStack.push(modalId);
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement;
    dialog?.focus();
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== modalId) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
      if (e.key !== "Tab" || !dialog) return;
      const a = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      );
      const first = a[0],
        last = a[a.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || document.activeElement === dialog)
      ) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      modalStack.splice(modalStack.indexOf(modalId), 1);
      document.removeEventListener("keydown", key);
      if (!modalStack.length)
        document.body.style.overflow = originalBodyOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
/** In-app confirmation: window.confirm is unreliable inside Telegram WebViews. */
export function Confirm({
  title = "Подтвердите действие",
  text,
  action,
  danger,
  onConfirm,
  onCancel,
}: {
  title?: string;
  text: string;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="muted">{text}</p>
      <div className="confirm-actions">
        <button className="button secondary" onClick={onCancel}>
          Отмена
        </button>
        <button
          className={`button primary ${danger ? "danger-fill" : ""}`}
          onClick={onConfirm}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}
const amountRe = /^\d{1,9}([.,]\d{1,2})?$/;
function toMinor(value: string, label: string) {
  const v = value.trim().replace(/\s/g, "");
  if (!v) return null;
  if (!amountRe.test(v))
    throw new Error(`${label}: укажите число, до двух знаков после запятой.`);
  return Math.round(Number(v.replace(",", ".")) * 100);
}
const fromMinor = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : String(v / 100);
function isHttps(v: string) {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}
/** Shops read through the home helper (see worker/helper.ts). */
const SLOW_SHOPS =
  /^https:\/\/([^/]+\.)?(ozon\.(ru|by|kz)|dns-shop\.(ru|kz)|market\.yandex\.(ru|by|kz|uz)|aliexpress\.ru)\//i;
export function GiftForm({
  gift,
  onSaved,
  onDirty,
  onSavingChange,
}: {
  gift: Wish | null;
  onSaved: () => void;
  onDirty: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [framing, setFraming] = useState<Framing>(DEFAULT_FRAMING),
    framingTouched = useRef(false),
    // The editor needs pixels: pictures stored as links are loaded through the API.
    [editSrc, setEditSrc] = useState("");
  const [photo, setPhoto] = useState(""),
    [photoLoading, setPhotoLoading] = useState(!!gift?.has_photo),
    [photoError, setPhotoError] = useState(false),
    [photoNote, setPhotoNote] = useState(""),
    [imageUrl, setImageUrl] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);
  const [title, setTitle] = useState(gift?.title || ""),
    [shopUrl, setShopUrl] = useState(gift?.shop_url || ""),
    [description, setDescription] = useState(gift?.description || ""),
    [priority, setPriority] = useState(gift?.priority || 3),
    [currency, setCurrency] = useState(gift?.currency || "EUR");
  const [priceMode, setPriceMode] = useState<"exact" | "range">(
      gift?.price_range ? "range" : "exact",
    ),
    [priceMin, setPriceMin] = useState(fromMinor(gift?.price_minor)),
    [priceMax, setPriceMax] = useState(fromMinor(gift?.price_max_minor)),
    [priceTouched, setPriceTouched] = useState(
      gift?.price_minor != null || gift?.price_max_minor != null,
    );
  const [lookup, setLookup] = useState<"idle" | "loading">("idle"),
    [shot, setShot] = useState<"idle" | "loading">("idle"),
    [lookupNote, setLookupNote] = useState(""),
    lastLookup = useRef(gift?.shop_url || "");
  const gate = useRef(new LookupState()),
    photoRequest = useRef(0);
  const photoIsLookup = useRef(false);
  const autoTitle = useRef(false),
    autoDescription = useRef(false),
    autoPhoto = useRef(false);
  const draft = useRef({
    title,
    description,
    priceTouched,
    priceMin,
    priceMax,
    photo,
    photoLoading,
  });
  draft.current = {
    title,
    description,
    priceTouched,
    priceMin,
    priceMax,
    photo,
    photoLoading,
  };
  useEffect(
    () => () => {
      gate.current.invalidate();
      ++photoRequest.current;
    },
    [],
  );
  useEffect(() => {
    if (demo) {
      setPhoto(gift?.photo || "");
      setPhotoLoading(false);
      return;
    }
    const photoId = photoRequest.current;
    if (gift?.has_photo)
      void api(`/api/gifts/${gift.id}/photo`)
        .then((d) => {
          if (photoId === photoRequest.current) setPhoto(d.photo);
        })
        .catch((e) => {
          if (photoId !== photoRequest.current) return;
          setError(e.message);
          setPhotoError(true);
        })
        .finally(() => {
          if (photoId === photoRequest.current) setPhotoLoading(false);
        });
  }, [gift]);
  useEffect(() => {
    let alive = true;
    setEditSrc("");
    if (photo.startsWith("data:")) setEditSrc(photo);
    else if (/^https:\/\//.test(photo))
      photoFromUrl(photo)
        .then((data) => alive && setEditSrc(data))
        .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [photo]);
  async function applyPhoto(
    load: () => Promise<string>,
    failNote: string,
    valid?: () => boolean,
  ) {
    if (!valid) {
      gate.current.edit("photo");
      autoPhoto.current = false;
    }
    const id = ++photoRequest.current;
    photoIsLookup.current = !!valid;
    setPhotoLoading(true);
    try {
      const value = await load();
      if (id !== photoRequest.current || (valid && !valid())) return false;
      onDirty();
      setPhoto(value);
      setFraming(DEFAULT_FRAMING);
      framingTouched.current = false;
      setPhotoError(false);
      setPhotoNote("");
      return true;
    } catch (err) {
      if (id === photoRequest.current && (!valid || valid()))
        setPhotoNote((err as Error).message || failNote);
      return false;
    } finally {
      if (id === photoRequest.current) {
        photoIsLookup.current = false;
        setPhotoLoading(false);
      }
    }
  }
  async function fillFromLink(url: string) {
    if (!isHttps(url)) return;
    lastLookup.current = url;
    if (demo) {
      setLookupNote("В демо данные по ссылке не загружаются.");
      return;
    }
    setLookup("loading");
    setLookupNote("");
    const current = draft.current;
    const job = gate.current.begin({
      title: !current.title.trim(),
      description: !current.description.trim(),
      price: !current.priceTouched || (!current.priceMin && !current.priceMax),
      photo: !current.photo && !current.photoLoading && !gift?.has_photo,
    });
    try {
      // Shops read through the home helper can take up to ~30 seconds.
      const r = await api<ProductLookup>(
        "/api/fetch/product",
        "POST",
        { url },
        45000,
      );
      if (!job.current()) return;
      const notes: string[] = [];
      if (r.title && job.canApply("title")) {
        setTitle(r.title.slice(0, 120));
        autoTitle.current = true;
        // Brand, model, colour and sizes from the full shop title.
        if (r.details && job.canApply("description")) {
          setDescription(r.details.slice(0, 2000));
          autoDescription.current = true;
        }
      }
      if (r.price && job.canApply("price")) {
        const range = r.price.max_minor !== null;
        setPriceMode(range ? "range" : "exact");
        setPriceMin(fromMinor(r.price.min_minor));
        setPriceMax(range ? fromMinor(r.price.max_minor) : "");
        if ((currencies as readonly string[]).includes(r.price.currency))
          setCurrency(r.price.currency);
        setPriceTouched(false);
      } else if (!r.price)
        notes.push(
          r.unavailable
            ? "Товара нет в наличии — магазин не вернул цену."
            : "Цену получить не удалось — введите её вручную.",
        );
      if (r.image_url && job.canApply("photo")) {
        const ok = await applyPhoto(
          () => photoFromUrl(r.image_url),
          "Не удалось загрузить картинку.",
          () => job.canApply("photo"),
        );
        if (!job.current()) return;
        if (ok) autoPhoto.current = true;
        // applyPhoto keeps the actual network/decoder/compression error visible.
      } else if (!r.image_url && job.canApply("photo"))
        setPhotoNote(
          "Картинку с сайта получить не удалось — добавьте фото вручную.",
        );
      if (r.blocked && r.helper_offline)
        notes.unshift(
          `${r.shop || "Магазин"} открывается только через домашний помощник, а он сейчас не в сети. Добавьте фото и цену вручную или попробуйте позже.`,
        );
      else if (r.blocked)
        notes.unshift(
          `${r.shop || "Сайт"} ограничил автоматическое чтение. Можно добавить фото и цену вручную.`,
        );
      else if (r.price || r.image_url)
        notes.unshift(
          `Нашли данные${r.shop ? ` на ${r.shop}` : ""}. Проверьте цену и вариант товара: регион и скидки могут отличаться.`,
        );
      if (!job.current()) return;
      setLookupNote(notes.join(" "));
      lastLookup.current = r.url;
      setShopUrl(r.url);
    } catch (err) {
      if (job.current())
        setLookupNote(
          `${(err as Error).message} Заполните цену и фото вручную.`,
        );
    } finally {
      if (job.current()) setLookup("idle");
    }
  }
  /** «Добавить скриншот»: the vision model reads name, price and photo frame. */
  async function fillFromScreenshot(file: File) {
    if (demo) {
      setLookupNote("В демо скриншоты не распознаются.");
      return;
    }
    setShot("loading");
    setLookupNote("");
    const current = draft.current;
    const job = gate.current.begin({
      title: !current.title.trim(),
      description: !current.description.trim(),
      price: !current.priceTouched || (!current.priceMin && !current.priceMax),
      photo: !current.photo && !current.photoLoading && !gift?.has_photo,
    });
    try {
      const image = await compressScreenshot(file);
      const r = await api<ScreenshotLookup>(
        "/api/fetch/screenshot",
        "POST",
        { image },
        45000,
      );
      if (!job.current()) return;
      const notes: string[] = [];
      if (r.title && job.canApply("title")) {
        setTitle(r.title.slice(0, 120));
        autoTitle.current = true;
        if (r.details && job.canApply("description")) {
          setDescription(r.details.slice(0, 2000));
          autoDescription.current = true;
        }
      }
      if (r.price && job.canApply("price")) {
        const range = r.price.max_minor !== null;
        setPriceMode(range ? "range" : "exact");
        setPriceMin(fromMinor(r.price.min_minor));
        setPriceMax(range ? fromMinor(r.price.max_minor) : "");
        if ((currencies as readonly string[]).includes(r.price.currency))
          setCurrency(r.price.currency);
        setPriceTouched(false);
      } else if (!r.price)
        notes.push("Цену на скриншоте не нашли — введите её вручную.");
      if (job.canApply("photo")) {
        const box = r.photo_box;
        const ok = await applyPhoto(
          () => (box ? cropPhoto(file, box) : compressPhoto(file)),
          "Не удалось вырезать фото со скриншота.",
          () => job.canApply("photo"),
        );
        if (!job.current()) return;
        if (ok) {
          autoPhoto.current = true;
          notes.push(
            box
              ? "Фото вырезали со скриншота — если рамка неточная, подвиньте его или замените."
              : "Фото товара не нашли, поставили весь скриншот — подвиньте рамку или замените фото.",
          );
        }
      }
      notes.unshift(
        `Распознали скриншот${r.shop ? ` (${r.shop})` : ""}. Проверьте название и цену: нейросеть может ошибиться.`,
      );
      setLookupNote(notes.join(" "));
    } catch (err) {
      if (job.current())
        setLookupNote(`${(err as Error).message} Заполните поля вручную.`);
    } finally {
      if (job.current()) setShot("idle");
    }
  }
  // Look the link up shortly after it is pasted or typed.
  useEffect(() => {
    const url = shopUrl.trim();
    if (!isHttps(url) || url === lastLookup.current) return;
    const t = setTimeout(() => void fillFromLink(url), 700);
    return () => clearTimeout(t);
  }, [shopUrl]);
  async function pastedImage(files: FileList | File[]) {
    const file = Array.from(files).find((f) => f.type.startsWith("image/"));
    if (!file) return false;
    await applyPhoto(
      () => compressPhoto(file),
      "Не удалось вставить картинку.",
    );
    return true;
  }
  async function pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          const blob = await item.getType(type);
          await applyPhoto(
            () => compressPhoto(blob),
            "Не удалось вставить картинку.",
          );
          return;
        }
      }
      const text = (await navigator.clipboard.readText()).trim();
      if (isHttps(text)) {
        setImageUrl(text);
        await applyPhoto(
          () => photoFromUrl(text),
          "Не удалось загрузить картинку.",
        );
      } else setPhotoNote("В буфере обмена нет картинки.");
    } catch {
      setPhotoNote("Браузер не дал доступ к буферу. Нажмите Ctrl+V в форме.");
    }
  }
  return (
    <form
      onChange={onDirty}
      onPaste={(e) => {
        if (e.clipboardData.files.length) {
          onDirty();
          e.preventDefault();
          void pastedImage(e.clipboardData.files);
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (demo) {
          setError(
            "Это демо: форму можно попробовать, но желание не сохранится.",
          );
          return;
        }
        setSaving(true);
        setError("");
        try {
          const min = toMinor(
              priceMin,
              priceMode === "range" ? "Цена «от»" : "Цена",
            ),
            max = priceMode === "range" ? toMinor(priceMax, "Цена «до»") : null;
          if (min !== null && max !== null && max < min)
            throw new Error("Цена «до» должна быть больше цены «от».");
          const saved =
            framingTouched.current && editSrc
              ? await renderFramed(editSrc, framing)
              : photo;
          await api(
            gift ? `/api/gifts/${gift.id}` : "/api/gifts",
            gift ? "PUT" : "POST",
            {
              title,
              price_minor: min,
              price_max_minor: max,
              price_range: priceMode === "range",
              currency,
              shop_url: shopUrl.trim(),
              description,
              priority: Number(priority),
              photo: saved,
            },
          );
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        Ссылка на магазин
        <div className="input-with-action">
          <input
            name="shop_url"
            type="url"
            maxLength={2048}
            value={shopUrl}
            onChange={(e) => {
              gate.current.invalidate();
              setLookup("idle");
              setLookupNote("");
              if (photoIsLookup.current) {
                ++photoRequest.current;
                photoIsLookup.current = false;
                setPhotoLoading(false);
              }
              if (autoTitle.current) {
                setTitle("");
                autoTitle.current = false;
              }
              if (autoDescription.current) {
                setDescription("");
                autoDescription.current = false;
              }
              if (!draft.current.priceTouched) {
                setPriceMin("");
                setPriceMax("");
              }
              if (autoPhoto.current) {
                onDirty();
                setPhoto("");
                autoPhoto.current = false;
              }
              setShopUrl(e.target.value);
            }}
            placeholder="https://… — попробуем найти цену и фото"
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Подтянуть данные по ссылке"
            title="Подтянуть данные по ссылке"
            disabled={!isHttps(shopUrl.trim()) || lookup === "loading"}
            onClick={() => void fillFromLink(shopUrl.trim())}
          >
            <RefreshCw
              size={17}
              className={lookup === "loading" ? "spin" : ""}
            />
          </button>
        </div>
      </label>
      <div className="screenshot-row">
        <label
          className={`button secondary file-link${shot === "loading" ? " busy" : ""}`}
        >
          <ScanText size={16} className={shot === "loading" ? "spin" : ""} />
          {shot === "loading" ? "Читаем скриншот…" : "Добавить скриншот"}
          <input
            type="file"
            accept="image/*"
            aria-label="Выбрать скриншот товара"
            disabled={shot === "loading" || saving}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void fillFromScreenshot(file);
            }}
          />
        </label>
        <span>
          Ссылка не сработала? Заполним название, цену и фото по скриншоту
          товара.
        </span>
      </div>
      {(lookup === "loading" || shot === "loading" || lookupNote) && (
        <p className="lookup-note" role="status">
          <Sparkles size={14} />
          {shot === "loading"
            ? "Нейросеть читает скриншот, это занимает 5–15 секунд…"
            : lookup === "loading"
              ? SLOW_SHOPS.test(shopUrl)
                ? "Открываем страницу через домашний помощник, это может занять до 30 секунд…"
                : "Ищем цену и картинку…"
              : lookupNote}
        </p>
      )}
      {photo ? (
        editSrc ? (
          <PhotoFrame
            src={editSrc}
            framing={framing}
            onChange={(f) => {
              gate.current.edit("photo");
              autoPhoto.current = false;
              framingTouched.current = true;
              setFraming(f);
              onDirty();
            }}
          />
        ) : (
          <div className="photo-frame">
            <img
              className="photo-frame-canvas"
              src={photo}
              alt="Фото подарка"
            />
          </div>
        )
      ) : (
        <label className="photo-upload">
          {photoNote && !photoLoading ? (
            <span className="photo-fallback">
              <ImageOff size={27} />
              <strong>Нет картинки</strong>
              <span>Выберите файл, вставьте Ctrl+V или ссылку на картинку</span>
            </span>
          ) : (
            <>
              <ImagePlus size={27} />
              <strong>
                {photoLoading ? "Готовим фото…" : "Добавить фотографию"}
              </strong>
              <span>Файл, Ctrl+V или ссылка · сожмём автоматически</span>
            </>
          )}
          <input
            type="file"
            accept="image/*"
            aria-label="Выбрать фотографию"
            disabled={photoLoading || saving}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await applyPhoto(
                () => compressPhoto(file),
                "Не удалось открыть фото.",
              );
            }}
          />
        </label>
      )}
      {photoNote && (
        <p className="photo-note" role="status">
          {photoNote}
        </p>
      )}
      <div className="photo-tools">
        <button
          type="button"
          className="text-link"
          disabled={photoLoading}
          onClick={() => void pasteFromClipboard()}
        >
          <ClipboardPaste size={15} />
          Вставить из буфера
        </button>
        {photo && (
          <label className="text-link file-link">
            <ImagePlus size={15} />
            Заменить фото
            <input
              type="file"
              accept="image/*"
              aria-label="Выбрать другую фотографию"
              disabled={photoLoading || saving}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                await applyPhoto(
                  () => compressPhoto(file),
                  "Не удалось открыть фото.",
                );
              }}
            />
          </label>
        )}
        {photo && (
          <button
            type="button"
            className="text-link"
            onClick={() => {
              gate.current.edit("photo");
              ++photoRequest.current;
              autoPhoto.current = false;
              setPhotoLoading(false);
              onDirty();
              setPhoto("");
            }}
          >
            Убрать фото
          </button>
        )}
      </div>
      <div className="input-with-action">
        <input
          aria-label="Ссылка на картинку"
          type="url"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="Или ссылка на картинку: https://…/photo.jpg"
        />
        <button
          type="button"
          className="button secondary"
          disabled={!isHttps(imageUrl.trim()) || photoLoading}
          onClick={() =>
            void applyPhoto(
              () => photoFromUrl(imageUrl.trim()),
              "Не удалось загрузить картинку.",
            )
          }
        >
          Загрузить
        </button>
      </div>
      <label>
        Название желания
        <input
          name="title"
          required
          maxLength={120}
          value={title}
          onChange={(e) => {
            gate.current.edit("title");
            autoTitle.current = false;
            setTitle(e.target.value);
          }}
          placeholder="Например, беспроводные наушники"
        />
      </label>
      <div className="price-field">
        <div className="price-heading">
          <span>Цена</span>
          <div className="segmented small" role="group" aria-label="Тип цены">
            <button
              type="button"
              className={priceMode === "exact" ? "selected" : ""}
              aria-pressed={priceMode === "exact"}
              onClick={() => {
                gate.current.edit("price");
                setPriceTouched(true);
                onDirty();
                setPriceMode("exact");
              }}
            >
              Точная
            </button>
            <button
              type="button"
              className={priceMode === "range" ? "selected" : ""}
              aria-pressed={priceMode === "range"}
              onClick={() => {
                gate.current.edit("price");
                setPriceTouched(true);
                onDirty();
                setPriceMode("range");
              }}
            >
              От – до
            </button>
          </div>
        </div>
        <div className="form-row price-row">
          <input
            aria-label={priceMode === "range" ? "Цена от" : "Цена"}
            inputMode="decimal"
            value={priceMin}
            onChange={(e) => {
              gate.current.edit("price");
              setPriceMin(e.target.value);
              setPriceTouched(true);
            }}
            placeholder={priceMode === "range" ? "от" : "Необязательно"}
          />
          {priceMode === "range" && (
            <input
              aria-label="Цена до"
              inputMode="decimal"
              value={priceMax}
              onChange={(e) => {
                gate.current.edit("price");
                setPriceMax(e.target.value);
                setPriceTouched(true);
              }}
              placeholder="до"
            />
          )}
          <select
            aria-label="Валюта"
            value={currency}
            onChange={(e) => {
              gate.current.edit("price");
              setPriceTouched(true);
              setCurrency(e.target.value);
            }}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <label>
        Комментарий
        <textarea
          name="description"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(e) => {
            gate.current.edit("description");
            autoDescription.current = false;
            setDescription(e.target.value);
          }}
          placeholder="Цвет, размер или другие важные детали"
        />
      </label>
      <div className="field">
        <span>Насколько хочется</span>
        <Hearts value={priority} onChange={setPriority} size={24} />
        <span className="small-text">
          Чем больше сердечек, тем сильнее хочется.
        </span>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary full-width"
        disabled={
          saving ||
          lookup === "loading" ||
          shot === "loading" ||
          photoLoading ||
          photoError
        }
      >
        {saving ? (
          "Сохраняем…"
        ) : (
          <>
            <Heart size={17} />
            Сохранить желание
          </>
        )}
      </button>
    </form>
  );
}
export function CopyValue({
  value,
  warning,
}: {
  value: string;
  warning?: string;
}) {
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [copyError, setCopyError] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError("");
      setConfirmCopy(false);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError(
        "Не удалось скопировать. Выделите ссылку и скопируйте вручную.",
      );
    }
  }
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="copy-value">
        <input
          readOnly
          value={value}
          aria-label="Ссылка или код для копирования"
          onFocus={(e) => e.target.select()}
          onCopy={
            warning
              ? (e) => {
                  e.preventDefault();
                  setConfirmCopy(true);
                }
              : undefined
          }
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Скопировать"
          onClick={() => {
            if (warning) setConfirmCopy(true);
            else void copy();
          }}
        >
          {copied ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
      {copyError && <p role="alert">{copyError}</p>}
      {confirmCopy && (
        <Confirm
          title="Перед копированием"
          text={warning!}
          action="Скопировать ссылку"
          onCancel={() => setConfirmCopy(false)}
          onConfirm={() => void copy()}
        />
      )}
    </>
  );
}
export function Share({
  ownerId,
  own = true,
}: {
  ownerId?: string;
  own?: boolean;
}) {
  const endpoint = ownerId
    ? `/api/lists/${ownerId}/share-links`
    : "/api/guest-links";
  const [links, setLinks] = useState<
    { id: string; kind: string; web_url: string }[]
  >([]);
  const [error, setError] = useState("");
  const [legacy, setLegacy] = useState<{ id: string }[]>([]);
  useEffect(() => {
    api(endpoint)
      .then((d) => (d.links.length === 2 ? d : api(endpoint, "POST")))
      .then((d) => {
        setLinks(d.links);
        setLegacy(d.legacy_links || []);
      })
      .catch((e) => setError(e.message));
  }, [endpoint]);
  return (
    <div className="share-result">
      <p>Ссылки действуют постоянно.</p>
      {error && <p role="alert">{error}</p>}
      {legacy.map((link) => (
        <div className="active-link" key={link.id}>
          <span>Ранее созданная ссылка без входа</span>
          <button
            className="text-link danger"
            onClick={async () => {
              if (!window.confirm("Отозвать старую ссылку без входа?")) return;
              try {
                await api(`/api/guest-links/${link.id}`, "DELETE");
                setLegacy(legacy.filter((l) => l.id !== link.id));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Отозвать
          </button>
        </div>
      ))}
      {links.map((link) => (
        <section key={link.id}>
          <h3>
            {link.kind === "telegram"
              ? "С входом через Telegram"
              : "Для близких без регистрации"}
          </h3>
          <p>
            {link.kind === "telegram"
              ? "Просмотр и бронирование после входа через Telegram."
              : "Вход в Telegram не нужен. Для брони достаточно имени."}
          </p>
          <CopyValue
            value={link.web_url}
            warning={
              link.kind === "guest" && own
                ? "По этой ссылке видны все подарки и брони. Не открывайте её сами, если хотите сохранить сюрприз."
                : undefined
            }
          />
          <button
            className="text-link danger"
            onClick={async () => {
              if (
                !window.confirm(
                  "Отозвать ссылку? Люди со старой ссылкой потеряют доступ.",
                )
              )
                return;
              try {
                await api(`/api/guest-links/${link.id}`, "DELETE");
                setLinks(links.filter((l) => l.id !== link.id));
                setLinks((await api(endpoint, "POST")).links);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Заменить ссылку
          </button>
        </section>
      ))}
    </div>
  );
}
export function ArchiveWish({
  gift,
  onClose,
  onArchived,
}: {
  gift: Wish;
  onClose: () => void;
  onArchived: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Отправить желание в архив"
      closeOnBackdrop={false}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="share-result"
        onSubmit={async (e) => {
          e.preventDefault();
          if (demo) {
            setError("В демо архив не меняется.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            await api(`/api/gifts/${gift.id}/archive`, "POST", { reason });
            await onArchived();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>{gift.title}</h3>
        <p>Почему убираете желание из списка?</p>
        <div className="archive-reasons">
          {[
            ["changed_mind", "Передумал"],
            ["gifted", "Подарили"],
            ["bought_self", "Купил сам"],
          ].map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="archive-reason"
                value={value}
                checked={reason === value}
                disabled={busy}
                onChange={() => {
                  setReason(value);
                  setError("");
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="small-text">
          Если кто-то из друзей выбрал этот подарок, бот сообщит ему. Кто это,
          вы не узнаете.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary full-width"
          disabled={busy || !reason}
        >
          {busy ? "Переносим…" : "Перенести в архив"}
        </button>
      </form>
    </Modal>
  );
}
/**
 * «Забронировать»: give alone or together with friends. With `invite` the
 * organizer adds more friends to a booking that already exists.
 */
export function ReserveDialog({
  gift,
  ownerId,
  friends,
  exclude = [],
  invite = false,
  onClose,
  onDone,
}: {
  gift: { id: string; title: string };
  ownerId: string;
  friends: Friend[];
  exclude?: string[];
  invite?: boolean;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [together, setTogether] = useState(invite);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = friends.filter(
    (f) => f.id !== ownerId && !exclude.includes(f.id),
  );
  async function submit(withFriends: string[]) {
    if (demo) {
      setError("Бронирование доступно после подключения приложения.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (invite)
        await api(`/api/gifts/${gift.id}/reservation/invite`, "POST", {
          friends: withFriends,
        });
      else
        await api(
          `/api/gifts/${gift.id}/reservation`,
          "POST",
          withFriends.length ? { friends: withFriends } : {},
        );
      await onDone(
        withFriends.length
          ? invite
            ? "Приглашения отправлены в Telegram"
            : "Подарок забронирован, друзьям ушли приглашения"
          : "Подарок забронирован",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={invite ? "Пригласить друзей" : "Забронировать подарок"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="share-result">
        <h3>{gift.title}</h3>
        {!together ? (
          <div className="reserve-choice">
            <button
              className="button primary full-width"
              disabled={busy}
              onClick={() => void submit([])}
            >
              <Gift size={17} /> Подарю сам(а)
            </button>
            <button
              className="button secondary full-width"
              disabled={busy}
              onClick={() => setTogether(true)}
            >
              <Users size={17} /> Подарить вместе с друзьями
            </button>
            <p className="small-text">
              Владелец вишлиста не узнает, кто забронировал подарок.
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(picked);
            }}
          >
            <p>
              Кого позвать скинуться? Бот пришлёт им приглашение, а они ответят
              «Участвую» или «Не могу».
            </p>
            {candidates.length ? (
              <div className="friend-picker">
                {candidates.map((f) => (
                  <label key={f.id} className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={picked.includes(f.id)}
                      disabled={
                        busy || (!picked.includes(f.id) && picked.length >= 10)
                      }
                      onChange={(e) =>
                        setPicked(
                          e.target.checked
                            ? [...picked, f.id]
                            : picked.filter((id) => id !== f.id),
                        )
                      }
                    />
                    {f.name}
                    {f.username ? ` · @${f.username}` : ""}
                  </label>
                ))}
              </div>
            ) : (
              <p className="small-text">
                Пока некого позвать: добавьте друзей во вкладке «Друзья».
              </p>
            )}
            <button
              className="button primary full-width"
              disabled={busy || !picked.length}
            >
              {busy
                ? "Отправляем…"
                : invite
                  ? "Пригласить"
                  : "Забронировать и пригласить"}
            </button>
            {!invite && (
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => setTogether(false)}
              >
                Назад
              </button>
            )}
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
