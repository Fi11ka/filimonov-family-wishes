import React, { useEffect, useState } from "react";
import {
  Gift,
  Heart,
  X,
  Check,
  Copy,
  ImagePlus,
  Link as LinkIcon,
  RefreshCw,
  LogOut,
} from "lucide-react";
import { api, compressPhoto, demo } from "./api";
import {
  type Wish,
  type Family,
  type User,
  type Member,
  priorities,
  initials,
} from "./types";
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
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
        className="modal"
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
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (gift?.has_photo)
      void api(`/api/gifts/${gift.id}/photo`)
        .then((d) => setPhoto(d.photo))
        .catch((e) => {
          setError(e.message);
          setPhotoError(true);
        })
        .finally(() => setPhotoLoading(false));
  }, [gift]);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError("");
        const d = new FormData(e.currentTarget);
        try {
          const amount = String(d.get("price")).trim().replace(",", ".");
          if (amount && !/^\d{1,9}(\.\d{1,2})?$/.test(amount))
            throw new Error(
              "Укажите цену с точностью до двух знаков после запятой.",
            );
          await api(
            gift ? `/api/gifts/${gift.id}` : "/api/gifts",
            gift ? "PUT" : "POST",
            {
              title: d.get("title"),
              price_minor: amount ? Math.round(Number(amount) * 100) : null,
              currency: d.get("currency"),
              shop_url: d.get("shop_url"),
              description: d.get("description"),
              priority: Number(d.get("priority")),
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
      <label className="photo-upload">
        {photo ? (
          <img src={photo} alt="Фото подарка" />
        ) : (
          <>
            <ImagePlus size={27} />
            <strong>
              {photoLoading ? "Готовим фото…" : "Добавить фотографию"}
            </strong>
            <span>JPEG, PNG или WebP · сожмём автоматически</span>
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
            setPhotoLoading(true);
            try {
              setPhoto(await compressPhoto(file));
              setError("");
              setPhotoError(false);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setPhotoLoading(false);
            }
          }}
        />
      </label>
      {photo && (
        <button
          type="button"
          className="text-link"
          onClick={() => setPhoto("")}
        >
          Убрать фото
        </button>
      )}
      <label>
        Название желания
        <input
          name="title"
          required
          maxLength={120}
          defaultValue={gift?.title}
          placeholder="О чём вы мечтаете?"
        />
      </label>
      <div className="form-row">
        <label>
          Цена
          <input
            name="price"
            inputMode="decimal"
            defaultValue={
              gift?.price_minor === null
                ? ""
                : gift?.price_minor !== undefined
                  ? gift.price_minor / 100
                  : ""
            }
            placeholder="Необязательно"
          />
        </label>
        <label>
          Валюта
          <select name="currency" defaultValue={gift?.currency || "EUR"}>
            {[
              "EUR",
              "USD",
              "RUB",
              "GBP",
              "GEL",
              "TRY",
              "KZT",
              "UAH",
              "BYN",
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Ссылка на магазин
        <input
          name="shop_url"
          type="url"
          maxLength={2048}
          defaultValue={gift?.shop_url}
          placeholder="https://…"
        />
      </label>
      <label>
        Подсказка близким
        <textarea
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={gift?.description}
          placeholder="Цвет, размер или другие важные детали"
        />
      </label>
      <label>
        Как сильно хочется?
        <select name="priority" defaultValue={gift?.priority || 2}>
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
        disabled={saving || photoLoading || photoError}
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
export function FamilyForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"create" | "join">("create"),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [invite, setInvite] = useState("");
  return (
    <>
      <div className="segmented">
        <button
          className={mode === "create" ? "selected" : ""}
          onClick={() => setMode("create")}
        >
          Создать семью
        </button>
        <button
          className={mode === "join" ? "selected" : ""}
          onClick={() => setMode("join")}
        >
          У меня есть код
        </button>
      </div>
      {invite ? (
        <div className="share-result">
          <Heart size={30} />
          <h3>Ваша семья создана!</h3>
          <p>Передайте код близким. Его обладатели смогут вступить в семью.</p>
          <CopyValue value={invite} />
          <button className="button primary full-width" onClick={onDone}>
            К желаниям
          </button>
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (demo) {
              setError("Создание семьи доступно после подключения.");
              return;
            }
            setSaving(true);
            setError("");
            const d = new FormData(e.currentTarget);
            try {
              const r = await api(
                mode === "create" ? "/api/family" : "/api/family/join",
                "POST",
                mode === "create"
                  ? { name: d.get("value") }
                  : { code: d.get("value") },
              );
              if (r.invite_code) setInvite(r.invite_code);
              else onDone();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <p className="muted">
            {mode === "create"
              ? "Уютное место для желаний всех ваших близких."
              : "Попросите код у создателя семьи. Его можно получить в настройках."}
          </p>
          <label>
            {mode === "create" ? "Название семьи" : "Код приглашения"}
            <input
              key={mode}
              name="value"
              required
              maxLength={80}
              placeholder={
                mode === "create" ? "Семья Филимоновых" : "Вставьте код"
              }
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary full-width" disabled={saving}>
            {saving
              ? "Подождите…"
              : mode === "create"
                ? "Создать семью"
                : "Присоединиться"}
          </button>
        </form>
      )}
    </>
  );
}
function CopyValue({ value }: { value: string }) {
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
        через Telegram, не вступая в семью.
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
export function FamilySettings({
  family,
  user,
  members,
  onChanged,
}: {
  family: Family | null;
  user: User | null;
  members: Member[];
  onChanged: () => void;
}) {
  const [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const own = family?.owner_id === user?.id;
  return (
    <>
      <h3>{family?.name || "Вы пока не в семье"}</h3>
      <p className="muted">
        Семейные списки доступны только участникам. Гостевой доступ выдаётся
        отдельно владельцем списка.
      </p>
      {own && (
        <>
          <button
            className="button secondary full-width"
            disabled={busy}
            onClick={async () => {
              if (demo) {
                setError("Настройка доступна после подключения.");
                return;
              }
              setBusy(true);
              try {
                setCode((await api("/api/family/invite", "POST")).invite_code);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={16} />
            Создать новый код приглашения
          </button>
          <p className="small-text">
            Предыдущий код перестанет работать. Действующие участники останутся
            в семье.
          </p>
          {code && <CopyValue value={code} />}
        </>
      )}
      {members.map((m) => (
        <div className="settings-member" key={m.id}>
          <span className="avatar small">{initials(m.name)}</span>
          <span>{m.name}</span>
          {own && m.id !== user?.id && (
            <button
              className="icon-button danger"
              aria-label={`Удалить из семьи ${m.name}`}
              disabled={busy}
              onClick={async () => {
                if (demo) return;
                if (!confirm(`Убрать ${m.name} из семьи?`)) return;
                setBusy(true);
                try {
                  await api(`/api/family/members/${m.id}`, "DELETE");
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <X size={17} />
            </button>
          )}
        </div>
      ))}
      {family && !own && (
        <button
          className="button secondary full-width danger"
          disabled={busy}
          onClick={async () => {
            if (!confirm("Выйти из семьи? Список ваших желаний сохранится."))
              return;
            setBusy(true);
            try {
              await api("/api/family/leave", "POST");
              onChanged();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <LogOut size={16} />
          Выйти из семьи
        </button>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
