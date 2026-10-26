import React from "react";
import { Heart } from "lucide-react";
import { priceInRubMinor, rublesPerUnit } from "../shared/wish-price";
import type { Wish } from "./types";

/** Price bounds in whole units of `currency`; null means «no bound». */
export type PriceBounds = { from: number | null; to: number | null };
export type Filters = {
  price: PriceBounds;
  minPriority: number;
  availability: "all" | "available" | "reserved";
};
export const noFilters: Filters = {
  price: { from: null, to: null },
  minPriority: 0,
  availability: "all",
};
const symbols: Record<string, string> = {
  RUB: "₽",
  RUR: "₽",
  USD: "$",
  EUR: "€",
  GBP: "£",
  GEL: "₾",
  TRY: "₺",
  KZT: "₸",
  UAH: "₴",
  BYN: "Br",
};
/**
 * The slider works in the list's own currency when all priced wishes share one
 * (the usual case), otherwise in roubles through the rounded rates.
 */
export function priceScale(list: Wish[]) {
  const priced = list.filter((g) => priceInRubMinor(g) !== null);
  const currencies = new Set(priced.map((g) => g.currency.toUpperCase()));
  const currency = currencies.size === 1 ? [...currencies][0] : "RUB";
  const rate = rublesPerUnit[currency] ?? 1;
  const top = Math.max(
    0,
    ...priced.map((g) => (priceInRubMinor(g) as number) / 100 / rate),
  );
  const step = niceStep(top);
  return {
    currency,
    symbol: symbols[currency] || currency,
    rate,
    step,
    max: Math.max(step, Math.ceil(top / step) * step),
  };
}
function niceStep(top: number) {
  const raw = top / 40;
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}
export function activeCount(f: Filters, foreign: boolean) {
  return (
    (f.price.from !== null || f.price.to !== null ? 1 : 0) +
    (f.minPriority ? 1 : 0) +
    (foreign && f.availability !== "all" ? 1 : 0)
  );
}
/** Whether a wish passes the filters; `rate` turns slider units into roubles. */
export function passes(g: Wish, f: Filters, rate: number, foreign: boolean) {
  const price = priceInRubMinor(g);
  const { from, to } = f.price;
  if (from !== null && (price === null || price < from * rate * 100))
    return false;
  if (to !== null && (price === null || price > to * rate * 100)) return false;
  if (g.priority < f.minPriority) return false;
  if (foreign && f.availability !== "all") {
    const available = g.reservation === "available";
    if (f.availability === "available" ? !available : available) return false;
  }
  return true;
}
const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};
const money = (n: number, symbol: string) =>
  `${n.toLocaleString("ru-RU")} ${symbol}`;
/** Filters apply as you move them: there is nothing to submit. */
export function WishFilters({
  list,
  value,
  onChange,
  foreign,
}: {
  list: Wish[];
  value: Filters;
  onChange: (next: Filters) => void;
  foreign: boolean;
}) {
  const scale = priceScale(list);
  const from = value.price.from ?? 0,
    to = value.price.to ?? scale.max;
  const setPrice = (lo: number, hi: number) =>
    onChange({
      ...value,
      price: {
        from: lo <= 0 ? null : lo,
        to: hi >= scale.max ? null : hi,
      },
    });
  const pct = (n: number) => Math.min(n, scale.max) / scale.max;
  const typed = (edge: "from" | "to", text: string) => {
    const n = text.trim() === "" ? null : Math.max(0, Math.round(Number(text)));
    onChange({
      ...value,
      price: { ...value.price, [edge]: n === null || isNaN(n) ? null : n },
    });
  };
  return (
    <section className="wish-filters" aria-label="Фильтры желаний">
      <div className="filter-group price-filter">
        <div className="filter-label">
          <span>Цена, {scale.symbol}</span>
        </div>
        {/* Typed and dragged values are the same state: either moves the other. */}
        <div className="price-inputs">
          <label>
            <span>от</span>
            <input
              type="number"
              inputMode="numeric"
              enterKeyHint="done"
              min={0}
              placeholder="0"
              value={value.price.from ?? ""}
              onChange={(e) => typed("from", e.target.value)}
              onKeyDown={blurOnEnter}
              aria-label="Цена от"
            />
          </label>
          <span className="price-dash" aria-hidden="true">
            –
          </span>
          <label>
            <span>до</span>
            <input
              type="number"
              inputMode="numeric"
              enterKeyHint="done"
              min={0}
              placeholder={money(scale.max, "").trim()}
              value={value.price.to ?? ""}
              onChange={(e) => typed("to", e.target.value)}
              onKeyDown={blurOnEnter}
              aria-label="Цена до"
            />
          </label>
        </div>
        <div
          className="range"
          style={
            {
              "--lo": pct(from),
              "--hi": pct(to),
            } as React.CSSProperties
          }
        >
          <input
            type="range"
            min={0}
            max={scale.max}
            step={scale.step}
            value={Math.min(from, scale.max)}
            aria-label="Ползунок: цена от"
            onChange={(e) =>
              setPrice(Math.min(Number(e.target.value), to), to)
            }
          />
          <input
            type="range"
            min={0}
            max={scale.max}
            step={scale.step}
            value={Math.min(to, scale.max)}
            aria-label="Ползунок: цена до"
            onChange={(e) =>
              setPrice(from, Math.max(Number(e.target.value), from))
            }
          />
        </div>
        <div className="range-scale" aria-hidden="true">
          <span>0</span>
          <span>{money(scale.max, scale.symbol)}</span>
        </div>
      </div>
      <div className="filter-group">
        <div className="filter-label">
          <span>Насколько хочется</span>
        </div>
        <div className="chips" role="group" aria-label="Приоритет">
          {[0, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className="chip"
              aria-pressed={value.minPriority === n}
              onClick={() => onChange({ ...value, minPriority: n })}
            >
              {n ? (
                <>
                  <Heart size={13} fill="currentColor" />
                  {n === 5 ? "5" : `${n}+`}
                </>
              ) : (
                "Все"
              )}
            </button>
          ))}
        </div>
      </div>
      {foreign && (
        <div className="filter-group">
          <div className="filter-label">
            <span>Бронь</span>
          </div>
          <div className="chips" role="group" aria-label="Доступность">
            {(
              [
                ["all", "Все"],
                ["available", "Свободные"],
                ["reserved", "Забронированы"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="chip"
                aria-pressed={value.availability === key}
                onClick={() => onChange({ ...value, availability: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {activeCount(value, foreign) > 0 && (
        <button
          type="button"
          className="text-link filter-reset"
          onClick={() => onChange(noFilters)}
        >
          Сбросить
        </button>
      )}
    </section>
  );
}
