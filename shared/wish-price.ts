/**
 * Deliberately rounded exchange rates for comparing and filtering wishes.
 * They are not used for displaying or charging money, so a stable approximate
 * order is more useful here than a frequently changing market quote.
 */
export const rublesPerUnit: Readonly<Record<string, number>> = {
  RUB: 1,
  RUR: 1,
  USD: 90,
  EUR: 100,
  GBP: 117,
  GEL: 33,
  TRY: 2.5,
  KZT: 0.18,
  UAH: 2.2,
  BYN: 29,
};

export type ComparablePrice = {
  price_minor: number | null;
  price_max_minor?: number | null;
  currency: string;
};

/** A closed range is compared by its midpoint, not by either edge. */
export function averagePriceMinor(price: ComparablePrice): number | null {
  const min = price.price_minor,
    max = price.price_max_minor ?? null;
  if (min !== null && max !== null) return (min + max) / 2;
  return min ?? max;
}

/** Approximate value in kopecks, suitable only for sorting and filtering. */
export function priceInRubMinor(price: ComparablePrice): number | null {
  const amount = averagePriceMinor(price),
    rate = rublesPerUnit[price.currency.toUpperCase()];
  return amount === null || rate === undefined
    ? null
    : Math.round(amount * rate);
}

/** Wishes without a comparable price are always placed after priced wishes. */
export function comparePrice(
  a: ComparablePrice,
  b: ComparablePrice,
  direction: 1 | -1,
) {
  const left = priceInRubMinor(a),
    right = priceInRubMinor(b);
  if (left === null || right === null)
    return left === right ? 0 : left === null ? 1 : -1;
  return direction * (left - right);
}
