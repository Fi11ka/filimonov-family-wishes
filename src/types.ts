export type User = { id: string; name: string };
export type Family = { id: string; name: string; owner_id: string };
export type Wish = {
  id: string;
  owner_id: string;
  title: string;
  price_minor: number | null;
  currency: string;
  description: string;
  priority: number;
  shop_url: string;
  has_photo: number;
  photo?: string;
  reservation?: "available" | "mine" | "reserved";
};
export type Member = User & { gift_count: number };
export const priorities = ["", "Будет приятно", "Очень хочется", "Мечта"];
export const initials = (s: string) =>
  s
    .split(" ")
    .slice(0, 2)
    .map((v) => v[0])
    .join("");
export const wishCount = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? "желание" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "желания" : "желаний"}`;
export const money = (g: Wish) =>
  g.price_minor === null
    ? "Цена не указана"
    : new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: g.currency,
        maximumFractionDigits: g.price_minor % 100 ? 2 : 0,
      }).format(g.price_minor / 100);
