/** Month and day only; no birth year or age is collected. */
export function validBirthday(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}-\d{2}$/.test(value)) return false;
  const [month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(2000, month - 1, day));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
/** Use calendar days in the viewer's timezone; DST does not change the count.
 * February 29 is celebrated on February 28 in a non-leap year. */
export function nextBirthday(value: string, today = new Date()) {
  if (!validBirthday(value)) return null;
  const [month, day] = value.split("-").map(Number);
  const current = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  function inYear(year: number) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Date.UTC(year, month - 1, Math.min(day, last));
  }
  let next = inYear(today.getFullYear());
  if (next < current) next = inYear(today.getFullYear() + 1);
  return {
    days: Math.round((next - current) / 86400000),
    date: new Date(next),
  };
}
