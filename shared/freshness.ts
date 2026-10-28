// «Подтвердить актуальность» (П36): a confirmation lasts 30 days, counted from the
// moment it was pressed. Exactly 30 days is still fresh; strictly more is not.
export const FRESH_DAYS = 30;
export type Freshness = "fresh" | "stale" | "never";
export function freshness(
  checkedAt: number | null | undefined,
  now = Date.now(),
): Freshness {
  if (!checkedAt) return "never";
  return now - checkedAt * 1000 <= FRESH_DAYS * 86400_000 ? "fresh" : "stale";
}
