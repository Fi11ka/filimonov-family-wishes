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
  Share2,
  ArrowUpRight,
} from "lucide-react";
import {
  api,
  compressPhoto,
  compressScreenshot,
  cropPhoto,
  demo,
  photoFromUrl,
  RequestError,
  savedGuestName,
  saveGuestName,
  type ProductLookup,
  type ScreenshotLookup,
} from "./api";
import { type Friend, type ListRef, type Wish } from "./types";
import { giftPhoto } from "./gift-photo";
import { Hearts } from "./hearts";
import { currencies, formatPrice, isCurrency } from "../shared/price";
import { LookupState } from "./lookup-state";
import { currentSite, shareLink, siteProfileLink } from "./share-links";
import { WishPicker } from "./wish-picker";
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
  cancel = "Отмена",
  danger,
  option,
  alternative,
  onConfirm,
  onCancel,
}: {
  /** Another way out besides the action, e.g. «В архив» instead of deleting. */
  alternative?: { label: string; run: () => void };
  title?: string;
  text: string;
  action: string;
  /** The button that keeps things as they are. */
  cancel?: string;
  danger?: boolean;
  /** A checkbox that goes with the action, ticked at first. */
  option?: string;
  onConfirm: (option: boolean) => void;
  onCancel: () => void;
}) {
  const [ticked, setTicked] = useState(true);
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="muted">{text}</p>
      {option && (
        <label className="setting-toggle confirm-option">
          <input
            type="checkbox"
            checked={ticked}
            onChange={(e) => setTicked(e.target.checked)}
          />
          <span>{option}</span>
        </label>
      )}
      <div className="confirm-actions">
        {alternative && (
          <button className="button primary" onClick={alternative.run}>
            {alternative.label}
          </button>
        )}
        <button className="button secondary" onClick={onCancel}>
          {cancel}
        </button>
        <button
          className={`button primary ${danger ? "danger-fill" : ""}`}
          onClick={() => onConfirm(!!option && ticked)}
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
/** The currency of the last saved wish: a new wish starts with it. */
const CURRENCY_KEY = "fw:currency";
function savedCurrency() {
  try {
    const c = localStorage.getItem(CURRENCY_KEY) || "";
    return isCurrency(c) ? c : "";
  } catch {
    return "";
  }
}
const ACTIVE_LIMIT = 100;
/**
 * The wish form (П26): link first to fill the rest, then title, price with its
 * currency and a compact photo button; the hint and hearts fold away under
 * «Дополнительно». The photo is prepared on a screen of its own. Nothing that
 * loads (the link, the photo) holds back «Сохранить».
 */
export function GiftForm({
  gift,
  list = null,
  activeCount = 0,
  onSaved,
  onDirty,
  onSavingChange,
}: {
  gift: Wish | null;
  /** A new wish for a list kept for someone close, fixed when the form opens. */
  list?: ListRef | null;
  /** Wishes already in the list, for «Осталось мест» and the limit. */
  activeCount?: number;
  onSaved: (id?: string) => void;
  onDirty: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [framing, setFraming] = useState<Framing>(DEFAULT_FRAMING),
    framingTouched = useRef(false),
    // The editor needs pixels: pictures stored as links are loaded through the API.
    [editSrc, setEditSrc] = useState("");
  const [photo, setPhoto] = useState(""),
    [photoLoading, setPhotoLoading] = useState(!!gift?.has_photo),
    [photoNote, setPhotoNote] = useState(""),
    [imageUrl, setImageUrl] = useState(""),
    [urlOpen, setUrlOpen] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [fieldErrors, setFieldErrors] = useState<{ price?: string }>({}),
    // The photo screen; what the photo was when it opened, for «Отмена».
    [photoEditor, setPhotoEditor] = useState(false),
    editorStart = useRef<{
      photo: string;
      framing: Framing;
      touched: boolean;
      changed: boolean;
    } | null>(null),
    // Set once the photo is replaced, removed or reframed: otherwise a stored
    // photo that has not loaded yet is kept as it is.
    photoChanged = useRef(false);
  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);
  const [title, setTitle] = useState(gift?.title || ""),
    [shopUrl, setShopUrl] = useState(gift?.shop_url || ""),
    [description, setDescription] = useState(gift?.description || ""),
    [priority, setPriority] = useState(gift?.priority || 3),
    [currency, setCurrency] = useState(
      gift?.currency || savedCurrency() || "EUR",
    );
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
      // Usually already loaded by the card; asked for at once otherwise.
      void giftPhoto(gift.id, gift.updated_at, true)
        .then((p) => {
          if (photoId === photoRequest.current) setPhoto(p);
        })
        .catch(() => {
          // Saving still works: the stored photo stays as it is.
          if (photoId === photoRequest.current)
            setPhotoNote(
              "Фото не загрузилось. Остальное можно сохранить — фото останется прежним.",
            );
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
      photoChanged.current = true;
      setPhoto(value);
      setFraming(DEFAULT_FRAMING);
      framingTouched.current = false;
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
        if (isCurrency(r.price.currency)) setCurrency(r.price.currency);
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
  async function fillFromScreenshot(file: Blob) {
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
        if (isCurrency(r.price.currency)) setCurrency(r.price.currency);
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
  async function pasteScreenshot() {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type)
          return void (await fillFromScreenshot(await item.getType(type)));
      }
      setLookupNote(
        "В буфере обмена нет картинки. Сделайте скриншот карточки товара и попробуйте снова.",
      );
    } catch {
      setLookupNote(
        "Браузер не дал доступ к буферу. Нажмите в поле ссылки и вставьте скриншот: Ctrl+V или долгое нажатие → «Вставить».",
      );
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
  const left = ACTIVE_LIMIT - activeCount;
  const full = !gift && left <= 0;
  function openPhotoEditor() {
    editorStart.current = {
      photo,
      framing,
      touched: framingTouched.current,
      changed: photoChanged.current,
    };
    setPhotoEditor(true);
  }
  function closePhotoEditor(apply: boolean) {
    const start = editorStart.current;
    if (!apply && start) {
      // «Отмена»: the photo as it was before the screen opened.
      ++photoRequest.current;
      setPhotoLoading(false);
      setPhoto(start.photo);
      setFraming(start.framing);
      framingTouched.current = start.touched;
      photoChanged.current = start.changed;
    }
    editorStart.current = null;
    setPhotoEditor(false);
  }
  const photoFile = (label: string, text: React.ReactNode) => (
    <label className="text-link file-link">
      <ImagePlus size={15} />
      {text}
      <input
        type="file"
        accept="image/*"
        aria-label={label}
        disabled={photoLoading || saving}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          await applyPhoto(() => compressPhoto(file), "Не удалось открыть фото.");
        }}
      />
    </label>
  );
  return (
    <form
      className={`gift-form${photoEditor ? " editing-photo" : ""}`}
      onChange={onDirty}
      onPaste={(e) => {
        if (e.clipboardData.files.length) {
          onDirty();
          e.preventDefault();
          // An image pasted into the link field is a product screenshot to read.
          const shotFile = Array.from(e.clipboardData.files).find((f) =>
            f.type.startsWith("image/"),
          );
          if (
            shotFile &&
            (e.target as HTMLElement).getAttribute("name") === "shop_url"
          ) {
            if (shot !== "loading") void fillFromScreenshot(shotFile);
          } else void pastedImage(e.clipboardData.files);
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (photoEditor) return;
        if (demo) {
          setError(
            "Это демо: форму можно попробовать, но желание не сохранится.",
          );
          return;
        }
        setError("");
        setFieldErrors({});
        let min: number | null, max: number | null;
        try {
          min = toMinor(priceMin, priceMode === "range" ? "Цена «от»" : "Цена");
          max = priceMode === "range" ? toMinor(priceMax, "Цена «до»") : null;
          if (min !== null && max !== null && max < min)
            throw new Error("Цена «до» должна быть больше цены «от».");
        } catch (err) {
          setFieldErrors({ price: (err as Error).message });
          return;
        }
        setSaving(true);
        try {
          // A stored photo that has not loaded (or failed to) stays as it is.
          const keepPhoto =
            !!gift?.has_photo && !photoChanged.current && !photo;
          const saved =
            framingTouched.current && editSrc
              ? await renderFramed(editSrc, framing)
              : photo;
          const r = await api<{ id?: string }>(
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
              ...(keepPhoto ? { keep_photo: true } : {}),
              ...(!gift && list ? { list_id: list.id } : {}),
            },
          );
          try {
            localStorage.setItem(CURRENCY_KEY, currency);
          } catch {
            // Without storage the next wish starts in euros.
          }
          onSaved(r.id);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      {photoEditor ? (
        <div className="gift-form-body photo-editor">
          <div className="photo-editor-frame">
            {photo ? (
              editSrc ? (
                <PhotoFrame
                  src={editSrc}
                  framing={framing}
                  onChange={(f) => {
                    gate.current.edit("photo");
                    autoPhoto.current = false;
                    framingTouched.current = true;
                    photoChanged.current = true;
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
                    <span>Выберите файл или вставьте картинку</span>
                  </span>
                ) : (
                  <>
                    <ImagePlus size={27} />
                    <strong>
                      {photoLoading ? "Готовим фото…" : "Выбрать фотографию"}
                    </strong>
                    <span>Файл, картинка из буфера или ссылка на неё</span>
                  </>
                )}
                <input
                  type="file"
                  accept="image/*"
                  aria-label="Выбрать фотографию"
                  disabled={photoLoading || saving}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    await applyPhoto(
                      () => compressPhoto(file),
                      "Не удалось открыть фото.",
                    );
                  }}
                />
              </label>
            )}
          </div>
          <div className="photo-editor-tools">
            {photoNote && (
              <p className="photo-note" role="status">
                {photoNote}
              </p>
            )}
            <div className="photo-tools">
              {photo && photoFile("Выбрать другую фотографию", "Заменить фото")}
              <button
                type="button"
                className="text-link"
                disabled={photoLoading}
                onClick={() => void pasteFromClipboard()}
              >
                <ClipboardPaste size={15} />
                Вставить из буфера
              </button>
              {!photo && (
                <button
                  type="button"
                  className="text-link"
                  aria-expanded={urlOpen}
                  onClick={() => setUrlOpen(!urlOpen)}
                >
                  <LinkIcon size={15} />
                  Ссылка на картинку
                </button>
              )}
              {photo && (
                <button
                  type="button"
                  className="text-link danger"
                  onClick={() => {
                    gate.current.edit("photo");
                    ++photoRequest.current;
                    autoPhoto.current = false;
                    photoChanged.current = true;
                    setPhotoLoading(false);
                    onDirty();
                    setPhoto("");
                  }}
                >
                  Удалить фото
                </button>
              )}
            </div>
            {urlOpen && !photo && (
              <div className="input-with-action">
                <input
                  aria-label="Ссылка на картинку"
                  type="url"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://…/photo.jpg"
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
            )}
            {photo && (
              <p className="small-text">
                «Настроить кадр» — подвинуть фото, приблизить, добавить поля и
                выбрать цвет фона.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="gift-form-body">
          {!gift && list && (
            <p className="list-for">
              Для: <strong>{list.name}</strong>
            </p>
          )}
          {!gift && left <= 10 && (
            <p className={full ? "error" : "limit-note"} role="status">
              {full
                ? `В списке может быть не больше ${ACTIVE_LIMIT} желаний. Уберите что-нибудь в архив, чтобы добавить новое.`
                : `Осталось мест: ${left}`}
            </p>
          )}
          <div className="form-section">
            <label>
              <span>
                Ссылка на товар <small className="optional">необязательно</small>
              </span>
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
                  placeholder="https://… — подставим название, цену и фото"
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
            {(lookup === "loading" || shot === "loading" || lookupNote) && (
              <p className="lookup-note" role="status">
                <Sparkles size={14} />
                {shot === "loading"
                  ? "Нейросеть читает скриншот, это занимает 5–15 секунд…"
                  : lookup === "loading"
                    ? SLOW_SHOPS.test(shopUrl)
                      ? "Открываем страницу через домашний помощник, это может занять до 30 секунд. Сохранить можно и сейчас."
                      : "Ищем цену и картинку… Сохранить можно и сейчас."
                    : lookupNote}
              </p>
            )}
            {(lookupNote || shot === "loading") && (
              <div className="screenshot-row">
                <span>Ссылка не открылась?</span>
                <label
                  className={`text-link file-link${shot === "loading" ? " busy" : ""}`}
                >
                  <ScanText
                    size={16}
                    className={shot === "loading" ? "spin" : ""}
                  />
                  {shot === "loading" ? "Читаем скриншот…" : "Скриншот товара"}
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
                <button
                  type="button"
                  className="text-link"
                  disabled={shot === "loading" || saving}
                  onClick={() => void pasteScreenshot()}
                >
                  <ClipboardPaste size={16} />
                  Из буфера
                </button>
              </div>
            )}
          </div>
          <label>
            <span>Название</span>
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
              <span>
                Цена <small className="optional">необязательно</small>
              </span>
              <div
                className="segmented small"
                role="group"
                aria-label="Тип цены"
              >
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
                aria-invalid={!!fieldErrors.price}
                inputMode="decimal"
                value={priceMin}
                onChange={(e) => {
                  gate.current.edit("price");
                  setPriceMin(e.target.value);
                  setPriceTouched(true);
                  setFieldErrors({});
                }}
                placeholder={priceMode === "range" ? "от" : "Сколько стоит"}
              />
              {priceMode === "range" && (
                <input
                  aria-label="Цена до"
                  aria-invalid={!!fieldErrors.price}
                  inputMode="decimal"
                  value={priceMax}
                  onChange={(e) => {
                    gate.current.edit("price");
                    setPriceMax(e.target.value);
                    setPriceTouched(true);
                    setFieldErrors({});
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
            {fieldErrors.price && (
              <p className="field-error" role="alert">
                {fieldErrors.price}
              </p>
            )}
          </div>
          <div className="photo-row">
            {photo ? (
              <img className="photo-thumb" src={photo} alt="" />
            ) : (
              <span className="photo-thumb no-photo">
                {photoLoading ? (
                  <RefreshCw size={18} className="spin" />
                ) : (
                  <ImagePlus size={20} />
                )}
              </span>
            )}
            <button
              type="button"
              className="button secondary"
              onClick={openPhotoEditor}
            >
              {photo || (gift?.has_photo && !photoChanged.current)
                ? "Изменить фото"
                : "Добавить фото"}
            </button>
            {photoLoading && <small className="muted">Готовим фото…</small>}
          </div>
          {photoNote && !photoEditor && (
            <p className="photo-note" role="status">
              {photoNote}
            </p>
          )}
          <details className="more-fields">
            <summary>Дополнительно: подсказка и сердечки</summary>
            <div className="field hearts-field">
              <span>Насколько хочется</span>
              <Hearts value={priority} onChange={setPriority} size={26} />
            </div>
            <label>
              <span>
                Подсказка <small className="optional">необязательно</small>
              </span>
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
          </details>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
      {/* Always visible: no scrolling past the fields to save. */}
      <div className="form-footer">
        {photoEditor ? (
          <>
            <button
              type="button"
              className="button secondary"
              onClick={() => closePhotoEditor(false)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button primary"
              disabled={photoLoading}
              onClick={() => closePhotoEditor(true)}
            >
              Применить
            </button>
          </>
        ) : (
          <button className="button primary" disabled={saving || full}>
            {saving ? (
              "Сохраняем…"
            ) : (
              <>
                <Heart size={17} />
                Сохранить желание
              </>
            )}
          </button>
        )}
      </div>
    </form>
  );
}
type GuestLink = {
  id: string;
  kind: string;
  web_url: string;
  list_id: string | null;
  list_name: string | null;
  picked: boolean;
  count: number | null;
};
type GuestLinks = {
  profile_url: string;
  links: GuestLink[];
  legacy_links?: { id: string }[];
  web_url?: string;
};
/**
 * The fallback when the system menu is missing: a button, never the address
 * itself (П29). The copied link is the kind that was chosen.
 */
function CopyLink({ url }: { url: string }) {
  const [state, setState] = useState<"" | "copied" | "failed">("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="copy-link">
      <button
        type="button"
        className="button secondary full-width"
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check size={17} /> : <Copy size={17} />}
        {state === "copied"
          ? "Скопировано"
          : state === "failed"
            ? "Скопировать ещё раз"
            : "Скопировать ссылку"}
      </button>
      {state === "failed" && (
        <p className="error" role="alert">
          Не удалось скопировать ссылку. Попробуйте ещё раз.
        </p>
      )}
    </div>
  );
}
/**
 * «Поделиться»: «Поделиться» sends the profile link (wishes after signing in),
 * «Поделиться без входа» a guest link to a simplified list: the whole list by
 * default, or a picked set of its wishes, each set a link of its own (П30).
 * Both go to the site through the system menu. Opening this window creates
 * nothing; revoking and replacing live in the profile. For a list kept for
 * someone close, both links are about that list only.
 */
export function Share({
  ownerId,
  ownerName,
  own = true,
  list = null,
  wishes = [],
}: {
  ownerId?: string;
  ownerName?: string;
  own?: boolean;
  /** A list kept for someone close; null is the owner's own. */
  list?: ListRef | null;
  /** The list's active wishes, to pick from for a guest link. */
  wishes?: Pick<Wish, "id" | "title">[];
}) {
  const [guestUrl, setGuestUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // «Поделиться без входа»: the whole list (null) or the wishes picked with «Готово».
  const [guestStep, setGuestStep] = useState(false);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [picking, setPicking] = useState(false);
  // Where the system menu was not available: the link to copy instead.
  const [fallback, setFallback] = useState<{
    kind: "profile" | "guest";
    url: string;
  } | null>(null);
  const listQuery = list ? `?list=${encodeURIComponent(list.id)}` : "";
  useEffect(() => {
    if (!own || demo) return;
    // Only reads: the whole list's guest link, if there is one, is ready for the
    // click, so the system menu still opens within the person's gesture.
    api<GuestLinks>(`/api/guest-links${listQuery}`)
      .then((d) => setGuestUrl(d.web_url || ""))
      .catch(() => undefined);
  }, [own, listQuery]);
  async function send(kind: "profile" | "guest") {
    setError("");
    setFallback(null);
    if (demo) {
      setError("В демо ссылки не создаются.");
      return;
    }
    let url = "";
    if (kind === "profile") {
      if (!ownerId) return;
      url = siteProfileLink(currentSite(), ownerId, list?.id);
    } else if (picked === null && guestUrl) url = guestUrl;
    else {
      // Made only now, by this press: a picked set always gets a new link.
      setBusy(true);
      try {
        const r = await api<GuestLinks>("/api/guest-links", "POST", {
          ...(list ? { list_id: list.id } : {}),
          ...(picked !== null ? { gift_ids: picked } : {}),
        });
        url = r.web_url || "";
        if (picked === null) setGuestUrl(url);
      } catch (e) {
        setError((e as Error).message);
        return;
      } finally {
        setBusy(false);
      }
      if (!url) return;
    }
    const whose = list ? list.name : own ? "" : ownerName || "";
    const text =
      kind === "guest"
        ? `${whose ? `Вишлист: ${whose}` : "Мой вишлист"} — выберите подарок, вход не нужен`
        : whose
          ? `Вишлист: ${whose}`
          : "Мой вишлист: выберите подарок";
    const result = await shareLink(url, text.trim());
    if (result === "unavailable") setFallback({ kind, url });
  }
  return (
    <div className="share-result share-choices">
      {list && (
        <p className="list-for">
          Список: <strong>{list.name}</strong>
        </p>
      )}
      <button
        type="button"
        className="share-choice"
        disabled={busy}
        onClick={() => void send("profile")}
      >
        <Share2 size={20} />
        <span>
          <strong>Поделиться</strong>
          <small>
            {own
              ? "Ссылка на ваш профиль. Желания откроются после входа; закрытый вишлист — после того, как вы одобрите запрос в друзья."
              : "Ссылка на профиль. Желания откроются после входа тем, кому они доступны."}
          </small>
        </span>
      </button>
      {fallback?.kind === "profile" && <CopyLink url={fallback.url} />}
      {own && (
        <>
          <button
            type="button"
            className={`share-choice${guestStep ? " open" : ""}`}
            disabled={busy}
            aria-expanded={guestStep}
            onClick={() => setGuestStep(!guestStep)}
          >
            <LinkIcon size={20} />
            <span>
              <strong>Поделиться без входа</strong>
              <small>
                Упрощённый список: открывается без входа, для брони достаточно
                имени. Отправляйте тем, кому доверяете.
              </small>
            </span>
          </button>
          {guestStep && (
            <div className="guest-set">
              <label className="setting-toggle">
                <input
                  type="radio"
                  name="guest-set"
                  checked={picked === null}
                  onChange={() => setPicked(null)}
                />
                <span>
                  Весь вишлист
                  <small className="muted"> · новые желания появятся сами</small>
                </span>
              </label>
              <label className="setting-toggle">
                <input
                  type="radio"
                  name="guest-set"
                  checked={picked !== null}
                  onChange={() => setPicking(true)}
                />
                <span>
                  {picked === null
                    ? "Выбрать желания"
                    : `Выбрано желаний: ${picked.length}`}
                  {picked !== null && (
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setPicking(true)}
                    >
                      Изменить
                    </button>
                  )}
                </span>
              </label>
              <button
                type="button"
                className="button primary full-width"
                disabled={busy}
                onClick={() => void send("guest")}
              >
                <Share2 size={17} />
                {busy ? "Готовим ссылку…" : "Отправить ссылку"}
              </button>
              {fallback?.kind === "guest" && <CopyLink url={fallback.url} />}
            </div>
          )}
        </>
      )}
      {picking && (
        <WishPicker
          wishes={wishes}
          initial={picked}
          onClose={() => setPicking(false)}
          onDone={(ids) => {
            setPicked(ids);
            setPicking(false);
            setFallback(null);
          }}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
/**
 * Profile: guest links are revoked or replaced here, apart from sending them,
 * each with its own confirmation. One line per list or picked set.
 */
export function LinkSettings() {
  const [data, setData] = useState<GuestLinks | null>(null);
  const [ask, setAsk] = useState<{
    kind: "revoke" | "replace" | "legacy";
    link: { id: string; list_id?: string | null };
  } | null>(null);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const load = () =>
    api<GuestLinks>("/api/guest-links")
      .then(setData)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    if (!demo) void load();
  }, []);
  async function run(a: NonNullable<typeof ask>) {
    setAsk(null);
    setError("");
    setDone("");
    try {
      await api(`/api/guest-links/${a.link.id}`, "DELETE");
      if (a.kind === "replace")
        await api(
          "/api/guest-links",
          "POST",
          a.link.list_id ? { list_id: a.link.list_id } : {},
        );
      await load();
      setDone(
        a.kind === "replace"
          ? "Ссылка заменена. Отправьте новую через «Поделиться без входа»."
          : "Ссылка отозвана",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (demo || !data) return null;
  return (
    <section className="link-settings">
      <h3>Ссылки без входа</h3>
      {data.links.length ? (
        data.links.map((l) => (
          <div className="active-link" key={l.id}>
            <span>
              {l.list_name || "Мой вишлист"} ·{" "}
              {l.picked ? `выбрано желаний: ${l.count ?? 0}` : "весь список"}
            </span>
            <span className="link-settings-actions">
              {!l.picked && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setAsk({ kind: "replace", link: l })}
                >
                  Заменить
                </button>
              )}
              <button
                type="button"
                className="text-link danger"
                onClick={() => setAsk({ kind: "revoke", link: l })}
              >
                Отозвать
              </button>
            </span>
          </div>
        ))
      ) : (
        <p className="small-text">
          Нет. Ссылка появится, когда вы нажмёте «Поделиться без входа».
        </p>
      )}
      {(data.legacy_links || []).map((l) => (
        <div className="active-link" key={l.id}>
          <span>Ранее созданная ссылка без входа</span>
          <button
            type="button"
            className="text-link danger"
            onClick={() => setAsk({ kind: "legacy", link: l })}
          >
            Отозвать
          </button>
        </div>
      ))}
      {done && <p role="status">{done}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {ask && (
        <Confirm
          title={ask.kind === "replace" ? "Заменить ссылку?" : "Отозвать ссылку?"}
          text={
            ask.kind === "replace"
              ? "Старая ссылка перестанет работать. Новую нужно будет отправить заново."
              : "Ссылка перестанет работать. Брони, сделанные по ней, сохранятся. Другие ссылки продолжат работать."
          }
          action={ask.kind === "replace" ? "Заменить" : "Отозвать"}
          danger={ask.kind !== "replace"}
          onCancel={() => setAsk(null)}
          onConfirm={() => void run(ask)}
        />
      )}
    </section>
  );
}
/**
 * «В архив»: the reason applies as soon as it is picked, with no «are you
 * sure» (П27); «Вернуть» in the toast undoes it. The same answer whether or
 * not someone chose the gift.
 */
export function ArchiveWish({
  gift,
  onClose,
  onArchived,
}: {
  gift: Wish;
  onClose: () => void;
  onArchived: (reason: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function archive(reason: string) {
    if (demo) {
      setError("В демо архив не меняется.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/gifts/${gift.id}/archive`, "POST", { reason });
      await onArchived(reason);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="В архив"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="share-result">
        <h3>{gift.title}</h3>
        <p>Почему убираете желание из списка?</p>
        <div className="archive-reasons">
          {[
            ["bought_self", "Куплено", "Купил сам"],
            ["gifted", "Подарено", "Подарок уже получен"],
            ["changed_mind", "Передумал", "Больше не нужен"],
          ].map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              className="archive-reason-choice"
              disabled={busy}
              onClick={() => void archive(value)}
            >
              <strong>{label}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
/**
 * «Подарю»: a confirmation with the photo, name and price, then a lasting
 * «Готово!». «Вместе с друзьями» invites friends to share it. With `invite`
 * the organizer adds more friends to a booking that already exists. A guest
 * (no account) types a name, offered again from the last time.
 */
export function ReserveDialog({
  gift,
  photo,
  ownerId,
  friends,
  exclude = [],
  invite = false,
  guest = false,
  onClose,
  onBooked,
  onBookings,
}: {
  gift: { id: string; title: string } & Partial<Wish>;
  photo?: React.ReactNode;
  ownerId: string;
  friends: Friend[];
  exclude?: string[];
  invite?: boolean;
  guest?: boolean;
  onClose: () => void;
  /** Booked (with the guest's cancel code) or friends invited: refresh behind the dialog. */
  onBooked: (message: string, code?: string) => Promise<void> | void;
  /** «Мои брони», for people with an account. */
  onBookings?: () => void;
}) {
  const [step, setStep] = useState<"confirm" | "together" | "done" | "taken">(
    invite ? "together" : "confirm",
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState(guest ? savedGuestName() : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invited, setInvited] = useState(0);
  const candidates = friends.filter(
    (f) => f.id !== ownerId && !exclude.includes(f.id),
  );
  const priced =
    gift.price_minor != null || (gift.price_max_minor ?? null) !== null;
  async function submit(withFriends: string[]) {
    if (demo) {
      setError("Бронирование доступно после подключения приложения.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (invite) {
        await api(`/api/gifts/${gift.id}/reservation/invite`, "POST", {
          friends: withFriends,
        });
        await onBooked("Приглашения отправлены в Telegram");
        return;
      }
      if (guest) {
        const r = await api(`/api/guest-reservations/${gift.id}`, "POST", {
          name,
        });
        saveGuestName(name.trim());
        void onBooked("Подарок выбран", r.code);
      } else {
        await api(
          `/api/gifts/${gift.id}/reservation`,
          "POST",
          withFriends.length ? { friends: withFriends } : {},
        );
        void onBooked("Подарок выбран");
      }
      setInvited(withFriends.length);
      setStep("done");
    } catch (e) {
      if (e instanceof RequestError && e.code === "TAKEN") {
        setStep("taken");
        void onBooked("");
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title =
    step === "done"
      ? "Готово!"
      : step === "taken"
        ? "Подарок уже выбрали"
        : invite
          ? "Пригласить друзей"
          : step === "together"
            ? "Подарить вместе"
            : "Вы подарите это?";
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="share-result reserve-dialog">
        {(step === "confirm" || step === "done") && (
          <div className="reserve-gift">
            {photo && <div className="reserve-photo">{photo}</div>}
            <div>
              <h3>{gift.title}</h3>
              {priced && (
                <p className="reserve-price">
                  {formatPrice(gift as Parameters<typeof formatPrice>[0])}
                </p>
              )}
            </div>
          </div>
        )}
        {step === "confirm" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit([]);
            }}
          >
            {guest && (
              <label>
                Ваше имя
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Как вас зовут"
                  autoComplete="name"
                />
              </label>
            )}
            <p className="small-text">
              Владелец не узнает, кто выбрал подарок.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={onClose}
              >
                Отмена
              </button>
              <button
                className="button primary"
                disabled={busy || (guest && !name.trim())}
              >
                {busy ? "Сохраняем…" : "Да, я подарю"}
              </button>
            </div>
            {!guest && (
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => setStep("together")}
              >
                <Users size={15} /> Подарить вместе с друзьями
              </button>
            )}
          </form>
        )}
        {step === "together" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(picked);
            }}
          >
            {invite && <h3>{gift.title}</h3>}
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
                Пока некого позвать: позвать можно ваших друзей и тех, кто
                добавил вас в друзья.
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
                  : "Подарить и пригласить"}
            </button>
            {!invite && (
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => setStep("confirm")}
              >
                Назад
              </button>
            )}
          </form>
        )}
        {step === "done" && (
          <>
            <p className="reserve-done">
              <Check size={18} /> Имя дарителя скрыто от владельца.
              {invited > 0 && " Друзьям ушли приглашения скинуться."}
            </p>
            <div className="confirm-actions">
              {gift.shop_url && (
                <a
                  className="button secondary"
                  href={gift.shop_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Где купить <ArrowUpRight size={15} />
                </a>
              )}
              <button className="button primary" onClick={onClose}>
                К списку
              </button>
            </div>
            {onBookings && (
              <button type="button" className="text-link" onClick={onBookings}>
                Мои брони
              </button>
            )}
          </>
        )}
        {step === "taken" && (
          <>
            <p>Пока вы смотрели, этот подарок выбрал кто-то другой.</p>
            <button className="button primary full-width" onClick={onClose}>
              Посмотреть другие
            </button>
          </>
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
