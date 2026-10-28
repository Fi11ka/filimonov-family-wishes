import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  FileSpreadsheet,
  ImageOff,
  ShoppingCart,
  MessageSquare,
  Copy,
  Sparkles,
  Upload,
} from "lucide-react";
import {
  api,
  apiBlob,
  type Cart,
  type CartItem,
  compressPhoto,
  demo,
  photoFromUrl,
  RequestError,
  type ProductLookup,
} from "../api";
import { currencies, isCurrency, type Currency } from "../../shared/price";
import { Hearts } from "../hearts";
import { readCsv } from "./csv";
import { parseChatList } from "../../shared/chat-list";
import { shortTitle } from "../../shared/short-title";
import { CHAT_PROMPT } from "./chat-prompt";
import {
  amountText,
  normalizeSheet,
  rowPayload,
  type ImportRow,
} from "./normalize";
import { readXlsx, type Sheet, type Workbook } from "./xlsx";
const ACTIVE_LIMIT = 100;
type Step = "source" | "sheets" | "preview" | "importing" | "done";
interface Loaded {
  sheets: Sheet[];
  image: Workbook["image"];
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsLabel = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? "строка" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "строки" : "строк"}`;
export function ImportDialog({
  activeCount,
  list = null,
  onClose,
  onImported,
}: {
  activeCount: number;
  /** A list kept for someone close: every row goes there, fixed for the whole import. */
  list?: { id: string; name: string } | null;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>("source"),
    [source, setSource] = useState<"google" | "file" | "cart" | "text">(
      "google",
    ),
    [url, setUrl] = useState(""),
    [pasted, setPasted] = useState(""),
    [promptCopied, setPromptCopied] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState<Loaded | null>(null),
    [chosen, setChosen] = useState<Set<string>>(new Set()),
    [currency, setCurrency] = useState<Currency>("RUB"),
    [rows, setRows] = useState<ImportRow[]>([]),
    [progress, setProgress] = useState({ done: 0, total: 0 }),
    [summary, setSummary] = useState<string[]>([]);
  const counts = useMemo(
    () =>
      new Map(
        (loaded?.sheets || []).map((s) => [
          s.name,
          normalizeSheet(s, currency).length,
        ]),
      ),
    [loaded],
  );
  function open(data: Loaded) {
    const usable = data.sheets.filter((s) => s.rows.length);
    if (!usable.length) throw new Error("В файле не нашлось листов с данными.");
    setLoaded({ ...data, sheets: usable });
    setChosen(new Set(usable.length === 1 ? [usable[0].name] : []));
    setStep("sheets");
  }
  async function loadGoogle() {
    if (demo) {
      setError("В демо таблицы по ссылке не загружаются — выберите файл.");
      return;
    }
    setBusy("Скачиваем таблицу…");
    setError("");
    try {
      const blob = await apiBlob(
        "/api/fetch/sheet",
        { url: url.trim() },
        90000,
      );
      setBusy("Читаем листы…");
      const wb = readXlsx(new Uint8Array(await blob.arrayBuffer()));
      open({ sheets: wb.sheets, image: wb.image });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  /** Shared WB basket, WB wishlist or Ozon cart: every product is looked up like a single link. */
  async function loadCart(pasted = "") {
    if (demo) {
      setError("В демо корзины по ссылке не загружаются.");
      return;
    }
    setBusy("Открываем список товаров…");
    setError("");
    try {
      let cart: Cart;
      if (pasted) {
        // A ChatGPT answer pasted as text: parsed here, links are looked up below.
        const items = parseChatList(pasted, ACTIVE_LIMIT + 1).map((i) => {
          const named = i.title ? shortTitle(i.title) : null;
          return {
            ...i,
            title: named?.title || i.title,
            details: named?.details,
          };
        });
        if (!items.length)
          throw new Error(
            "В тексте не нашлось товаров. Нужны строки «Название | Цена | Ссылка», таблица или ссылки на товары.",
          );
        cart = {
          shop: "ChatGPT",
          kind: "chat",
          title: "Список из текста",
          items: items.slice(0, ACTIVE_LIMIT),
          truncated: items.length > ACTIVE_LIMIT,
        };
      } else
        cart = await api<Cart>("/api/fetch/cart", "POST", {
          url: url.trim(),
        });
      const chat = cart.kind === "chat";
      const made: ImportRow[] = new Array(cart.items.length);
      let done = 0,
        next = 0;
      const lookup = async (item: CartItem) => {
        for (let attempt = 0; attempt < 2; attempt++)
          try {
            return await api<ProductLookup>("/api/fetch/product", "POST", {
              url: item.url,
              bulk: true,
            });
          } catch (e) {
            if (e instanceof RequestError && e.status === 429 && attempt === 0)
              await wait(61000);
            else return null;
          }
        return null;
      };
      // A few lookups at a time: each one may wait for the shop for several seconds.
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < cart.items.length) {
            const i = next++;
            const item = cart.items[i];
            // A cart that already gave name, photo and price needs no shop lookup.
            const complete =
              !!item.title && !!item.image && item.price_minor != null;
            const r = complete || !item.url ? null : await lookup(item);
            // From ChatGPT or a person: their name and price win over the shop's
            // (the shop often refuses the server); the shop adds the photo.
            const ownPrice = chat && item.price_minor != null;
            const min = ownPrice
                ? item.price_minor!
                : (r?.price?.min_minor ?? item.price_minor ?? null),
              max = ownPrice
                ? (item.price_max_minor ?? null)
                : r?.price
                  ? r.price.max_minor
                  : null;
            const image = r?.image_url || item.image || "";
            made[i] = {
              key: `cart-${i}`,
              sheet: cart.title,
              line: i + 1,
              include: true,
              title: (
                (chat ? item.title || r?.title : r?.title || item.title) ||
                "Без названия"
              ).slice(0, 120),
              priceMode:
                min === null && max === null
                  ? "none"
                  : max !== null
                    ? "range"
                    : "exact",
              priceMin: amountText(min),
              priceMax: amountText(max),
              currency:
                !ownPrice && r?.price && isCurrency(r.price.currency)
                  ? r.price.currency
                  : "RUB",
              shopUrl: r?.url || item.url,
              description:
                (chat
                  ? item.details || r?.details
                  : r?.details || item.details) ||
                (r && item.title !== r.title ? item.title || "" : ""),
              priority: 3,
              archived: false,
              image: image ? { kind: "url", url: image } : null,
              warnings: [
                ...(r?.blocked && r.helper_offline
                  ? ["Домашний помощник не в сети: попробуйте позже"]
                  : []),
                ...(min === null && max === null
                  ? ["Магазин не отдал цену"]
                  : []),
                ...(!image ? ["Нет фото"] : []),
              ],
            };
            done++;
            setBusy(`Смотрим товары: ${done} из ${cart.items.length}…`);
          }
        }),
      );
      setLoaded(null);
      setRows(made);
      setStep("preview");
      if (cart.truncated)
        setError(
          `В ссылке больше ${cart.items.length} товаров — показаны первые ${cart.items.length}.`,
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function loadFile(file: File) {
    setBusy("Читаем файл…");
    setError("");
    try {
      if (file.size > 60 * 1024 * 1024) throw new Error("Файл больше 60 МБ.");
      if (/\.csv$/i.test(file.name) || file.type === "text/csv")
        open({
          sheets: [
            readCsv(await file.text(), file.name.replace(/\.csv$/i, "")),
          ],
          image: () => null,
        });
      else {
        const wb = readXlsx(new Uint8Array(await file.arrayBuffer()));
        open({ sheets: wb.sheets, image: wb.image });
      }
    } catch (e) {
      setError(
        /xlsx|zip|invalid/i.test((e as Error).message)
          ? "Не удалось прочитать файл. Нужен .xlsx или .csv."
          : (e as Error).message,
      );
    } finally {
      setBusy("");
    }
  }
  function preview() {
    if (!loaded) return;
    setRows(
      loaded.sheets
        .filter((s) => chosen.has(s.name))
        .flatMap((s) => normalizeSheet(s, currency)),
    );
    setStep("preview");
  }
  const update = (key: string, patch: Partial<ImportRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const included = rows.filter((r) => r.include);
  const activeNew = included.filter((r) => !r.archived).length;
  const overLimit = activeCount + activeNew > ACTIVE_LIMIT;
  async function lookupMissing() {
    const targets = included.filter(
      (r) => r.shopUrl && (r.priceMode === "none" || !r.image),
    );
    if (!targets.length) {
      setError("У выбранных строк уже есть цены и картинки (или нет ссылок).");
      return;
    }
    setError("");
    let found = 0,
      helperOff = false;
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      setBusy(`Смотрим ссылки: ${i + 1} из ${targets.length}…`);
      let result: ProductLookup | null = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++)
        try {
          result = await api<ProductLookup>("/api/fetch/product", "POST", {
            url: r.shopUrl,
          });
        } catch (e) {
          if (e instanceof RequestError && e.status === 429 && attempt === 0) {
            setBusy("Лимит запросов: ждём минуту и продолжаем…");
            await wait(61000);
          } else break;
        }
      if (!result) continue;
      if (result.blocked && result.helper_offline) helperOff = true;
      const patch: Partial<ImportRow> = {};
      if (r.priceMode === "none" && result.price) {
        patch.priceMode = result.price.max_minor !== null ? "range" : "exact";
        patch.priceMin = amountText(result.price.min_minor);
        patch.priceMax = amountText(result.price.max_minor);
        if (isCurrency(result.price.currency))
          patch.currency = result.price.currency;
      }
      if (!r.image && result.image_url)
        patch.image = { kind: "url", url: result.image_url };
      if (Object.keys(patch).length) {
        found++;
        update(r.key, patch);
      }
    }
    setBusy("");
    setError(
      (found
        ? `Дополнили ${found} из ${targets.length}. Остальные магазины не отдали данные — поправьте вручную.`
        : "Магазины не отдали данные автоматически. Цены и фото можно поправить вручную.") +
        (helperOff
          ? " Ozon, DNS, Яндекс Маркет и AliExpress читает домашний помощник, а он сейчас не в сети: для них попробуйте позже."
          : ""),
    );
  }
  async function photoFor(r: ImportRow) {
    if (!r.image) return "";
    if (r.image.kind === "embedded") {
      if (!loaded) return "";
      const bytes = loaded.image(r.image.path);
      if (!bytes) return "";
      return compressPhoto(
        new Blob([bytes as BlobPart], { type: r.image.type }),
      );
    }
    return photoFromUrl(r.image.url);
  }
  // The list is fixed when the dialog opens: switching lists meanwhile does not move the import.
  const target = useRef(list).current;
  async function runImport() {
    if (demo) {
      setError(
        "Это демо: импорт покажет предпросмотр, но не сохранит желания.",
      );
      return;
    }
    let payloads: ReturnType<typeof rowPayload>[];
    try {
      payloads = included.map(rowPayload);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setStep("importing");
    setProgress({ done: 0, total: payloads.length });
    let saved = 0,
      archived = 0,
      noPhoto = 0;
    const failed: string[] = [];
    for (let i = 0; i < payloads.length; i++) {
      const row = included[i];
      let photo = "";
      try {
        photo = await photoFor(row);
      } catch {
        photo = "";
      }
      if (row.image && !photo) noPhoto++;
      try {
        await api("/api/gifts", "POST", {
          ...payloads[i],
          photo,
          ...(target ? { list_id: target.id } : {}),
        });
        saved++;
        if (row.archived) archived++;
      } catch (e) {
        if (e instanceof RequestError && e.status === 429) {
          await wait(61000);
          i--;
          continue;
        }
        failed.push(`«${row.title}»: ${(e as Error).message}`);
      }
      setProgress({ done: i + 1, total: payloads.length });
    }
    setSummary([
      `Добавлено желаний: ${saved - archived}${archived ? `, в архив: ${archived}` : ""}.`,
      ...(noPhoto
        ? [`Без картинки: ${noPhoto} — их можно добавить, открыв желание.`]
        : []),
      ...failed,
    ]);
    setStep("done");
  }
  if (step === "source")
    return (
      <div className="import">
        <div className="segmented">
          <button
            className={source === "google" ? "selected" : ""}
            onClick={() => setSource("google")}
          >
            <FileSpreadsheet size={15} /> Google Таблица
          </button>
          <button
            className={source === "file" ? "selected" : ""}
            onClick={() => setSource("file")}
          >
            <Upload size={15} /> Файл .xlsx / .csv
          </button>
          <button
            className={source === "cart" ? "selected" : ""}
            onClick={() => setSource("cart")}
          >
            <ShoppingCart size={15} /> Корзина WB / Ozon
          </button>
          <button
            className={source === "text" ? "selected" : ""}
            onClick={() => setSource("text")}
          >
            <MessageSquare size={15} /> Из текста
          </button>
        </div>
        {source === "cart" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadCart();
            }}
          >
            <p className="muted">
              В корзине Wildberries или Ozon нажмите «Поделиться» и вставьте
              ссылку. Подходит и ссылка на вишлист Wildberries. Перед
              сохранением откроется предпросмотр: лишнее можно снять.
            </p>
            <label>
              Ссылка на корзину или вишлист
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.wildberries.ru/basket?shareId=…"
              />
            </label>
            <button className="button primary full-width" disabled={!!busy}>
              {busy || "Открыть"}
            </button>
          </form>
        ) : source === "text" ? (
          <div className="chat-import">
            <p className="muted">
              Вставьте список товаров: по строке на товар в виде «Название |
              Цена | Ссылка», таблицу или просто ссылки. По ссылкам подтянутся
              фото и недостающие данные.
            </p>
            <p className="small-text">
              <strong>Много товаров на Ozon или на других сайтах?</strong> Если
              сайт не даёт импортировать товары в карточки, отправьте в ChatGPT
              этот промт и что угодно о своих желаниях: ссылки, скриншоты
              корзины, таблицу, файл или просто опишите словами. Ответ ChatGPT
              (кнопка «Копировать» над блоком кода) вставьте сюда — все товары
              появятся в карточках.
            </p>
            <details>
              <summary>Показать промт</summary>
              <pre className="chat-prompt">{CHAT_PROMPT}</pre>
            </details>
            <button
              type="button"
              className="button secondary full-width"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(CHAT_PROMPT);
                  setPromptCopied(true);
                  setTimeout(() => setPromptCopied(false), 2500);
                } catch {
                  setError(
                    "Не удалось скопировать. Откройте промт и скопируйте вручную.",
                  );
                }
              }}
            >
              <Copy size={15} />{" "}
              {promptCopied
                ? "Промт скопирован"
                : "Скопировать промт для ChatGPT"}
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void loadCart(pasted.trim());
              }}
            >
              <label>
                Список товаров
                <textarea
                  rows={7}
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder={
                    "Колье многоуровневое | 249 | https://ozon.ru/t/…\nСерьги «Цветы» | 99 |\nhttps://www.wildberries.ru/catalog/…"
                  }
                />
              </label>
              <button
                className="button primary full-width"
                disabled={!!busy || !pasted.trim()}
              >
                {busy || "Разобрать список"}
              </button>
            </form>
          </div>
        ) : source === "google" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadGoogle();
            }}
          >
            <p className="muted">
              Таблица должна быть открыта по ссылке («Все, у кого есть ссылка»).
              Каждый лист можно импортировать отдельно.
            </p>
            <label>
              Ссылка на таблицу
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
              />
            </label>
            <button className="button primary full-width" disabled={!!busy}>
              {busy || "Открыть таблицу"}
            </button>
          </form>
        ) : (
          <label className="photo-upload file-drop">
            <FileSpreadsheet size={27} />
            <strong>{busy || "Выбрать файл"}</strong>
            <span>
              Excel (.xlsx) или CSV. В Google Таблицах: Файл → Скачать → .xlsx
            </span>
            <input
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={!!busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f);
              }}
            />
          </label>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  if (step === "sheets" && loaded)
    return (
      <div className="import">
        <p className="muted">
          Отметьте свой лист — желания попадут в ваш вишлист. Чужие листы пусть
          импортируют их владельцы из своих аккаунтов.
        </p>
        <div className="sheet-list">
          {loaded.sheets.map((s) => (
            <label key={s.name} className="check-row">
              <input
                type="checkbox"
                checked={chosen.has(s.name)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(s.name);
                  else next.delete(s.name);
                  setChosen(next);
                }}
              />
              <span>{s.name}</span>
              <small>{rowsLabel(counts.get(s.name) || 0)}</small>
            </label>
          ))}
        </div>
        <label>
          Валюта по умолчанию
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <div className="confirm-actions">
          <button
            className="button secondary"
            onClick={() => setStep("source")}
          >
            Назад
          </button>
          <button
            className="button primary"
            disabled={!chosen.size}
            onClick={preview}
          >
            Предпросмотр
          </button>
        </div>
      </div>
    );
  if (step === "preview")
    return (
      <div className="import">
        <div className="import-toolbar">
          <span>
            Выбрано: <strong>{included.length}</strong>
            {included.length - activeNew
              ? ` (в архив: ${included.length - activeNew})`
              : ""}
            {target ? (
              <>
                {" "}
                · для <strong>{target.name}</strong>
              </>
            ) : null}
          </span>
          <button
            className="text-link"
            disabled={!!busy}
            onClick={() => void lookupMissing()}
          >
            <Sparkles size={15} /> Подтянуть цены и фото по ссылкам
          </button>
        </div>
        {busy && (
          <p className="lookup-note" role="status">
            <Sparkles size={14} /> {busy}
          </p>
        )}
        {overLimit && (
          <div className="error" role="alert">
            В списке может быть не больше {ACTIVE_LIMIT} желаний: сейчас{" "}
            {activeCount}, добавляете {activeNew}. Снимите отметку с части строк
            или отметьте их как купленные.
          </div>
        )}
        <div className="import-rows">
          {rows.map((r) => (
            <ImportRowEditor
              key={r.key}
              row={r}
              loaded={loaded}
              onChange={(patch) => update(r.key, patch)}
            />
          ))}
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="confirm-actions sticky-actions">
          <button
            className="button secondary"
            onClick={() => setStep("sheets")}
          >
            Назад
          </button>
          <button
            className="button primary"
            disabled={!included.length || overLimit || !!busy}
            onClick={() => void runImport()}
          >
            Импортировать {included.length}
          </button>
        </div>
      </div>
    );
  if (step === "importing")
    return (
      <div className="import">
        <div className="loading" role="status">
          <span />
          Сохраняем желания: {progress.done} из {progress.total}…
        </div>
        <progress value={progress.done} max={progress.total} />
        <p className="small-text">Не закрывайте окно до окончания импорта.</p>
      </div>
    );
  return (
    <div className="import share-result">
      <h3>Импорт завершён</h3>
      {summary.map((s) => (
        <p key={s}>{s}</p>
      ))}
      <button
        className="button primary full-width"
        onClick={() => {
          onImported(summary[0] || "Импорт завершён");
          onClose();
        }}
      >
        К вишлисту
      </button>
    </div>
  );
}
function ImportRowEditor({
  row,
  loaded,
  onChange,
}: {
  row: ImportRow;
  loaded: Loaded | null;
  onChange: (patch: Partial<ImportRow>) => void;
}) {
  const [thumb, setThumb] = useState(""),
    [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (row.image?.kind === "embedded" && loaded) {
      const bytes = loaded.image(row.image.path);
      if (!bytes) return;
      const u = URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: row.image.type }),
      );
      setThumb(u);
      return () => URL.revokeObjectURL(u);
    }
    setThumb(row.image?.kind === "url" ? row.image.url : "");
  }, [row.image, loaded]);
  return (
    <article className={`import-row ${row.include ? "" : "excluded"}`}>
      <label className="import-include">
        <input
          type="checkbox"
          checked={row.include}
          onChange={(e) => onChange({ include: e.target.checked })}
          aria-label={`Импортировать «${row.title}»`}
        />
      </label>
      <div className="import-thumb">
        {thumb && !broken ? (
          <img
            src={thumb}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        ) : (
          <ImageOff size={20} aria-label="Нет картинки" />
        )}
      </div>
      <div className="import-fields">
        <div className="import-meta">
          {row.sheet} · строка {row.line}
          {row.warnings.map((w) => (
            <span key={w} className="warning-badge">
              <AlertTriangle size={11} /> {w}
            </span>
          ))}
          {row.image?.kind === "url" && (
            <span className="hint-badge">
              фото по ссылке{broken ? " (может не загрузиться)" : ""}
            </span>
          )}
        </div>
        <input
          aria-label="Название"
          value={row.title}
          maxLength={120}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <div className="import-line">
          <select
            aria-label="Тип цены"
            value={row.priceMode}
            onChange={(e) =>
              onChange({ priceMode: e.target.value as ImportRow["priceMode"] })
            }
          >
            <option value="none">Без цены</option>
            <option value="exact">Цена</option>
            <option value="range">От – до</option>
          </select>
          {row.priceMode !== "none" && (
            <input
              aria-label={row.priceMode === "range" ? "Цена от" : "Цена"}
              inputMode="decimal"
              placeholder={row.priceMode === "range" ? "от" : "цена"}
              value={row.priceMin}
              onChange={(e) => onChange({ priceMin: e.target.value })}
            />
          )}
          {row.priceMode === "range" && (
            <input
              aria-label="Цена до"
              inputMode="decimal"
              placeholder="до"
              value={row.priceMax}
              onChange={(e) => onChange({ priceMax: e.target.value })}
            />
          )}
          <select
            aria-label="Валюта"
            value={row.currency}
            onChange={(e) => onChange({ currency: e.target.value as Currency })}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <Hearts
            value={row.priority}
            onChange={(priority) => onChange({ priority })}
            size={16}
          />
          <label className="check-inline">
            <input
              type="checkbox"
              checked={row.archived}
              onChange={(e) => onChange({ archived: e.target.checked })}
            />
            <Archive size={13} /> Куплено
          </label>
        </div>
        <input
          aria-label="Ссылка на магазин"
          type="url"
          placeholder="Ссылка на магазин (https://…)"
          value={row.shopUrl}
          onChange={(e) => onChange({ shopUrl: e.target.value })}
        />
        <textarea
          aria-label="Комментарий"
          rows={
            row.description
              ? Math.min(4, row.description.split("\n").length + 1)
              : 1
          }
          maxLength={2000}
          placeholder="Комментарий"
          value={row.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
    </article>
  );
}
