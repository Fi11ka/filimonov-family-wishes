import { formatPrice } from "../shared/price";
import type { EventSpec, Gender } from "../shared/events";
export type User = {
  id: string;
  name: string;
  username?: string | null;
  birthday?: string | null;
  allow_resharing?: number;
  wishlist_updated_at?: number | null;
  /** A few words under the wishlist title. */
  about?: string | null;
  /** Only in one's own profile. */
  gender?: Gender | null;
  events?: EventSpec[];
};
/** Friends the owner invited to an event; seen by the owner and those guests. */
export type Invitation = {
  key: string;
  date: string;
  title: string;
  mode: "hero" | "everyone";
  guests: { id: string; name: string; username: string | null }[];
};
export type Friend = User & { gift_count: number; subscribed?: boolean };
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
  archived_at?: number | null;
  /** «invited»: a friend asked me to share this gift. */
  reservation?: "available" | "mine" | "invited" | "reserved";
  /** For people in a shared booking: how many friends joined the organizer. */
  group_joined?: number | null;
  /** For guests of the owner's event: who of them booked it. */
  booked_by?: string[];
};
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
export type Booking = {
  gift_id: string;
  role: "organizer" | "joined" | "invited";
  title: string;
  price_minor: number | null;
  price_max_minor?: number | null;
  price_range?: number;
  currency: string;
  owner_id: string;
  owner_name: string;
  organizer_name: string | null;
  archived: number;
  /** The owner's events, to know by when to buy. */
  owner_events: EventSpec[];
  /** The owner's parties the user is invited to. */
  my_events?: { key: string; date: string }[];
  members: {
    id: string;
    name: string;
    username: string | null;
    status: "invited" | "joined";
  }[];
};
