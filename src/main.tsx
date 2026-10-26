import { ACCOUNT_ID_PART } from "../shared/account-id";
import { eventDay, untilText, upcomingEvents } from "../shared/events";
import { formatPrice, sharePrice } from "../shared/price";
import { EventPage, EventsList, WishlistEvents } from "./events";
import { ArchiveWish, ReserveDialog } from "./forms";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Gift,
  Heart,
  Users,
  Bookmark,
  CalendarDays,
  ArrowLeft,
  Plus,
  ArrowUpRight,
  Link as LinkIcon,
  X,
  Check,
  CircleAlert,
  Info,
  Sparkles,
  Search,
  ChevronDown,
  Pencil,
  Trash2,
  RefreshCw,
  Eye,
  ShoppingBag,
  Undo2,
  Clock,
  ChevronRight,
  Archive,
  ArchiveRestore,
  FileSpreadsheet,
  UserPlus,
  UserMinus,
  Maximize2,
  Minimize2,
  Bell,
  BellRing,
  Globe,
  Send,
  Bot,
  Lock,
  SlidersHorizontal,
} from "lucide-react";
import { useFullscreen } from "./fullscreen";
import { Hearts } from "./hearts";
import {
  api,
  apiConfigured,
  BOT,
  demo,
  guestCodes,
  guestToken,
  legacyLink,
  openBot,
  openInBrowser,
  openTarget,
  photoFromUrl,
  profileLink,
  profileTarget,
  redeemHandoff,
  setGuestCode,
  setSessionToken,
  signedIn,
  telegram,
  telegramLink,
  type Notifications,
} from "./api";
import { WebLogin } from "./login";
import {
  demoArchive,
  demoBookings,
  demoFriends,
  demoGifts,
  demoIncoming,
  demoUser,
} from "./demo";
import { GiftForm, Share, Modal, Confirm } from "./forms";
import { Profile } from "./friends";
import { Features, Welcome } from "./welcome";
import { Notifications as NotesList } from "./notifications";
import { telegramAppLink } from "./telegram-links";
import { Face } from "./avatar";
import { ImportDialog } from "./import/ImportDialog";
import { comparePrice } from "../shared/wish-price";
import {
  WishFilters,
  activeCount,
  noFilters,
  passes,
  priceScale,
  type Filters,
} from "./filters";
import {
  type Booking,
  type Invitation,
  type ToastTone,
  type User,
  type Friend,
  type Person,
  type Wish,
  initials,
  handle,
  wishCount,
  money,
} from "./types";
import "./style.css";
type Tab =
  | "mine"
  | "friends"
  | "bookings"
  | "events"
  | "archive"
  | "event"
  | "notifications";
