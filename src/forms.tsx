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
} from "lucide-react";
import {
  api,
  compressPhoto,
  demo,
  photoFromUrl,
  type ProductLookup,
} from "./api";
import { type Wish, priorities } from "./types";
import { currencies } from "../shared/price";
import { LookupState } from "./lookup-state";
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
    [priority, setPriority] = useState(gift?.priority || 2),
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
              photo,
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
      {(lookup === "loading" || lookupNote) && (
        <p className="lookup-note" role="status">
          <Sparkles size={14} />
          {lookup === "loading"
            ? SLOW_SHOPS.test(shopUrl)
              ? "Открываем страницу через домашний помощник, это может занять до 30 секунд…"
              : "Ищем цену и картинку…"
            : lookupNote}
        </p>
      )}
      <label className="photo-upload">
        {photo ? (
          <img src={photo} alt="Фото подарка" />
        ) : photoNote && !photoLoading ? (
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
      <label>
        Приоритет
        <select
          name="priority"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        >
          {[3, 2, 1].map((p) => (
            <option key={p} value={p}>
              {priorities[p]}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary full-width"
        disabled={saving || lookup === "loading" || photoLoading || photoError}
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
export function Share() {
  const [links, setLinks] = useState<
    { id: string; kind: string; web_url: string }[]
  >([]);
  const [error, setError] = useState("");
  const [legacy, setLegacy] = useState<{ id: string }[]>([]);
  useEffect(() => {
    api("/api/guest-links")
      .then((d) => (d.links.length === 2 ? d : api("/api/guest-links", "POST")))
      .then((d) => {
        setLinks(d.links);
        setLegacy(d.legacy_links || []);
      })
      .catch((e) => setError(e.message));
  }, []);
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
              link.kind === "guest"
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
                setLinks((await api("/api/guest-links", "POST")).links);
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
export function GuestBookings() {
  const [rows, setRows] = useState<
    { gift_id: string; title: string; guest_name: string }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() {
    setRows((await api("/api/guest-bookings")).reservations);
  }
  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, []);
  async function change(id: string, name?: string) {
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/guest-bookings/${id}`,
        name === undefined ? "DELETE" : "PATCH",
        name === undefined ? undefined : { name },
      );
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="share-result">
      <p>
        Брони по ссылке «Для близких без регистрации». Здесь можно исправить имя
        или отменить бронь.
      </p>
      {error && <p role="alert">{error}</p>}
      {!rows.length && <p>Броней без регистрации пока нет.</p>}
      {rows.map((row) => (
        <form
          key={row.gift_id}
          onSubmit={(e) => {
            e.preventDefault();
            void change(row.gift_id, row.guest_name);
          }}
        >
          <h3>{row.title}</h3>
          <label>
            Кто покупает
            <input
              required
              maxLength={80}
              value={row.guest_name}
              onChange={(e) =>
                setRows(
                  rows.map((r) =>
                    r.gift_id === row.gift_id
                      ? { ...r, guest_name: e.target.value }
                      : r,
                  ),
                )
              }
            />
          </label>
          <button className="button secondary" disabled={busy}>
            Сохранить имя
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Отменить выбор этого подарка?"))
                void change(row.gift_id);
            }}
          >
            Отменить бронь
          </button>
        </form>
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
  const [status, setStatus] = useState<{ reserved: boolean } | null>(null);
  const [donor, setDonor] = useState<{
    name: string;
    username: string | null;
    is_guest: boolean;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [donorLoaded, setDonorLoaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) {
      setStatus({ reserved: false });
      return;
    }
    api(`/api/gifts/${gift.id}/archive-status`)
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, [gift.id]);
  useEffect(() => {
    setConfirmed(false);
    setDonorLoaded(false);
    setDonor(null);
    setConfirmation(null);
    if (reason !== "gifted") return;
    if (demo) {
      setDonorLoaded(true);
      return;
    }
    let active = true;
    api(`/api/gifts/${gift.id}/archive-donor`)
      .then((d) => {
        if (active) {
          setDonor(d.donor);
          setConfirmation(d.confirmation);
          setDonorLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [reason, gift.id]);
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
            await api(`/api/gifts/${gift.id}/archive`, "POST", {
              reason,
              confirmation,
            });
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
        {!status && !error && (
          <p role="status">Проверяем возможность переноса…</p>
        )}
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
                disabled={
                  busy || !status || (status.reserved && value !== "gifted")
                }
                onChange={() => {
                  setReason(value);
                  setError("");
                }}
              />
              {label}
            </label>
          ))}
        </div>
        {status?.reserved && (
          <p>
            Подарок забронирован. Доступен только вариант «Подарили» с
            подтверждением дарителя.
          </p>
        )}
        {reason === "gifted" &&
          (donorLoaded ? (
            donor ? (
              <div className="donor-confirmation">
                <p>
                  Подарок выбрал(а): <strong>{donor.name}</strong>
                  {donor.username
                    ? ` · @${donor.username}`
                    : donor.is_guest
                      ? " · без входа в Telegram"
                      : " · ник в Telegram не указан"}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Подтверждаете, что подарок подарил этот человек?
                </label>
              </div>
            ) : (
              <p>Брони нет. Можно перенести в архив.</p>
            )
          ) : (
            <p role="status">Загружаем имя дарителя…</p>
          ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary full-width"
          disabled={
            busy ||
            !reason ||
            !status ||
            (status.reserved && reason !== "gifted") ||
            (reason === "gifted" && (!donorLoaded || (!!donor && !confirmed)))
          }
        >
          {busy ? "Переносим…" : "Перенести в архив"}
        </button>
      </form>
    </Modal>
  );
}
