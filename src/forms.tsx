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
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement;
    dialog?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
      document.removeEventListener("keydown", key);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <h2 id="modal-title">{title}</h2>
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
  text,
  action,
  danger,
  onConfirm,
  onCancel,
}: {
  text: string;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title="Вы уверены?" onClose={onCancel}>
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
export function GiftForm({
  gift,
  onSaved,
}: {
  gift: Wish | null;
  onSaved: () => void;
}) {
  const [photo, setPhoto] = useState(""),
    [photoLoading, setPhotoLoading] = useState(!!gift?.has_photo),
    [photoError, setPhotoError] = useState(false),
    [photoNote, setPhotoNote] = useState(""),
    [imageUrl, setImageUrl] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
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
    autoPhoto = useRef(false);
  const draft = useRef({
    title,
    priceTouched,
    priceMin,
    priceMax,
    photo,
    photoLoading,
  });
  draft.current = {
    title,
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
      price: !current.priceTouched || (!current.priceMin && !current.priceMax),
      photo: !current.photo && !current.photoLoading && !gift?.has_photo,
    });
    try {
      const r = await api<ProductLookup>("/api/fetch/product", "POST", { url });
      if (!job.current()) return;
      const notes: string[] = [];
      if (r.title && job.canApply("title")) {
        setTitle(r.title.slice(0, 120));
        autoTitle.current = true;
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
      if (r.blocked)
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
      onPaste={(e) => {
        if (e.clipboardData.files.length) {
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
              if (!draft.current.priceTouched) {
                setPriceMin("");
                setPriceMax("");
              }
              if (autoPhoto.current) {
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
          {lookup === "loading" ? "Ищем цену и картинку…" : lookupNote}
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
          placeholder="О чём вы мечтаете?"
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
        Подсказка близким
        <textarea
          name="description"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Цвет, размер или другие важные детали"
        />
      </label>
      <label>
        Как сильно хочется?
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
export function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-value">
      <input
        readOnly
        value={value}
        aria-label="Ссылка или код для копирования"
        onFocus={(e) => e.target.select()}
      />
      <button
        type="button"
        className="icon-button"
        aria-label="Скопировать"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </button>
    </div>
  );
}
export function Share() {
  const [link, setLink] = useState<{
      telegram_url: string;
      web_url: string;
      id: string;
    } | null>(null),
    [links, setLinks] = useState<
      { id: string; expires_at: number; revoked_at: number | null }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function reload() {
    try {
      setLinks((await api("/api/guest-links")).links);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void reload();
  }, []);
  return (
    <div className="share-result">
      <div className="share-illustration">
        <Gift size={36} />
        <Heart size={17} />
      </div>
      <p>
        По ссылке гости увидят только ваш список и смогут бронировать подарки
        через Telegram, не добавляясь в друзья.
      </p>
      <p className="small-text">
        Ссылка действует 30 дней. Новая ссылка заменяет предыдущую. Уже
        сделанные брони сохраняются, даритель может их отменить.
      </p>
      {link && (
        <>
          <label>Ссылка для Telegram</label>
          <CopyValue value={link.telegram_url} />
          <label>Просмотр в браузере</label>
          <CopyValue value={link.web_url} />
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary full-width"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setLink(await api("/api/guest-links", "POST"));
            await reload();
            setError("");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <LinkIcon size={17} />
        {busy ? "Готовим…" : link ? "Заменить ссылку" : "Создать новую ссылку"}
      </button>
      {links
        .filter((l) => !l.revoked_at && l.expires_at > Date.now() / 1000)
        .map((l) => (
          <div className="active-link" key={l.id}>
            <span>
              Действует до{" "}
              {new Date(l.expires_at * 1000).toLocaleDateString("ru-RU")}
            </span>
            <button
              disabled={busy}
              className="text-link danger"
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/api/guest-links/${l.id}`, "DELETE");
                  setLink(null);
                  await reload();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Отозвать
            </button>
          </div>
        ))}
    </div>
  );
}