type ModalKind = "gift" | "share" | "profile" | "import";
/** «Подписки»: whom I follow, my followers, requests to follow me. */
type People = {
  following: Person[];
  followers: Person[];
  requests: Person[];
  outgoing: Person[];
};
/** A profile opened in «Подписки»: its card, and whether its list is open to me. */
type Viewed = { card: Person & { is_private?: boolean }; can_view: boolean };
interface Confirmation {
  text: string;
  action: string;
  danger?: boolean;
  run: () => Promise<void>;
}
function App() {
  const [user, setUser] = useState<User | null>(demo ? demoUser : null),
    [people, setPeople] = useState<People>({
      following: demo ? demoFriends : [],
      followers: demo ? demoFriends : [],
      requests: demo ? demoIncoming.map((p) => ({ ...p, gift_count: 0 })) : [],
      outgoing: [],
    }),
    [peopleTab, setPeopleTab] = useState<"following" | "followers">(
      "following",
    ),
    [viewed, setViewed] = useState<Viewed | null>(null);
  // My people, whom I can invite to an event or a shared gift.
  const friends: Friend[] = [
    ...people.following,
    ...people.followers.filter(
      (f) => !people.following.some((x) => x.id === f.id),
    ),
  ];
  const [owner, setOwner] = useState<User | null>(demo ? demoUser : null),
    [gifts, setGifts] = useState<Wish[]>(demo ? demoGifts : []),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [archive, setArchive] = useState<Wish[]>(demo ? demoArchive : []);
  const [tab, setTab] = useState<Tab>(
      guestToken || profileTarget || legacyLink ? "friends" : "mine",
    ),
    [loading, setLoading] = useState(!demo),
    [error, setError] = useState(""),
    [toast, setToast] = useState<{ text: string; tone: ToastTone } | null>(
      null,
    );
  const [modal, setModal] = useState<ModalKind | null>(null),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [editing, setEditing] = useState<Wish | null>(null),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("priority"),
    [filtersOpen, setFiltersOpen] = useState(false),
    [filters, setFilters] = useState<Filters>(noFilters);
  const [bookings, setBookings] = useState<Booking[]>([]),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState(false),
    [opening, setOpening] = useState(false),
    [webSession, setWebSession] = useState(false);
  /** Unread «Уведомления»: the badge on the bell in the header. */
  const [unread, setUnread] = useState(0);
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setToday(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  const [archiveGift, setArchiveGift] = useState<Wish | null>(null);
  /** A list opened from an event page where guests' bookings carry names. */
  const [namedList, setNamedList] = useState<{
    owner: string;
    event: string;
  } | null>(null);
  const [eventRef, setEventRef] = useState<{
    owner: string;
    key: string;
    date: string;
    /** Where «Назад» returns to. */
    from: Tab;
  } | null>(null);
  function openEvent(owner: string, key: string, date: string) {
    setEventRef({ owner, key, date, from: tab });
    setTab("event");
    setError("");
    setMenu(false);
  }
  /** A participant's wishlist from the event page. */
  async function openList(id: string, named?: string) {
    if (user && id === user.id) await navigate("mine");
    else {
      await openPerson(id);
      setNamedList(named ? { owner: id, event: named } : null);
    }
  }
  const [giftDirty, setGiftDirty] = useState(false);
  const [giftSaving, setGiftSaving] = useState(false);
  function closeEditor() {
    if (giftSaving) return;
    if (modal === "gift" && giftDirty) {
      setConfirmation({
        text: "Изменения в желании ещё не сохранены. Закрыть карточку и потерять ввод?",
        action: "Закрыть без сохранения",
        danger: true,
        run: async () => {
          setModal(null);
          setGiftDirty(false);
        },
      });
    } else setModal(null);
  }
  useEffect(() => {
    if (!giftDirty || modal !== "gift") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [giftDirty, modal]);
  const [guestGift, setGuestGift] = useState<Wish | null>(null);
  const [reserving, setReserving] = useState<{
    gift: { id: string; title: string };
    ownerId: string;
    exclude?: string[];
    invite?: boolean;
  } | null>(null);
  const [guestName, setGuestName] = useState("");
  /** Whose profile a link opened: the welcome dialog names them. */
  const [sharedOwner, setSharedOwner] = useState("");
  const sharedOpened = useRef(false);
  /** The first-visit tour, with the bot status for its «Открыть бота». */
  const [welcome, setWelcome] = useState<Notifications | null | false>(false);
  const welcomeShown = useRef(false);
  /** A guest link opened without an account: only that list, with bookings by name.
   * Signed in, the link just opens the list and the rest of the app works as usual. */
  const guestView = () => !!guestToken && !signedIn();
  const own = !!user && owner?.id === user.id;
  const notice = (message: string, tone: ToastTone = "ok") => {
    setToast({ text: message, tone });
    setTimeout(() => setToast(null), 4500);
  };
  const fullscreen = useFullscreen((message) => notice(message, "error"));
  async function countUnread() {
    if (demo || !signedIn()) return;
    const r = await api("/api/notifications?count=1").catch(() => null);
    if (r) setUnread(r.unread);
  }
  useEffect(() => {
    if (!user) return;
    void countUnread();
    // The bot may write any time; check now and then and when the app comes back.
    const timer = setInterval(() => void countUnread(), 60000);
    const back = () => {
      if (document.visibilityState === "visible") void countUnread();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [user?.id]);
  /** Where a notification leads: a profile, «Мои брони», an event, or the followers. */
  async function openNote(target: string) {
    const e = target.match(
      new RegExp(`^e_(${ACCOUNT_ID_PART})_([a-z0-9_]+)_(\\d{4}-\\d{2}-\\d{2})$`),
    );
    if (new RegExp(`^l_(${ACCOUNT_ID_PART})$`).test(target)) {
      if (target.slice(2) === user?.id) await navigate("mine");
      else await openPerson(target.slice(2));
    } else if (target === "b") await navigate("bookings");
    else if (target === "f") {
      setPeopleTab("followers");
      await navigate("friends");
    } else if (e) openEvent(e[1], e[2], e[3]);
  }
  async function loadList(id: string) {
    setLoading(true);
    setError("");
    try {
      const d = await api(`/api/lists/${id}`);
      setGifts(d.gifts);
      setOwner(d.owner);
      setInvitations(d.invitations || []);
    } catch (e) {
      setError((e as Error).message);
      setGifts([]);
    } finally {
      setLoading(false);
    }
  }
  async function loadFriends() {
    if (demo) return;
    setPeople(await api("/api/people"));
  }
  /**
   * Someone's profile in «Подписки»: their list when it is open to me, or the
   * card with «Подписаться» / «Запросить доступ».
   */
  async function openPerson(id: string) {
    setTab("friends");
    setNamedList(null);
    setFilters(noFilters);
    setSearch("");
    setError("");
    if (demo) {
      const f = friends.find((x) => x.id === id);
      if (f) openFriend(f);
      return;
    }
    setLoading(true);
    try {
      const p: Viewed = await api(`/api/profiles/${id}`);
      setViewed(p);
      if (p.can_view) await loadList(id);
      else {
        setOwner(p.card);
        setGifts([]);
        setInvitations([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function loadArchive() {
    if (demo) return;
    setLoading(true);
    try {
      const d = await api("/api/archive");
      setArchive(d.gifts);
      setOwner(d.owner);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function refresh() {
    if (demo) return;
    setLoading(true);
    setError("");
    try {
      if (guestView()) {
        const d = await api("/api/guest");
        setOwner(d.owner);
        setGifts(d.gifts);
        setInvitations(d.invitations || []);
      } else if (!signedIn()) {
        // A profile link opened without signing in: an open list, or the card.
        const id = profileTarget || (await linkedProfile());
        if (id) await openPerson(id);
      } else if (signedIn()) {
        const me = await api("/api/me");
        setUser(me.user);
        setWebSession(!!me.web_session);
        if (me.welcome && !welcomeShown.current) {
          welcomeShown.current = true;
          setWelcome(me.notifications || null);
        }
        await loadFriends();
        let id = tab === "mine" || !owner ? me.user.id : owner.id;
        if (!sharedOpened.current && (guestToken || profileTarget || legacyLink)) {
          // First open of a link: show that profile; the rest of the app works as usual.
          sharedOpened.current = true;
          const shared = guestToken
            ? (await api("/api/guest").catch(() => null))?.owner.id
            : profileTarget || (await linkedProfile());
          if (!shared) notice("Ссылка не найдена или отозвана", "error");
          else if (shared !== me.user.id) {
            setSharedOwner(shared);
            await openPerson(shared);
            return;
          } else setTab("mine");
        }
        if (tab === "friends" && viewed && owner?.id === viewed.card.id) {
          // Stay on the profile; its access may have changed.
          await openPerson(viewed.card.id);
          return;
        }
        const d = await api(`/api/lists/${id}`);
        setOwner(d.owner);
        setGifts(d.gifts);
        setInvitations(d.invitations || []);
      }
    } catch (e) {
      setError((e as Error).message);
      // A revoked website session is cleared by api(); show the sign-in screen.
      if (!signedIn()) setUser(null);
    } finally {
      setLoading(false);
    }
  }
  /** Whose profile an old «Поделиться» or friend invitation link leads to. */
  async function linkedProfile(): Promise<string> {
    if (!legacyLink) return "";
    return api("/api/links/resolve", "POST", { token: legacyLink })
      .then((r) => r.owner_id as string)
      .catch(() => "");
  }
  async function logout(everywhere: boolean) {
    try {
      await api(
        everywhere ? "/api/auth/logout-all" : "/api/auth/logout",
        "POST",
        {},
      );
    } catch {
      // Signing out locally still works when the network is down.
    }
    setModal(null);
    if (!webSession) {
      notice("Входы на сайте завершены на всех устройствах");
      return;
    }
    setSessionToken(null);
    setWebSession(false);
    setUser(null);
    setOwner(null);
    setGifts([]);
    setPeople({ following: [], followers: [], requests: [], outgoing: [] });
    setViewed(null);
    setTab("mine");
    notice("Вы вышли из аккаунта");
  }
  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    if (telegram?.initData) {
      telegram.setHeaderColor("#f8f6fc");
      telegram.setBackgroundColor("#f8f6fc");
    }
    // «В браузере» from the Mini App: sign in with its one-time code first.
    const handoff = redeemHandoff().catch((e) =>
      notice((e as Error).message, "error"),
    );
    void handoff.then(refresh).then(async () => {
      // Buttons in bot messages open a profile or «Мои брони».
      if (demo || !signedIn() || guestToken || profileTarget || legacyLink)
        return;
      // Opened from a bot button: that message has been seen.
      if (openTarget)
        void api("/api/notifications/read", "POST", { open: openTarget })
          .then(countUnread)
          .catch(() => undefined);
      if (new RegExp(`^l_(${ACCOUNT_ID_PART})$`).test(openTarget))
        await openPerson(openTarget.slice(2));
      else if (openTarget === "b") await navigate("bookings");
      else {
        const e = openTarget.match(
          new RegExp(
            `^e_(${ACCOUNT_ID_PART})_([a-z0-9_]+)_(\\d{4}-\\d{2}-\\d{2})$`,
          ),
        );
        if (e) openEvent(e[1], e[2], e[3]);
      }
    });
  }, []);
  async function navigate(next: Tab) {
    setMenu(false);
    setNamedList(null);
    setFilters(noFilters);
    setTab(next);
    setSearch("");
    setError("");
    if (demo) {
      if (next === "mine") {
        setOwner(user || demoUser);
        setGifts(demoGifts);
      }
      if (next === "archive") setOwner(user || demoUser);
      if (next === "friends") {
        setOwner(null);
        setGifts([]);
      }
      if (next === "bookings") setBookings(demoBookings);
      return;
    }
    if (next === "mine" && user) await loadList(user.id);
    if (next === "friends" && guestView()) await refresh();
    if (next === "friends" && !guestView()) {
      setOwner(null);
      setGifts([]);
      setViewed(null);
      try {
        await loadFriends();
      } catch (e) {
        setError((e as Error).message);
      }
    }
    if (next === "archive") await loadArchive();
    if (next === "bookings") await loadBookings();
  }
  async function loadBookings() {
    setLoading(true);
    try {
      setBookings((await api("/api/reservations")).reservations);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function openFriend(f: Friend) {
    setNamedList(null);
    setFilters(noFilters);
    if (demo) {
      setTab("friends");
      setViewed({ card: { ...f, follow: "approved" }, can_view: true });
      setOwner(f);
      setGifts(
        demoGifts.slice(0, f.gift_count).map((g, n) => ({
          ...g,
          owner_id: f.id,
          reservation: n === 1 ? "reserved" : n === 2 ? "mine" : "available",
        })),
      );
      return;
    }
    void openPerson(f.id);
  }
  async function guarded(action: () => Promise<void>, demoMessage: string) {
    if (demo) {
      notice(demoMessage, "info");
      return;
    }
    setBusy(true);
    try {
      await action();
    } catch (e) {
      notice((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function reserve(g: Wish) {
    if (guestView()) {
      if (g.reservation === "reserved" && guestCodes()[g.id])
        setConfirmation({
          text: `Отменить бронь «${g.title}»? Подарок снова станет свободным, его сможет забронировать кто-то другой.`,
          action: "Отменить бронь",
          danger: true,
          run: () =>
            guarded(async () => {
              try {
                await api(`/api/guest-reservations/${g.id}/cancel`, "POST", {
                  code: guestCodes()[g.id],
                });
                notice("Бронь отменена");
              } finally {
                // Cancelled now or earlier by someone else: the code is no longer needed.
                setGuestCode(g.id, null);
                await refresh();
              }
            }, ""),
        });
      else setGuestGift(g);
      return;
    }
    if (g.reservation !== "mine") {
      // My people are needed to offer «Подарить вместе»; a link may come without them.
      if (!friends.length) await loadFriends().catch(() => undefined);
      setReserving({ gift: g, ownerId: g.owner_id });
      return;
    }
    setConfirmation({
      text: g.group_joined
        ? `Отменить бронь «${g.title}»? Это совместный подарок, бот сообщит об этом в Telegram.`
        : `Отменить бронь «${g.title}»? Подарок снова станет свободным, его сможет забронировать кто-то другой.`,
      action: "Отменить бронь",
      danger: true,
      run: () =>
        guarded(async () => {
          try {
            await api(`/api/gifts/${g.id}/reservation`, "DELETE");
            notice("Бронь отменена");
          } finally {
            if (owner) await loadList(owner.id);
          }
        }, "Бронирование доступно после подключения приложения."),
    });
  }
  async function answerInvite(giftId: string, join: boolean) {
    await guarded(async () => {
      try {
        await api(
          `/api/gifts/${giftId}/reservation/${join ? "join" : "decline"}`,
          "POST",
        );
        telegram?.HapticFeedback?.notificationOccurred("success");
        notice(join ? "Вы участвуете в подарке" : "Приглашение отклонено");
      } finally {
        if (tab === "bookings") await loadBookings();
        else if (owner) await loadList(owner.id);
      }
    }, "В демо брони не меняются.");
  }
  function cancelBooking(b: Booking) {
    const organizer = b.role === "organizer";
    setConfirmation({
      text: !organizer
        ? `Выйти из совместного подарка «${b.title}»? Бронь останется за организатором, бот ему сообщит.`
        : b.members.length
          ? `Отменить бронь «${b.title}»? Совместный подарок отменится для всех участников, бот им сообщит.`
          : `Отменить бронь «${b.title}»? Подарок снова станет свободным, его сможет забронировать кто-то другой.`,
      action: organizer ? "Отменить бронь" : "Выйти",
      danger: true,
      run: () =>
        guarded(async () => {
          await api(`/api/gifts/${b.gift_id}/reservation`, "DELETE");
          setBookings((list) => list.filter((x) => x.gift_id !== b.gift_id));
          notice(organizer ? "Бронь отменена" : "Вы вышли из подарка");
        }, "Бронирование доступно после подключения приложения."),
    });
  }
  /** «Куплю сам»: the organizer keeps the booking, the others leave it. */
  function buyAlone(b: Booking) {
    const names = b.members.map((m) => m.name).join(", ");
    setConfirmation({
      text: `Совместный подарок отменится: ${names} выйдут из брони и получат сообщение в Telegram. Бронь останется за вами.`,
      action: "Куплю сам",
      run: () =>
        guarded(async () => {
          await api(`/api/gifts/${b.gift_id}/reservation/members`, "DELETE");
          setBookings((list) =>
            list.map((x) =>
              x.gift_id === b.gift_id ? { ...x, members: [] } : x,
            ),
          );
          notice("Теперь это ваш подарок, участникам ушло сообщение");
        }, "В демо брони не меняются."),
    });
  }
  async function toggleSubscription(f: Person) {
    await guarded(async () => {
      const r = await api(
        `/api/subscriptions/${f.id}`,
        f.subscribed ? "DELETE" : "PUT",
      );
      setViewed((v) =>
        v && v.card.id === f.id
          ? { ...v, card: { ...v.card, subscribed: r.subscribed } }
          : v,
      );
      void loadFriends().catch(() => undefined);
      if (r.subscribed && !r.notifications.bot_connected) {
        notice("Уведомления включены. Откройте бота и нажмите «Запустить»");
        openBot(r.notifications.bot_url);
      } else if (r.subscribed && !r.notifications.enabled)
        notice(
          "Уведомления включены, но в профиле выключены сообщения бота",
          "info",
        );
      else
        notice(
          r.subscribed
            ? `Бот напишет, когда ${f.name.split(" ")[0]} изменит вишлист`
            : "Уведомления о вишлисте выключены",
        );
    }, "В демо уведомления не включаются.");
  }
  async function markBought(g: Wish) {
    setArchiveGift(g);
  }
  async function restore(g: Wish) {
    await guarded(async () => {
      await api(`/api/gifts/${g.id}/restore`, "POST");
      await loadArchive();
      notice("Желание снова в вишлисте");
    }, "В демо архив не меняется.");
  }
  function remove(g: Wish, fromArchive: boolean) {
    setConfirmation({
      text: `Удалить «${g.title}» навсегда? Это действие нельзя отменить. Если подарок уже подарили, лучше нажмите «Отправить в архив» — он сохранится там.`,
      action: "Удалить",
      danger: true,
      run: () =>
        guarded(async () => {
          await api(`/api/gifts/${g.id}`, "DELETE");
          if (fromArchive) await loadArchive();
          else if (user) await loadList(user.id);
          notice("Желание удалено");
        }, "В демо удаление недоступно."),
    });
  }
  /** «Подписаться» / «Запросить доступ»: an open profile at once, a closed one after approval. */
  async function followPerson(p: Person) {
    await guarded(async () => {
      const r = await api(`/api/follows/${p.id}`, "POST");
      notice(
        r.follow === "approved"
          ? "Вы подписались"
          : "Запрос отправлен. Вишлист откроется, когда его одобрят",
      );
      await loadFriends();
      await openPerson(p.id);
    }, "В демо подписки не меняются.");
  }
  function unfollow(p: Person) {
    const pending = p.follow === "pending";
    setConfirmation({
      text: pending
        ? "Отменить запрос на подписку? Он ещё ждёт одобрения."
        : `Отписаться?${p.is_private ? " Профиль закрытый: чтобы снова видеть вишлист, придётся запросить доступ." : ""} Уже сделанные брони сохранятся.`,
      action: pending ? "Отменить запрос" : "Отписаться",
      danger: !pending,
      run: () =>
        guarded(async () => {
          await api(`/api/follows/${p.id}`, "DELETE");
          await loadFriends();
          await openPerson(p.id);
          notice(pending ? "Запрос отменён" : "Вы отписались");
        }, "В демо подписки не меняются."),
    });
  }
  async function approveFollower(p: Person) {
    await guarded(async () => {
      await api(`/api/followers/${p.id}/approve`, "POST");
      notice("Подписка одобрена");
      await loadFriends();
    }, "В демо подписки не меняются.");
  }
  async function declineFollower(p: Person) {
    await guarded(async () => {
      await api(`/api/followers/${p.id}`, "DELETE");
      notice("Запрос отклонён");
      await loadFriends();
    }, "В демо подписки не меняются.");
  }
  /** Take my list away from a follower; they are not told. */
  function removeFollower(p: Person) {
    setConfirmation({
      text: `Убрать из подписчиков: ${p.name}? Если ваш профиль закрытый, этот человек перестанет видеть вишлист. Сообщения об этом не будет.`,
      action: "Убрать",
      danger: true,
      run: () =>
        guarded(async () => {
          await api(`/api/followers/${p.id}`, "DELETE");
          await loadFriends();
          await openPerson(p.id);
          notice("Убрано из подписчиков");
        }, "В демо подписки не меняются."),
    });
  }
  const list = tab === "archive" ? archive : gifts;
  const foreignList = !own && tab !== "archive";
  const scale = priceScale(list);
  const activeFilters = activeCount(filters, foreignList) > 0;
  const shown = list
    .filter(
      (g) =>
        g.title.toLowerCase().includes(search.toLowerCase()) &&
        passes(g, filters, scale.rate, foreignList),
    )
    .sort((a, b) =>
      sort === "price"
        ? comparePrice(a, b, 1)
        : sort === "price-desc"
          ? comparePrice(a, b, -1)
          : sort === "priority-asc"
            ? a.priority - b.priority
            : b.priority - a.priority,
    );
  // Without signing in only a guest link or an open profile shows a list.
  const visitor = !user && !!viewed?.can_view;
  const locked = !demo && !user && !guestToken && !visitor && !loading;
  const viewingFriend = tab === "friends" && !!owner && !own;
  // A closed profile I do not follow shows its card instead of the list.
  const closedCard =
    viewingFriend && !demo && !!viewed && viewed.card.id === owner?.id && !viewed.can_view;
  const showList =
    tab === "mine" ||
    tab === "archive" ||
    guestView() ||
    (viewingFriend && !closedCard);
  const ownerFirst = owner?.name.split(" ")[0] || "друга";
  // «Поделиться» on someone's profile shares theirs; anywhere else my own.
  const sharingOwn = !(tab === "friends" && owner && !own);
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? "is-open" : ""}`}>
        <a className="brand" href="./">
          <span className="brand-icon">
            <Gift size={25} />
          </span>
          <span>
            Filimonov<span className="brand-sub">FAMILY WISHES</span>
          </span>
        </a>
        <nav aria-label="Основная навигация">
          {(
            [
              ["mine", Heart, "Мой вишлист", "Вишлист"],
              ["friends", Users, "Подписки", "Подписки"],
              ["bookings", Bookmark, "Мои брони", "Брони"],
              ["events", CalendarDays, "Мероприятия", "Мероприятия"],
              ["archive", Archive, "Архив", "Архив"],
            ] as const
          ).map(([key, I, label, short]) => (
            <button
              key={key}
              className={`nav-item ${tab === key || (key === "events" && tab === "event") ? "active" : ""}`}
              onClick={() => void navigate(key)}
              disabled={!user && !demo && key !== "friends"}
            >
              <I size={20} />
              <span className="nav-label">{label}</span>
              {/* The phone tab bar has no room for the long names. */}
              <span className="nav-label-short">{short}</span>
              {key === "friends" && people.requests.length > 0 && (
                <span
                  className="nav-count"
                  aria-label={`Запросов: ${people.requests.length}`}
                >
                  {people.requests.length}
                </span>
              )}
              {tab === key && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          {/* On phones the sidebar turns into the bottom tab bar, so the brand moves up here. */}
          <a className="mobile-brand" href="./">
            <span className="brand-icon">
              <Gift size={18} />
            </span>
            Filimonov
          </a>
          <div className="topbar-right">
            {demo && <span className="demo-badge">Демо · без сохранения</span>}
            {fullscreen.supported && (
              <button
                className="icon-button fullscreen-toggle"
                onClick={fullscreen.toggle}
                aria-label={
                  fullscreen.on ? "Свернуть в окно" : "Развернуть на весь экран"
                }
                title={
                  fullscreen.on ? "Свернуть в окно" : "Развернуть на весь экран"
                }
              >
                {fullscreen.on ? (
                  <Minimize2 size={18} />
                ) : (
                  <Maximize2 size={18} />
                )}
              </button>
            )}
            {/* Switch between the Mini App and the website, keeping the account. */}
            {telegram?.initData
              ? user &&
                !demo && (
                  <button
                    className="switch-app"
                    disabled={opening}
                    onClick={() => {
                      setOpening(true);
                      void openInBrowser()
                        .catch((e) => notice((e as Error).message, "error"))
                        .finally(() => setOpening(false));
                    }}
                    aria-label="Открыть в браузере"
                    title="Открыть сайт в браузере — вы уже будете в своём аккаунте"
                  >
                    <Globe size={16} />
                    <span>В браузере</span>
                  </button>
                )
              : (user || demo) && (
                  <a
                    className="switch-app"
                    href={telegramLink()}
                    aria-label="Открыть в Telegram"
                    title="Открыть мини-приложение в Telegram"
                  >
                    <Send size={16} />
                    <span>В Telegram</span>
                  </a>
                )}
            {user && !demo && (
              <button
                className={`icon-button notes-button ${tab === "notifications" ? "active" : ""}`}
                onClick={() => void navigate("notifications")}
                aria-label={unread ? `Уведомления: ${unread} новых` : "Уведомления"}
                title="Уведомления"
              >
                <Bell size={18} />
                {unread > 0 && (
                  <span className="nav-count">{unread > 99 ? "99+" : unread}</span>
                )}
              </button>
            )}
            {/* The bot chat: notifications, reminders and answers to requests. */}
            <button
              className="switch-app"
              onClick={() => openBot(`https://t.me/${BOT}`)}
              aria-label="Открыть бота"
              title="Открыть чат с ботом в Telegram"
            >
              <Bot size={16} />
              <span>Открыть бота</span>
            </button>
            <span className="profile-name">
              {user ? handle(user) || user.name.split(" ")[0] : "Гость"}
            </span>
            <button
              className="avatar small profile-button"
              onClick={() => setModal("profile")}
              disabled={!user}
              aria-label="Мой профиль"
              title="Мой профиль"
            >
              <Face user={user} />
            </button>
          </div>
        </header>
        <main>
          {locked ? (
            <section className="welcome">
              {viewed ? (
                <>
                  <PersonCard card={viewed.card} />
                  <p>
                    Профиль закрытый. Войдите через Telegram и запросите доступ:
                    вишлист откроется, когда {viewed.card.name.split(" ")[0]}{" "}
                    одобрит подписку.
                  </p>
                </>
              ) : profileTarget || legacyLink ? (
                <>
                  <h1>Вам прислали профиль</h1>
                  <p>
                    Войдите через Telegram, чтобы открыть вишлист и забронировать
                    подарок. Это бесплатно и займёт минуту.
                  </p>
                </>
              ) : (
                <>
                  <h1>Вишлист</h1>
                  <p>
                    Войдите через Telegram, чтобы добавить желания и выбрать
                    подарки друзьям.
                  </p>
                </>
              )}
              {apiConfigured && !telegram?.initData && (
                <WebLogin onSignedIn={() => void refresh()} />
              )}
              <a className="text-link" href={telegramLink()}>
                Открыть в Telegram <ArrowUpRight size={15} />
              </a>
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              {!apiConfigured && (
                <p className="small-text">
                  Сервис пока недоступен. Попробуйте позже.
                </p>
              )}
              <a className="text-link" href="?demo=1">
                Попробовать демо
              </a>
              <Features />
            </section>
          ) : (
            <>
              {guestView() && (
                <div className="guest-banner">
                  <LinkIcon size={18} />
                  <span>Вишлист для близких · без регистрации</span>
                </div>
              )}
              {visitor && (
                <div className="guest-banner">
                  <LinkIcon size={18} />
                  <span>Открытый вишлист · чтобы забронировать, войдите</span>
                  <a href={telegramLink()}>
                    Открыть в Telegram <ArrowUpRight size={14} />
                  </a>
                </div>
              )}
              {guestView() && (
                <div className="guest-promo">
                  <p>
                    <strong>Хотите такой же?</strong> Заведите свой вишлист:
                    друзья увидят, что вам подарить, а бот напомнит об их днях
                    рождения.
                  </p>
                  <a className="button secondary" href={telegramAppLink()}>
                    <Gift size={16} /> Создать свой вишлист
                  </a>
                </div>
              )}
              {viewingFriend && user && (
                <button
                  className="text-link back-to-friends"
                  onClick={() => void navigate("friends")}
                >
                  <ArrowLeft size={15} /> Все подписки
                </button>
              )}
              <div
                className={`page-title ${owner && showList && tab !== "bookings" ? "page-head" : ""}`}
              >
                <div className="title-main">
                  <div className="title-line">
                  <h1>
                    {tab === "notifications"
                      ? "Уведомления"
                      : tab === "event"
                      ? "Мероприятие"
                      : tab === "events"
                        ? "Мероприятия"
                        : tab === "bookings"
                          ? "Мои брони"
                          : tab === "archive"
                            ? "Архив"
                            : tab === "friends" && !guestView() && !viewingFriend
                              ? "Подписки"
                              : own
                                ? "Мой вишлист"
                                : closedCard
                                  ? owner?.name || ownerFirst
                                  : `Вишлист: ${owner?.name || ownerFirst}`}
                  </h1>
                  {tab === "mine" && user && (
                    <button
                      className="share-button"
                      onClick={() => {
                        if (demo) {
                          notice("В демо ссылки не создаются.", "info");
                          return;
                        }
                        setModal("share");
                      }}
                    >
                      <LinkIcon size={15} />
                      Поделиться
                    </button>
                  )}
                  </div>
                  {owner && showList && tab !== "bookings" && !closedCard && (
                    <div className="wishlist-meta">
                      {tab !== "archive" && (
                        <WishlistEvents
                          owner={owner}
                          own={own}
                          today={today}
                          invitations={invitations}
                          friends={friends}
                          notice={notice}
                          onProfile={() => setModal("profile")}
                          onOpen={
                            user
                              ? (e) => openEvent(owner.id, e.key, e.date)
                              : undefined
                          }
                          onChanged={async () => {
                            if (own && user) {
                              setUser({
                                ...user,
                                ...(await api("/api/me")).user,
                              });
                            }
                            await loadList(owner.id);
                          }}
                        />
                      )}
                      {owner.wishlist_updated_at ? (
                        <time
                          dateTime={new Date(
                            owner.wishlist_updated_at * 1000,
                          ).toISOString()}
                        >
                          Обновлён{" "}
                          {new Date(
                            owner.wishlist_updated_at * 1000,
                          ).toLocaleString("ru-RU", {
                            day: "numeric",
                            month: "long",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      ) : null}
                    </div>
                  )}
                </div>
                {tab === "mine" && user && (
                  <div className="title-actions">
                    <button
                      className="button primary"
                      onClick={() => {
                        setEditing(null);
                        setGiftDirty(false);
                        setModal("gift");
                      }}
                    >
                      <Plus size={18} />
                      Добавить желание
                    </button>
                    <button
                      className="button tinted"
                      onClick={() => setModal("import")}
                    >
                      <FileSpreadsheet size={18} />
                      Добавить много
                    </button>
                  </div>
                )}
              </div>
              {error && (
                <div className="error" role="alert">
                  <span>{error}</span>
                  <button
                    onClick={() => void refresh()}
                    className="icon-button"
                    aria-label="Повторить"
                  >
                    <RefreshCw size={18} />
                  </button>
                </div>
              )}
              {!error && !loading && tab === "friends" && !guestView() && !viewingFriend && (
                <section className="family-section">
                  <div className="section-heading">
                    <div className="segmented people-tabs" role="tablist">
                      {(
                        [
                          ["following", "Подписки"],
                          ["followers", "Подписчики"],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          role="tab"
                          aria-selected={peopleTab === key}
                          className={peopleTab === key ? "selected" : ""}
                          onClick={() => setPeopleTab(key)}
                        >
                          {/* Waiting requests are not counted until approved. */}
                          {label} {people[key].length}
                          {key === "followers" && people.requests.length > 0 && (
                            <span
                              className="nav-count"
                              aria-label={`Запросов: ${people.requests.length}`}
                            >
                              +{people.requests.length}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <button
                      className="text-link"
                      onClick={() => {
                        if (demo) {
                          notice("В демо ссылки не создаются.", "info");
                          return;
                        }
                        setModal("share");
                      }}
                    >
                      <UserPlus size={16} />
                      Поделиться профилем
                    </button>
                  </div>
                  {(() => {
                    // Requests sit with the people they concern: mine to follow
                    // others in «Подписки», others' to follow me in «Подписчики».
                    const waiting =
                      peopleTab === "following" ? people.outgoing : people.requests;
                    const shown = [...waiting, ...people[peopleTab]];
                    return shown.length ? (
                      <div className="members">
                        {shown.map((m, i) => {
                          const pending = i < waiting.length;
                          return (
                            <div className="member-tile" key={m.id}>
                              <button
                                className={`member ${pending ? "pending" : ""}`}
                                onClick={() => openFriend(m)}
                              >
                                <span className={`avatar tone-${i % 4}`}>
                                  <Face user={m} />
                                </span>
                                <strong>{m.name.split(" ")[0]}</strong>
                                {m.username && <small>@{m.username}</small>}
                                {pending && peopleTab === "following" ? (
                                  <em className="pending-badge">ждёт одобрения</em>
                                ) : pending ? (
                                  <em className="pending-badge">просит доступ</em>
                                ) : (
                                  <span>{wishCount(m.gift_count)}</span>
                                )}
                              </button>
                              {pending && peopleTab === "followers" && (
                                <div className="member-actions">
                                  <button
                                    className="button primary"
                                    disabled={busy}
                                    onClick={() => void approveFollower(m)}
                                  >
                                    <Check size={14} /> Одобрить
                                  </button>
                                  <button
                                    className="icon-button"
                                    aria-label={`Отклонить запрос: ${m.name}`}
                                    disabled={busy}
                                    onClick={() => void declineFollower(m)}
                                  >
                                    <X size={16} />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="empty compact">
                        <Users />
                        <h3>
                          {peopleTab === "following"
                            ? "Вы пока ни на кого не подписаны"
                            : "Подписчиков пока нет"}
                        </h3>
                        <p>
                          {peopleTab === "following"
                            ? "Попросите близких прислать ссылку на их профиль."
                            : "Отправьте близким ссылку на свой профиль."}
                        </p>
                      </div>
                    );
                  })()}
                </section>
              )}
              {!error && closedCard && viewed && (
                <section className="closed-profile">
                  <PersonCard card={viewed.card} />
                  <p className="muted">
                    <Lock size={15} /> Закрытый профиль. Вишлист увидят
                    подписчики, которых одобрит {viewed.card.name.split(" ")[0]}.
                  </p>
                  {user && (
                    <FollowButton
                      card={viewed.card}
                      busy={busy}
                      onFollow={() => void followPerson(viewed.card)}
                      onUnfollow={() => unfollow(viewed.card)}
                    />
                  )}
                  {viewed.card.follows_you && (
                    <button
                      className="text-link danger"
                      onClick={() => removeFollower(viewed.card)}
                    >
                      <UserMinus size={15} />
                      Убрать из подписчиков
                    </button>
                  )}
                </section>
              )}
              {!error && showList && (
                <>
                  {(() => {
                    // Following, notifications and sharing the profile in one row.
                    if (!owner || own || tab === "archive" || !user) return null;
                    const card =
                      viewed && viewed.card.id === owner.id ? viewed.card : null;
                    if (!card) return null;
                    const sees = card.follow === "approved" || !card.is_private;
                    return (
                      <div className="wishlist-actions">
                        <FollowButton
                          card={card}
                          busy={busy}
                          onFollow={() => void followPerson(card)}
                          onUnfollow={() => unfollow(card)}
                        />
                        {sees && (
                          // A switch for bot messages, not unfollowing the person.
                          <button
                            className={`button secondary notify-toggle ${card.subscribed ? "on" : ""}`}
                            disabled={busy}
                            aria-pressed={!!card.subscribed}
                            onClick={() => void toggleSubscription(card)}
                            title={
                              card.subscribed
                                ? "Бот пишет в Telegram, когда вишлист меняется, и напоминает о дне рождения. Нажмите, чтобы выключить"
                                : "Бот напишет в Telegram о новых желаниях и напомнит о дне рождения"
                            }
                          >
                            {card.subscribed ? (
                              <>
                                <BellRing size={16} />
                                Уведомления включены
                              </>
                            ) : (
                              <>
                                <Bell size={16} />
                                Уведомлять
                              </>
                            )}
                          </button>
                        )}
                        <button
                          className="button secondary"
                          onClick={() => {
                            if (demo) {
                              notice("В демо ссылки не создаются.", "info");
                              return;
                            }
                            setModal("share");
                          }}
                        >
                          <LinkIcon size={16} />
                          Поделиться
                        </button>
                        {card.follows_you && (
                          <button
                            className="text-link danger remove-friend"
                            onClick={() => removeFollower(card)}
                          >
                            <UserMinus size={15} />
                            Убрать из подписчиков
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  {guestView() && (
                    <p className="list-help">
                      Нажмите «Забронировать» у подарка, который хотите купить.
                    </p>
                  )}
                  {namedList && owner && namedList.owner === owner.id && (
                    <p className="names-note">
                      <Eye size={16} />
                      <span>
                        Вы гость «{namedList.event}»: у подарков видно, кто из
                        гостей их забронировал. Брони других людей — без
                        имени.
                      </span>
                    </p>
                  )}
                  <div className="list-toolbar">
                    <span className="list-count">
                      {search || activeFilters
                        ? `${shown.length} из ${list.length}`
                        : wishCount(list.length)}
                    </span>
                    <div className="list-controls">
                      <label className="search">
                        <Search size={16} />
                        <input
                          type="search"
                          enterKeyHint="search"
                          aria-label="Найти желание"
                          placeholder="Найти желание"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          // The list filters as you type; Enter only hides the phone keyboard.
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      </label>
                      <label className="sort">
                        <select
                          aria-label="Сортировка"
                          value={sort}
                          onChange={(e) => setSort(e.target.value)}
                        >
                          <option value="priority">
                            Сначала самые желанные
                          </option>
                          <option value="priority-asc">
                            Сначала менее важные
                          </option>
                          <option value="price">Сначала дешёвые</option>
                          <option value="price-desc">Сначала дорогие</option>
                        </select>
                        <ChevronDown size={14} />
                      </label>
                      <button
                        className={`icon-button filter-toggle ${activeFilters ? "active" : ""}`}
                        aria-label="Фильтры"
                        aria-expanded={filtersOpen}
                        title="Фильтры"
                        onClick={() => setFiltersOpen(!filtersOpen)}
                      >
                        <SlidersHorizontal size={17} />
                        {activeFilters && <span className="filter-dot" />}
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Обновить список"
                        onClick={() => {
                          if (demo) notice("Демонстрационные данные", "info");
                          else if (tab === "archive") void loadArchive();
                          else if (guestView()) void refresh();
                          else if (owner) void loadList(owner.id);
                        }}
                      >
                        <RefreshCw size={17} />
                      </button>
                    </div>
                  </div>
                  {filtersOpen && (
                    <WishFilters
                      list={list}
                      value={filters}
                      onChange={setFilters}
                      foreign={foreignList}
                    />
                  )}
                  {loading ? (
                    <div className="loading" role="status">
                      <span />
                      Загрузка…
                    </div>
                  ) : shown.length ? (
                    <div className="gift-grid">
                      {shown.map((g) => (
                        <GiftCard
                          key={g.id}
                          wish={g}
                          mode={
                            tab === "archive"
                              ? "archive"
                              : own
                                ? "own"
                                : user
                                  ? "friend"
                                  : guestView()
                                    ? "guest"
                                    : "visitor"
                          }
                          busy={busy}
                          onEdit={() => {
                            setEditing(g);
                            setGiftDirty(false);
                            setModal("gift");
                          }}
                          onBought={() => void markBought(g)}
                          onRestore={() => void restore(g)}
                          onDelete={() => remove(g, tab === "archive")}
                          onReserve={() => void reserve(g)}
                          onAnswer={(join) => void answerInvite(g.id, join)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="empty">
                      {tab === "archive" ? (
                        <Archive size={34} />
                      ) : (
                        <Gift size={34} />
                      )}
                      <h3>
                        {search || activeFilters
                          ? "Ничего не подошло"
                          : tab === "archive"
                            ? "Архив пока пуст"
                            : own
                              ? "Добавьте первое желание"
                              : "Желаний пока нет"}
                      </h3>
                      <p>
                        {search || activeFilters
                          ? "Измените поиск или сбросьте фильтры."
                          : tab === "archive"
                            ? "Здесь появятся желания, которые вы перенесёте в архив."
                            : own
                              ? "Нажмите «Добавить желание» и укажите подарок."
                              : "Владелец ещё не добавил подарки."}
                      </p>
                    </div>
                  )}
                </>
              )}
              {tab === "event" && eventRef && user && (
                <EventPage
                  key={`${eventRef.owner}:${eventRef.key}:${eventRef.date}`}
                  owner={eventRef.owner}
                  eventKey={eventRef.key}
                  date={eventRef.date}
                  me={user.id}
                  friends={friends}
                  today={today}
                  notice={notice}
                  onBack={() =>
                    void (eventRef.from === "events" ||
                    eventRef.from === "bookings"
                      ? navigate(eventRef.from)
                      : openList(eventRef.owner))
                  }
                  onOpenList={(id, named) => void openList(id, named)}
                />
              )}
              {tab === "notifications" && user && (
                <NotesList
                  onOpen={(target) => void openNote(target)}
                  onRead={() => setUnread(0)}
                />
              )}
              {tab === "events" && user && (
                <EventsList
                  me={user.id}
                  today={today}
                  onOpen={(owner, key, date) => openEvent(owner, key, date)}
                />
              )}
              {tab === "bookings" &&
                (loading ? (
                  <div className="loading" role="status">
                    <span />
                    Загрузка…
                  </div>
                ) : (
                  <section className="bookings">
                    {bookings.length ? (
                      bookings.map((b) => (
                        <div className="booking" key={b.gift_id}>
                          <div className="booking-main">
                            <div className="booking-top">
                              <h3>{b.title}</h3>
                              <BookingPrice booking={b} />
                            </div>
                            <p className="booking-sub">
                              <span className={`status-badge ${b.role}`}>
                                {b.role === "invited"
                                  ? "Зовут скинуться"
                                  : b.role === "joined"
                                    ? "Скидываемся"
                                    : b.members.length
                                      ? "Вы собираете"
                                      : "Ваша бронь"}
                              </span>
                              <span>
                                для {b.owner_name}
                                {b.role !== "organizer" && b.organizer_name
                                  ? ` · собирает ${b.organizer_name}`
                                  : ""}
                                {b.archived ? " · в архиве" : ""}
                              </span>
                            </p>
                            <NearestEvent
                              booking={b}
                              today={today}
                              onOpen={(key, date) =>
                                openEvent(b.owner_id, key, date)
                              }
                            />
                            {b.members.length > 0 && (
                              <ul className="booking-members">
                                {b.members.map((m) => (
                                  <li
                                    key={m.id}
                                    className={m.status}
                                    title={
                                      m.status === "joined"
                                        ? "Участвует"
                                        : "Ждём ответа"
                                    }
                                  >
                                    {m.status === "joined" ? (
                                      <Check size={12} />
                                    ) : (
                                      <Clock size={12} />
                                    )}
                                    {m.name}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div className="booking-actions">
                            {b.role === "invited" ? (
                              <>
                                <button
                                  className="button primary"
                                  disabled={busy}
                                  onClick={() =>
                                    void answerInvite(b.gift_id, true)
                                  }
                                >
                                  Участвую
                                </button>
                                <button
                                  className="button secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void answerInvite(b.gift_id, false)
                                  }
                                >
                                  Не могу
                                </button>
                              </>
                            ) : (
                              <>
                                {b.role === "organizer" && !b.archived && (
                                  <button
                                    className="button secondary"
                                    disabled={busy}
                                    onClick={async () => {
                                      if (!friends.length)
                                        await loadFriends().catch(
                                          () => undefined,
                                        );
                                      setReserving({
                                        gift: { id: b.gift_id, title: b.title },
                                        ownerId: b.owner_id,
                                        exclude: b.members.map((m) => m.id),
                                        invite: true,
                                      });
                                    }}
                                  >
                                    <UserPlus size={15} />
                                    Пригласить
                                  </button>
                                )}
                                {b.role === "organizer" &&
                                  b.members.length > 0 && (
                                    <button
                                      className="button secondary"
                                      disabled={busy}
                                      onClick={() => buyAlone(b)}
                                      title="Перестать скидываться: участники выйдут из брони"
                                    >
                                      <UserMinus size={15} />
                                      Куплю сам
                                    </button>
                                  )}
                                <button
                                  className="button secondary"
                                  disabled={busy}
                                  onClick={() => cancelBooking(b)}
                                >
                                  {b.role === "organizer"
                                    ? "Отменить бронь"
                                    : "Выйти"}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty">
                        <Bookmark size={34} />
                        <h3>У вас пока нет броней</h3>
                        <p>Откройте вишлист друга и нажмите «Забронировать».</p>
                        <button
                          className="button primary"
                          onClick={() => void navigate("friends")}
                        >
                          Посмотреть желания друзей
                        </button>
                      </div>
                    )}
                  </section>
                ))}
            </>
          )}
        </main>
      </div>
      {toast?.text && (
        <div
          className={`toast ${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.tone === "error" ? (
            <CircleAlert size={17} />
          ) : toast.tone === "info" ? (
            <Info size={17} />
          ) : (
            <Check size={17} />
          )}
          {toast.text}
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Закрыть уведомление"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {guestGift && (
        <Modal
          title="Забронировать подарок"
          onClose={() => {
            if (!busy) setGuestGift(null);
          }}
        >
          <form
            className="share-result"
            onSubmit={(e) => {
              e.preventDefault();
              void guarded(async () => {
                try {
                  const r = await api(
                    `/api/guest-reservations/${guestGift.id}`,
                    "POST",
                    { name: guestName },
                  );
                  setGuestCode(guestGift.id, r.code);
                  setGuestGift(null);
                  notice("Подарок забронирован!");
                } finally {
                  await refresh();
                }
              }, "");
            }}
          >
            <h3>{guestGift.title}</h3>
            <label>
              Кто будет покупать подарок?
              <input
                autoFocus
                required
                maxLength={80}
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Ваше имя"
              />
            </label>
            <p>
              Владелец списка не увидит, кто выбрал подарок. Отменить бронь
              можно будет с этого устройства.
            </p>
            <button
              className="button primary"
              disabled={busy || !guestName.trim()}
            >
              {busy ? "Бронируем…" : "Забронировать"}
            </button>
          </form>
        </Modal>
      )}
      {reserving && (
        <ReserveDialog
          gift={reserving.gift}
          ownerId={reserving.ownerId}
          exclude={reserving.exclude}
          invite={reserving.invite}
          friends={friends}
          onClose={() => setReserving(null)}
          onDone={async (message) => {
            setReserving(null);
            telegram?.HapticFeedback?.notificationOccurred("success");
            notice(message);
            if (tab === "bookings") await loadBookings();
            else if (owner) await loadList(owner.id);
          }}
        />
      )}
      {archiveGift && (
        <ArchiveWish
          gift={archiveGift}
          onClose={() => setArchiveGift(null)}
          onArchived={async () => {
            setArchiveGift(null);
            if (user) await loadList(user.id);
            notice("Желание перенесено в архив");
          }}
        />
      )}
      {welcome !== false && user && !modal && (
        <Modal
          title="Добро пожаловать!"
          closeOnBackdrop={false}
          onClose={() => {
            setWelcome(false);
            if (!demo)
              void api("/api/me", "PATCH", { welcomed: true }).catch(
                () => undefined,
              );
          }}
        >
          <Welcome
            user={user}
            sharedName={
              sharedOwner && owner?.id === sharedOwner
                ? owner.name.split(" ")[0]
                : undefined
            }
            sharedOpen={!closedCard}
            notifications={welcome}
            onDone={(updated) => {
              setWelcome(false);
              if (updated) {
                setUser(updated);
                if (own) setOwner(updated);
                notice("Профиль сохранён");
              }
            }}
          />
        </Modal>
      )}
      {modal && (
        <Modal
          wide={modal === "import"}
          title={
            {
              gift: editing ? "Редактировать желание" : "Добавить желание",
              share: sharingOwn ? "Поделиться профилем" : "Поделиться",
              profile: "Мой профиль",
              import: "Добавить много желаний",
            }[modal]
          }
          closeOnBackdrop={modal !== "gift"}
          onClose={closeEditor}
        >
          {modal === "gift" ? (
            <GiftForm
              gift={editing}
              onDirty={() => setGiftDirty(true)}
              onSavingChange={setGiftSaving}
              onSaved={async () => {
                setModal(null);
                if (user) await loadList(user.id);
                setGiftDirty(false);
                notice("Желание сохранено");
              }}
            />
          ) : modal === "share" ? (
            <Share
              ownerId={sharingOwn ? user?.id : owner?.id}
              own={sharingOwn}
            />
          ) : modal === "profile" ? (
            <Profile
              user={user}
              onUpdated={(updated) => {
                setUser(updated);
                setOwner((current) =>
                  current?.id === updated.id
                    ? { ...current, ...updated }
                    : current,
                );
              }}
              followers={people.followers.length}
              following={people.following.length}
              webSession={webSession}
              onShare={() => setModal("share")}
              onLogout={(everywhere) => void logout(everywhere)}
            />
          ) : (
            <ImportDialog
              activeCount={own ? gifts.length : 0}
              onClose={() => setModal(null)}
              onImported={async (message) => {
                notice(message);
                if (user) await loadList(user.id);
              }}
            />
          )}
        </Modal>
      )}
      {confirmation && (
        <Confirm
          text={confirmation.text}
          action={confirmation.action}
          danger={confirmation.danger}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const c = confirmation;
            setConfirmation(null);
            void c.run();
          }}
        />
      )}
    </div>
  );
}
/** The public card: name, photo, @nick, how many wishes and followers. */
function PersonCard({ card }: { card: Person }) {
  return (
    <div className="person-card">
      <span className="avatar large">
        <Face user={card} />
      </span>
      <h2>{card.name}</h2>
      {card.username && <p className="muted">@{card.username}</p>}
      <p className="small-text">
        {wishCount(card.gift_count)}
        {card.follower_count !== undefined &&
          ` · подписчиков: ${card.follower_count}`}
      </p>
    </div>
  );
}
/** Follow an open profile, ask a closed one for access, or undo either. */
function FollowButton({
  card,
  busy,
  onFollow,
  onUnfollow,
}: {
  card: Person & { is_private?: boolean };
  busy: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
}) {
  if (card.follow === "approved")
    return (
      <button className="button secondary" disabled={busy} onClick={onUnfollow}>
        <Check size={16} /> Вы подписаны
      </button>
    );
  if (card.follow === "pending")
    return (
      <button className="button secondary" disabled={busy} onClick={onUnfollow}>
        <Clock size={16} /> Запрос отправлен
      </button>
    );
  return (
    <button className="button primary" disabled={busy} onClick={onFollow}>
      <UserPlus size={16} />
      {card.is_private ? "Запросить доступ" : "Подписаться"}
      {card.follows_you && !card.is_private ? " в ответ" : ""}
    </button>
  );
}
function GiftCard({
  wish: g,
  mode,
  busy,
  onEdit,
  onBought,
  onRestore,
  onDelete,
  onReserve,
  onAnswer,
}: {
  wish: Wish;
  /** «visitor»: an open profile seen without signing in; booking needs Telegram. */
  mode: "own" | "friend" | "guest" | "visitor" | "archive";
  busy: boolean;
  onEdit: () => void;
  onBought: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onReserve: () => void;
  onAnswer: (join: boolean) => void;
}) {
  const guestCode = mode === "guest" && !!guestCodes()[g.id];
  return (
    <article className={`gift-card ${mode === "archive" ? "archived" : ""}`}>
      <div className="photo-wrap">
        <Photo wish={g} own={mode === "own" || mode === "archive"} />
        <span className="priority">
          <Hearts value={g.priority} size={12} />
        </span>
        {mode === "own" && (
          <button
            className="card-edit"
            aria-label={`Редактировать ${g.title}`}
            onClick={onEdit}
          >
            <Pencil size={15} />
          </button>
        )}
      </div>
      <div className="card-content">
        {mode === "archive" && (
          // Why the wish left the list: the reason picked when archiving.
          <p className={`archive-reason ${g.archive_reason || "unknown"}`}>
            {g.archive_reason === "gifted" ? (
              <Gift size={14} />
            ) : g.archive_reason === "bought_self" ? (
              <ShoppingBag size={14} />
            ) : g.archive_reason === "changed_mind" ? (
              <Undo2 size={14} />
            ) : (
              <Archive size={14} />
            )}
            <span>
              {g.archive_reason === "changed_mind"
                ? "Передумал"
                : g.archive_reason === "gifted"
                  ? "Подарили"
                  : g.archive_reason === "bought_self"
                    ? "Купил сам"
                    : "В архиве"}
            </span>
            {g.archived_at ? (
              <time>
                {new Date(g.archived_at * 1000).toLocaleDateString("ru-RU")}
              </time>
            ) : null}
          </p>
        )}
        <div className="gift-price">{money(g)}</div>
        <h3>{g.title}</h3>
        {g.description && <p>{g.description}</p>}
        {g.reservation === "reserved" && !!g.booked_by?.length && (
          <p className="booked-by">
            <Users size={13} />
            <span>Дарит: {g.booked_by.join(", ")}</span>
          </p>
        )}
        {g.reservation === "mine" && !!g.group_joined && (
          <p className="small-text">
            Совместный подарок · участников: {g.group_joined + 1}
          </p>
        )}
        <div className="card-actions">
          {g.shop_url ? (
            <a
              href={g.shop_url}
              target="_blank"
              rel="noopener noreferrer"
              className="shop-link"
            >
              В магазин <ArrowUpRight size={15} />
            </a>
          ) : null}
          {mode === "own" ? (
            <span className="owner-actions">
              <button
                className="bought-button"
                disabled={busy}
                onClick={onBought}
                title="Выбрать причину переноса в архив"
              >
                <Archive size={14} />
                Отправить в архив
              </button>
              <button
                className="icon-button delete-button"
                aria-label={`Удалить ${g.title}`}
                disabled={busy}
                onClick={onDelete}
              >
                <Trash2 size={16} />
              </button>
            </span>
          ) : mode === "archive" ? (
            <span className="owner-actions">
              <button
                className="bought-button"
                disabled={busy}
                onClick={onRestore}
              >
                <ArchiveRestore size={14} />
                Вернуть
              </button>
              <button
                className="icon-button delete-button"
                aria-label={`Удалить ${g.title}`}
                disabled={busy}
                onClick={onDelete}
              >
                <Trash2 size={16} />
              </button>
            </span>
          ) : g.reservation === "invited" ? (
            <span className="owner-actions">
              <button
                className="reserve-button"
                disabled={busy}
                onClick={() => onAnswer(true)}
                title="Вас пригласили скинуться на этот подарок"
              >
                <Users size={14} />
                Участвую
              </button>
              <button
                className="bought-button"
                disabled={busy}
                onClick={() => onAnswer(false)}
              >
                Не могу
              </button>
            </span>
          ) : guestCode && g.reservation === "reserved" ? (
            <button
              disabled={busy}
              className="reserve-button mine"
              onClick={onReserve}
            >
              <Check size={14} />
              Отменить бронь
            </button>
          ) : mode === "friend" || mode === "guest" ? (
            <button
              disabled={busy || g.reservation === "reserved"}
              className={`reserve-button ${g.reservation === "mine" ? "mine" : ""}`}
              onClick={onReserve}
            >
              {g.reservation === "reserved" ? (
                <>
                  <Bookmark size={13} />
                  Забронировано
                </>
              ) : g.reservation === "mine" ? (
                <>
                  <Check size={14} />
                  Отменить бронь
                </>
              ) : (
                <>
                  <Gift size={14} />
                  Забронировать
                </>
              )}
            </button>
          ) : (
            <a className="reserve-button" href={telegramLink()}>
              Хочу подарить
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
/**
 * The bot saves a shop's photo as a link: the server cannot shrink it. When the
 * owner sees such a wish, the app stores the photo itself, one at a time.
 */
let photoSwaps = Promise.resolve();
const photoSwapped = new Set<string>();
function keepShopPhoto(id: string, link: string) {
  if (photoSwapped.has(id)) return;
  photoSwapped.add(id);
  photoSwaps = photoSwaps
    .then(async () => {
      const photo = await photoFromUrl(link);
      await api(`/api/gifts/${id}/photo`, "PUT", { photo, from: link });
    })
    .catch(() => undefined);
}
function Photo({ wish, own }: { wish: Wish; own: boolean }) {
  const [src, setSrc] = useState(wish.photo || ""),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!demo && wish.has_photo)
      void api<{ photo: string }>(`/api/gifts/${wish.id}/photo`)
        .then((r) => {
          if (alive) setSrc(r.photo);
          if (own && /^https:\/\//.test(r.photo))
            keepShopPhoto(wish.id, r.photo);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    return () => {
      alive = false;
    };
  }, [wish, own]);
  return src && !failed ? (
    <img
      loading="lazy"
      referrerPolicy="no-referrer"
      src={src}
      alt={wish.title}
      onError={() => setFailed(true)}
    />
  ) : (
    <div className="photo-placeholder">
      <Gift size={42} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

/** Full price and, for a shared gift, each participant's part. */
function BookingPrice({ booking: b }: { booking: Booking }) {
  const priced = b.price_minor !== null || (b.price_max_minor ?? null) !== null;
  // Invitees do not see the other members; the organizer and members do.
  const people =
    b.role === "invited"
      ? 0
      : 1 + b.members.filter((m) => m.status === "joined").length;
  return (
    <p className="booking-price">
      <strong>{priced ? formatPrice(b) : "Цена не указана"}</strong>
      {priced && people > 1 && (
        <>
          {" "}
          · с каждого {sharePrice(b, people)}{" "}
          <span className="muted">(участников: {people})</span>
        </>
      )}
    </p>
  );
}
/**
 * By when to buy: the party of the wishlist owner the user is invited to, or
 * else the owner's nearest event. Opens the event page.
 */
function NearestEvent({
  booking,
  today,
  onOpen,
}: {
  booking: Booking;
  today: Date;
  onOpen: (key: string, date: string) => void;
}) {
  const events = upcomingEvents(booking.owner_events || [], today);
  const next =
    events.find((e) =>
      booking.my_events?.some((m) => m.key === e.key && m.date === e.date),
    ) || events[0];
  if (!next || booking.archived) return null;
  return (
    <button
      className="booking-event"
      title="Успеть к мероприятию"
      onClick={() => onOpen(next.key, next.date)}
    >
      <CalendarDays size={14} />
      <span>
        {next.title} · {eventDay(next.date)} · {untilText(next.days)}
      </span>
      <ChevronRight size={14} />
    </button>
  );
}
