import { formatPrice } from "../shared/price";
import type { EventSpec, Gender } from "../shared/events";
export type User = {
  id: string;
  name: string;
  username?: string | null;
  birthday?: string | null;
  allow_resharing?: number;
  /** A closed profile shows its list only to friends it approved. */
  is_private?: boolean;
  wishlist_updated_at?: number | null;
  /** «Подтвердить актуальность»: when the owner last confirmed the list. */
  checked_at?: number | null;
  /** A few words under the wishlist title. */
  about?: string | null;
  /** Only in one's own profile. */
  gender?: Gender | null;
  /** Version of the profile photo; null or absent when there is none. */
  photo_at?: number | null;
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
/** Someone in «Друзья»: the public card and whether we added each other. */
export type Person = User & {
  gift_count: number;
  /** I added them: waiting for approval, or their list is open to me. */
  follow?: "pending" | "approved" | null;
  /** They added me, and my list is open to them. */
  follows_you?: boolean;
};
/** My people (my friends and those who added me): whom I can invite to an event or a shared gift. */
export type Friend = Person;
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
  /** Changes with every edit; tells a new photo from a remembered one. */
  updated_at?: number;
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
  owner_photo_at?: number | null;
  organizer_name: string | null;
  archived: number;
  shop_url?: string;
  has_photo?: number;
  updated_at?: number;
  /** The owner changed these since I chose it: "title", "price", "link". */
  changed_fields?: string | null;
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
/**
 * What I keep of my own choice once the owner closed it («Требует внимания»), or
 * what I confirmed I gave («Подаренные»): the gift as it was then.
 */
export type GiverRecord = {
  gift_id: string;
  owner_id: string;
  owner_name: string;
  owner_photo_at: number | null;
  title: string;
  price_minor: number | null;
  price_max_minor: number | null;
  price_range: number;
  currency: string;
  shop_url: string;
  has_photo: number;
  reason: "deleted" | "changed_mind" | "bought_self" | "gifted" | null;
  changed_at: number | null;
  gifted_at: number | null;
};
/** How a toast reads: done, a hint that nothing changed, or a failure. */
export type ToastTone = "ok" | "info" | "error";
/** A button in a toast, e.g. «Вернуть» after cancelling a booking. */
export type ToastAction = { label: string; run: () => Promise<void> | void };
/** A list someone keeps for a person close to them (П35); checked_at is its own «актуальность». */
export type ListRef = { id: string; name: string; checked_at?: number | null };
