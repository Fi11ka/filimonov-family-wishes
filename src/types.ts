import { formatPrice } from "../shared/price";
export type User = {
  id: string;
  name: string;
  username?: string | null;
  birthday?: string | null;
  allow_resharing?: number;
  wishlist_updated_at?: number | null;
};
export type Friend = User & { gift_count: number };
export type Wish = {
  id: string;
  owner_id: string;
  title: string;
  price_minor: number | null;
  price_max_minor?: number | null;
  price_range?: number;
  currency: string;
  description: string;
  priority: number;
  shop_url: string;
  has_photo: number;
  photo?: string;
  archive_reason?: "changed_mind" | "gifted" | "bought_self" | null;
  gifted_by_name?: string | null;
  gifted_by_username?: string | null;
  archived_at?: number | null;
  reservation?: "available" | "mine" | "reserved";
};
export const priorities = ["", "Будет приятно", "Очень хочется", "Мечта"];
export const initials = (s: string) =>
  s
    .split(" ")
    .slice(0, 2)
    .map((v) => v[0])
    .join("");
export const handle = (u: User | null | undefined) =>
  u?.username ? `@${u.username}` : "";
export const wishCount = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? "желание" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "желания" : "желаний"}`;
export const money = (g: Wish) => formatPrice(g);
