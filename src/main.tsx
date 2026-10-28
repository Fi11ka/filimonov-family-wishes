import { ACCOUNT_ID_PART } from "../shared/account-id";
import { eventDay, untilText, upcomingEvents } from "../shared/events";
import { formatPrice, sharePrice } from "../shared/price";
import { EventPage, EventsList, WishlistEvents } from "./events";
import { ArchiveWish, ReserveDialog } from "./forms";
import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
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
  profileTarget,
  redeemHandoff,
  RequestError,
  savedGuestName,
  setGuestCode,
  setSessionToken,
  signedIn,
  signedInBefore,
  rememberSignIn,
  telegram,
  telegramLink,
  type Notifications,
} from "./api";
import { WebLogin } from "./login";
import { ErrorScreen } from "./error-screen";
import { forgetGiftPhoto, giftPhoto } from "./gift-photo";
import {
  demoArchive,
  demoAttention,
  demoBookings,
  demoGiven,
  demoFriends,
  demoGifts,
  demoIncoming,
  demoUser,
} from "./demo";
import { GiftForm, Share, Modal, Confirm } from "./forms";
import { Profile } from "./friends";
import { Features, Welcome } from "./welcome";
import { telegramAppLink } from "./telegram-links";
import { Face } from "./avatar";
// «Добавить много» with its spreadsheet reader is needed rarely: it loads on
// demand, and the button starts loading it as soon as it is pointed at.
const loadImport = () => import("./import/ImportDialog");
const ImportDialog = lazy(() =>
  loadImport().then((m) => ({ default: m.ImportDialog })),
);
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
  type GiverRecord,
  type ToastAction,
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
type Tab = "mine" | "friends" | "bookings" | "events" | "archive" | "event";
type ModalKind = "gift" | "share" | "profile" | "import";
/** «Друзья»: whom I added, requests to me and mine, who added me without me adding back. */
type People = {
  friends: Person[];
  requests: Person[];
  outgoing: Person[];
  added_me: Person[];
};
/** A profile opened in «Друзья»: its card, and whether its list is open to me. */
type Viewed = { card: Person & { is_private?: boolean }; can_view: boolean };
interface Confirmation {
  text: string;
  action: string;
  danger?: boolean;
  /** A checkbox in the dialog, ticked at first; run gets its value. */
  option?: string;
  run: (option: boolean) => Promise<void>;
}
function App() {
  const [user, setUser] = useState<User | null>(demo ? demoUser : null),
    [people, setPeople] = useState<People>({
      friends: demo ? demoFriends : [],
      requests: demo ? demoIncoming.map((p) => ({ ...p, gift_count: 0 })) : [],
      outgoing: [],
      added_me: [],
    }),
    // Approving a request adds the person back unless this is unticked.
    [addBack, setAddBack] = useState(true),
    [viewed, setViewed] = useState<Viewed | null>(null);
  // My people, whom I can invite to an event or a shared gift.
  const friends: Friend[] = [...people.friends, ...people.added_me];
  const [owner, setOwner] = useState<User | null>(demo ? demoUser : null),
    [gifts, setGifts] = useState<Wish[]>(demo ? demoGifts : []),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [archive, setArchive] = useState<Wish[]>(demo ? demoArchive : []);
  const [tab, setTab] = useState<Tab>(
      guestToken || profileTarget || legacyLink ? "friends" : "mine",
    ),
    [loading, setLoading] = useState(!demo),
    [error, setError] = useState(""),
    [toast, setToast] = useState<{
      text: string;
      tone: ToastTone;
      action?: ToastAction;
    } | null>(
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
    [attention, setAttention] = useState<GiverRecord[]>([]),
    [given, setGiven] = useState<GiverRecord[]>([]),
    [bookingsTab, setBookingsTab] = useState<"active" | "given">("active"),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState(false),
    [opening, setOpening] = useState(false),
    [webSession, setWebSession] = useState(false);
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
  const [reserving, setReserving] = useState<{
    gift: { id: string; title: string } & Partial<Wish>;
    ownerId: string;
    exclude?: string[];
    invite?: boolean;
    /** A guest link without an account: booking by name. */
    guest?: boolean;
  } | null>(null);
  /** A friend's list I was looking at is no longer open to me. */
  const [lostAccess, setLostAccess] = useState(false);
  /** Whose profile a link opened: the welcome dialog names them. */
  const [sharedOwner, setSharedOwner] = useState("");
  const sharedOpened = useRef(false);
  /** The first-visit tour, with the bot status for its «Открыть бота». */
  const [welcome, setWelcome] = useState<Notifications | null | false>(false);
  const welcomeShown = useRef(false);
  /** Someone who came by a link sees what was sent first; the tour waits for their first action. */
  const [welcomeLater, setWelcomeLater] = useState(
    !!(guestToken || profileTarget || legacyLink || openTarget),
  );
  const returning = signedInBefore();
  /** A guest link opened without an account: only that list, with bookings by name.
   * Signed in, the link just opens the list and the rest of the app works as usual. */
  const guestView = () => !!guestToken && !signedIn();
  const own = !!user && owner?.id === user.id;
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A toast; with `action` (e.g. «Вернуть») it stays for seven seconds. */
  const notice = (
    message: string,
    tone: ToastTone = "ok",
    action?: ToastAction,
  ) => {
    // A finished action counts as the first one for the deferred welcome.
    if (tone === "ok") setWelcomeLater(false);
    setToast({ text: message, tone, action });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(
      () => setToast(null),
      action ? 7000 : 4500,
    );
  };
  const fullscreen = useFullscreen((message) => notice(message, "error"));
  async function loadList(id: string) {
    setLoading(true);
    setError("");
    setLostAccess(false);
    try {
      const d = await api(`/api/lists/${id}`);
      setGifts(d.gifts);
      setOwner(d.owner);
      setInvitations(d.invitations || []);
    } catch (e) {
      // Someone else's list closed while I was looking: say so plainly, with a way out.
      if (
        e instanceof RequestError &&
        e.status === 404 &&
        user &&
        id !== user.id
      )
        setLostAccess(true);
      else setError((e as Error).message);
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
   * Someone's profile in «Друзья»: their list when it is open to me, or the
   * card with «Добавить в друзья».
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
      // The list was open a moment ago and is not now: access was taken away.
      setLostAccess(
        !p.can_view && viewed?.card.id === id && !!viewed.can_view,
      );
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
        // Friends depend on nothing below: ask for them together with «me».
        // Their error, if any, is raised where they used to be awaited.
        const friends = loadFriends().then(
          () => null,
          (e: Error) => e,
        );
        const friendsLoaded = async () => {
          const failed = await friends;
          if (failed) throw failed;
        };
        const me = await api("/api/me");
        rememberSignIn();
        setUser(me.user);
        setWebSession(!!me.web_session);
        if (me.welcome && !welcomeShown.current) {
          welcomeShown.current = true;
          setWelcome(me.notifications || null);
        }
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
            await friendsLoaded();
            return;
          } else setTab("mine");
        }
        if (tab === "friends" && viewed && owner?.id === viewed.card.id) {
          // Stay on the profile; its access may have changed.
          await openPerson(viewed.card.id);
          await friendsLoaded();
          return;
        }
        const d = await api(`/api/lists/${id}`);
        setOwner(d.owner);
        setGifts(d.gifts);
        setInvitations(d.invitations || []);
        await friendsLoaded();
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
    setPeople({ friends: [], requests: [], outgoing: [], added_me: [] });
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
    setWelcomeLater(false);
    setLostAccess(false);
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
      if (next === "bookings") {
        setBookings(demoBookings);
        setAttention(demoAttention);
        setGiven(demoGiven);
      }
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
      const r = await api("/api/reservations");
      setBookings(r.reservations);
      setAttention(r.attention || []);
      setGiven(r.given || []);
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
  /** The list behind a dialog, after a booking changed. */
  async function reloadAfterBooking() {
    if (tab === "bookings") await loadBookings();
    else if (guestView()) await refresh();
    else if (owner) await loadList(owner.id);
  }
  /**
   * «Вернуть» after a cancelled booking: books again only if the gift is still
   * free. The server books atomically, so a second try cannot double it.
   */
  function undoCancel(giftId: string) {
    return {
      label: "Вернуть",
      run: () =>
        guarded(async () => {
          try {
            if (guestView()) {
              const r = await api(`/api/guest-reservations/${giftId}`, "POST", {
                name: savedGuestName() || "Гость",
              });
              setGuestCode(giftId, r.code);
            } else await api(`/api/gifts/${giftId}/reservation`, "POST", {});
            notice("Бронь возвращена");
          } catch (e) {
            notice(
              e instanceof RequestError && e.code === "TAKEN"
                ? "Вернуть не получилось: этот подарок уже выбрал кто-то другой."
                : (e as Error).message,
              "error",
            );
          } finally {
            await reloadAfterBooking();
          }
        }, ""),
    };
  }
  async function reserve(g: Wish) {
    if (guestView()) {
      if (g.reservation === "reserved" && guestCodes()[g.id])
        setConfirmation({
          text: `Отменить бронь «${g.title}»? Подарок снова станет свободным, его сможет выбрать кто-то другой.`,
          action: "Отменить бронь",
          danger: true,
          run: () =>
            guarded(async () => {
              try {
                await api(`/api/guest-reservations/${g.id}/cancel`, "POST", {
                  code: guestCodes()[g.id],
                });
                notice("Бронь отменена", "ok", undoCancel(g.id));
              } finally {
                // Cancelled now or earlier by someone else: the code is no longer needed.
                setGuestCode(g.id, null);
                await refresh();
              }
            }, ""),
        });
      else setReserving({ gift: g, ownerId: g.owner_id, guest: true });
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
        : `Отменить бронь «${g.title}»? Подарок снова станет свободным, его сможет выбрать кто-то другой.`,
      action: "Отменить бронь",
      danger: true,
      run: () =>
        guarded(async () => {
          try {
            await api(`/api/gifts/${g.id}/reservation`, "DELETE");
            // A shared gift cannot come back: its members were let go.
            if (g.group_joined) notice("Бронь отменена");
            else notice("Бронь отменена", "ok", undoCancel(g.id));
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
          : `Отменить бронь «${b.title}»? Подарок снова станет свободным, его сможет выбрать кто-то другой.`,
      action: organizer ? "Отменить бронь" : "Выйти",
      danger: true,
      run: () =>
        guarded(async () => {
          await api(`/api/gifts/${b.gift_id}/reservation`, "DELETE");
          setBookings((list) => list.filter((x) => x.gift_id !== b.gift_id));
          if (organizer && !b.members.length)
            notice("Бронь отменена", "ok", undoCancel(b.gift_id));
          else notice(organizer ? "Бронь отменена" : "Вы вышли из подарка");
        }, "Бронирование доступно после подключения приложения."),
    });
  }
  /** «Подарено» / «Это подарил я»: only the giver moves a card to «Подаренные». */
  function markGiven(id: string, title: string, fromCard = false) {
    setConfirmation({
      text: fromCard
        ? `Это вы подарили «${title}»? Карточка перейдёт во вкладку «Подаренные».`
        : `Отметить «${title}» подаренным? Карточка перейдёт во вкладку «Подаренные», у получателя желание останется как есть.`,
      action: fromCard ? "Это подарил я" : "Подарено",
      run: () =>
        guarded(async () => {
          await api(`/api/reservations/${id}/gifted`, "POST");
          notice("Отмечено как подаренное");
          await loadBookings();
        }, "В демо брони не меняются."),
    });
  }
  /** «Удалить у меня»: only my closed card goes; nothing changes for anyone else. */
  function hideRecord(c: GiverRecord) {
    setConfirmation({
      text: `Удалить карточку «${c.title}» только у вас? Желание получателя и чужие брони это не изменит.`,
      action: "Удалить у меня",
      danger: true,
      run: () =>
        guarded(async () => {
          await api(`/api/reservations/${c.gift_id}/hide`, "POST");
          setAttention((list) => list.filter((x) => x.gift_id !== c.gift_id));
          notice("Карточка удалена");
        }, "В демо брони не меняются."),
    });
  }
  async function changeSeen(b: Booking) {
    await guarded(async () => {
      await api(`/api/reservations/${b.gift_id}/seen`, "POST");
      setBookings((list) =>
        list.map((x) =>
          x.gift_id === b.gift_id ? { ...x, changed_fields: null } : x,
        ),
      );
    }, "В демо брони не меняются.");
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
  /** «Добавить в друзья»: an open list at once, a closed one after approval. */
  async function followPerson(p: Person) {
    await guarded(async () => {
      const r = await api(`/api/follows/${p.id}`, "POST");
      notice(
        r.follow === "approved"
          ? "Добавлено в друзья"
          : "Запрос отправлен. Вишлист откроется, когда его одобрят",
      );
      await loadFriends();
      if (viewed?.card.id === p.id) await openPerson(p.id);
    }, "В демо друзья не меняются.");
  }
  /** Remove from friends or cancel my request; a friend who sees my closed list may lose it too. */
  function unfollow(p: Person) {
    const pending = p.follow === "pending";
    const sees = !!user?.is_private && !!p.follows_you;
    setConfirmation({
      text: pending
        ? "Отменить запрос в друзья? Он ещё ждёт одобрения."
        : `Убрать ${p.name} из друзей?${p.is_private && !sees ? " Вишлист закрытый: чтобы снова его видеть, придётся отправить запрос." : ""} Уже сделанные брони сохранятся.`,
      action: pending ? "Отменить запрос" : "Убрать",
      danger: !pending,
      option:
        !pending && sees
          ? "И закрыть этому человеку доступ к моему вишлисту"
          : undefined,
      run: (revoke) =>
        guarded(async () => {
          await api(
            `/api/follows/${p.id}${revoke ? "?revoke=1" : ""}`,
            "DELETE",
          );
          await loadFriends();
          if (viewed?.card.id === p.id) await openPerson(p.id);
          notice(pending ? "Запрос отменён" : "Убрано из друзей");
        }, "В демо друзья не меняются."),
    });
  }
  async function approveFollower(p: Person) {
    await guarded(async () => {
      await api(`/api/followers/${p.id}/approve`, "POST", {
        add_back: addBack,
      });
      notice(addBack ? "Теперь вы друзья" : "Запрос одобрен");
      await loadFriends();
    }, "В демо друзья не меняются.");
  }
  async function declineFollower(p: Person) {
    await guarded(async () => {
      await api(`/api/followers/${p.id}`, "DELETE");
      notice("Запрос отклонён");
      await loadFriends();
    }, "В демо друзья не меняются.");
  }
  /** Take my closed list away from someone who added me; they are not told. */
  function removeFollower(p: Person) {
    setConfirmation({
      text: `Закрыть ${p.name} доступ к вашему вишлисту? Сообщения об этом не будет.`,
      action: "Закрыть доступ",
      danger: true,
      run: () =>
        guarded(async () => {
          await api(`/api/followers/${p.id}`, "DELETE");
          await loadFriends();
          if (viewed?.card.id === p.id) await openPerson(p.id);
          notice("Доступ закрыт");
        }, "В демо друзья не меняются."),
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
  const openInTelegram = (
    <a className="button telegram-login" href={telegramLink()}>
      <Send size={17} /> Открыть в Telegram
    </a>
  );
  // Without signing in only a guest link shows wishes; a profile shows its card.
  const locked = !demo && !user && !guestToken && !loading;
  const viewingFriend = tab === "friends" && !!owner && !own;
  // A closed profile I do not follow shows its card instead of the list.
  const closedCard =
    viewingFriend && !demo && !!viewed && viewed.card.id === owner?.id && !viewed.can_view;
  const showList =
    tab === "mine" ||
    tab === "archive" ||
    guestView() ||
    (viewingFriend && !closedCard && !lostAccess);
  const ownerFirst = owner?.name.split(" ")[0] || "друга";
  // «Поделиться» on someone's profile shares theirs; anywhere else my own.
  const sharingOwn = !(tab === "friends" && owner && !own);
  // Signed out (a guest link too) there is nowhere to go: no menu, just the page.
  const signedOut = locked || guestView();
  return (
    <div className={`app-shell ${signedOut ? "signed-out" : ""}`}>
      <aside
        className={`sidebar ${menu ? "is-open" : ""}`}
        hidden={signedOut}
      >
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
              ["friends", Users, "Друзья", "Друзья"],
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
                    Войдите, чтобы увидеть вишлист{" "}
                    {viewed.card.name.split(" ")[0]}.
                    {viewed.card.is_private
                      ? " Он закрытый: откроется, когда вас одобрят в друзья."
                      : ""}
                  </p>
                </>
              ) : profileTarget || legacyLink ? (
                <>
                  <h1>Вам прислали профиль</h1>
                  <p>Войдите, чтобы открыть вишлист и выбрать подарок.</p>
                </>
              ) : returning ? (
                <h1>Войдите снова</h1>
              ) : (
                <>
                  <h1>Вишлист</h1>
                  <p>
                    Собирайте желания в одном месте, смотрите вишлисты близких
                    и тайно выбирайте им подарки.
                  </p>
                </>
              )}
              {/* Two equal ways in; more sign-in methods join this row later. */}
              {apiConfigured && !telegram?.initData ? (
                <WebLogin
                  compact
                  onSignedIn={() => void refresh()}
                  alternative={openInTelegram}
                />
              ) : (
                <div className="login-choices">{openInTelegram}</div>
              )}
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
              {!returning && (
                <>
                  <a className="text-link" href="?demo=1">
                    Попробовать демо
                  </a>
                  <Features />
                </>
              )}
            </section>
          ) : (
            <>
              {guestView() && (
                <div className="guest-banner">
                  <LinkIcon size={18} />
                  <span>Вишлист для близких · без регистрации</span>
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
                  <ArrowLeft size={15} /> Все друзья
                </button>
              )}
              <div
                className={`page-title ${owner && showList && tab !== "bookings" ? "page-head" : ""}`}
              >
                <div className="title-main">
                  <div className="title-line">
                  <h1>
                    {tab === "event"
                      ? "Мероприятие"
                      : tab === "events"
                        ? "Мероприятия"
                        : tab === "bookings"
                          ? "Мои брони"
                          : tab === "archive"
                            ? "Архив"
                            : tab === "friends" && !guestView() && !viewingFriend
                              ? "Друзья"
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
                      onPointerEnter={() => void loadImport()}
                      onFocus={() => void loadImport()}
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
                    <p className="muted">
                      Друзей: {people.friends.length}
                    </p>
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
                      Поделиться
                    </button>
                  </div>
                  {people.requests.length > 0 && (
                    <PeopleGroup
                      title="Хотят в друзья"
                      note={
                        <label className="setting-toggle add-back">
                          <input
                            type="checkbox"
                            checked={addBack}
                            onChange={(e) => setAddBack(e.target.checked)}
                          />
                          <span>При одобрении добавлять в друзья в ответ</span>
                        </label>
                      }
                    >
                      {people.requests.map((m, i) => (
                        <MemberTile
                          key={m.id}
                          person={m}
                          tone={i}
                          pending
                          badge="просит доступ"
                          onOpen={() => openFriend(m)}
                        >
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
                        </MemberTile>
                      ))}
                    </PeopleGroup>
                  )}
                  <PeopleGroup
                    title={people.requests.length ? "Друзья" : undefined}
                  >
                    {people.friends.map((m, i) => (
                      <MemberTile
                        key={m.id}
                        person={m}
                        tone={i}
                        badge={m.follows_you ? "вы друг у друга" : undefined}
                        onOpen={() => openFriend(m)}
                      />
                    ))}
                  </PeopleGroup>
                  {!people.friends.length && (
                    <div className="empty compact">
                      <Users />
                      <h3>Друзей пока нет</h3>
                      <p>
                        Попросите близких прислать ссылку на их профиль, а им
                        отправьте свою.
                      </p>
                    </div>
                  )}
                  {people.outgoing.length > 0 && (
                    <PeopleGroup
                      title="Ждут одобрения"
                      note={
                        <p className="small-text">
                          Ваши запросы к закрытым вишлистам. Откроются, когда
                          их одобрят.
                        </p>
                      }
                    >
                      {people.outgoing.map((m, i) => (
                        <MemberTile
                          key={m.id}
                          person={m}
                          tone={i}
                          pending
                          badge="ждёт одобрения"
                          onOpen={() => openFriend(m)}
                        >
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => unfollow(m)}
                          >
                            Отменить запрос
                          </button>
                        </MemberTile>
                      ))}
                    </PeopleGroup>
                  )}
                  {people.added_me.length > 0 && (
                    <PeopleGroup
                      title="Добавили вас"
                      note={
                        <p className="small-text">
                          {user?.is_private
                            ? "Эти люди видят ваш вишлист. В ваших друзьях их нет, пока вы не добавите их в ответ."
                            : "Эти люди добавили вас в друзья. В ваших друзьях их нет, пока вы не добавите их в ответ."}
                        </p>
                      }
                    >
                      {people.added_me.map((m, i) => (
                        <MemberTile
                          key={m.id}
                          person={m}
                          tone={i}
                          onOpen={() => openFriend(m)}
                        >
                          <button
                            className="button primary"
                            disabled={busy}
                            onClick={() => void followPerson(m)}
                          >
                            <UserPlus size={14} /> Добавить в ответ
                          </button>
                          {user?.is_private && (
                            <button
                              className="icon-button"
                              aria-label={`Закрыть доступ: ${m.name}`}
                              title="Закрыть доступ к моему вишлисту"
                              disabled={busy}
                              onClick={() => removeFollower(m)}
                            >
                              <UserMinus size={16} />
                            </button>
                          )}
                        </MemberTile>
                      ))}
                    </PeopleGroup>
                  )}
                </section>
              )}
              {lostAccess && viewingFriend && (
                <section className="closed-profile">
                  <Lock size={22} />
                  <h3>Список больше недоступен</h3>
                  <p className="muted">
                    Свою бронь из этого списка можно отменить в «Моих бронях».
                  </p>
                  <button
                    className="button primary"
                    onClick={() => void navigate("friends")}
                  >
                    <ArrowLeft size={16} /> К друзьям
                  </button>
                </section>
              )}
              {!error && !lostAccess && closedCard && viewed && (
                <section className="closed-profile">
                  <PersonCard card={viewed.card} />
                  <p className="muted">
                    <Lock size={15} /> Закрытый вишлист. Его увидят друзья,
                    которых одобрит {viewed.card.name.split(" ")[0]}.
                  </p>
                  {user && (
                    <FollowButton
                      card={viewed.card}
                      busy={busy}
                      onFollow={() => void followPerson(viewed.card)}
                      onUnfollow={() => unfollow(viewed.card)}
                    />
                  )}
                  {user?.is_private && viewed.card.follows_you && (
                    <button
                      className="text-link danger"
                      onClick={() => removeFollower(viewed.card)}
                    >
                      <UserMinus size={15} />
                      Закрыть доступ к моему вишлисту
                    </button>
                  )}
                </section>
              )}
              {!error && showList && (
                <>
                  {(() => {
                    // Following and sharing the profile in one row.
                    if (!owner || own || tab === "archive" || !user) return null;
                    const card =
                      viewed && viewed.card.id === owner.id ? viewed.card : null;
                    if (!card) return null;
                    return (
                      <div className="wishlist-actions">
                        <FollowButton
                          card={card}
                          busy={busy}
                          onFollow={() => void followPerson(card)}
                          onUnfollow={() => unfollow(card)}
                        />
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
                        {user.is_private &&
                          card.follows_you &&
                          card.follow !== "approved" && (
                            // A friend loses access in «Убрать из друзей» instead.
                            <button
                              className="text-link danger remove-friend"
                              onClick={() => removeFollower(card)}
                            >
                              <UserMinus size={15} />
                              Закрыть доступ к моему вишлисту
                            </button>
                          )}
                      </div>
                    );
                  })()}
                  {guestView() && (
                    <p className="list-help">
                      Нажмите «Подарю» у подарка, который хотите купить.
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
                                  : "guest"
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
                    <div className="segmented" role="tablist">
                      <button
                        role="tab"
                        aria-selected={bookingsTab === "active"}
                        className={bookingsTab === "active" ? "selected" : ""}
                        onClick={() => setBookingsTab("active")}
                      >
                        Активные
                        {bookings.length ? ` · ${bookings.length}` : ""}
                      </button>
                      <button
                        role="tab"
                        aria-selected={bookingsTab === "given"}
                        className={bookingsTab === "given" ? "selected" : ""}
                        onClick={() => setBookingsTab("given")}
                      >
                        Подаренные
                      </button>
                    </div>
                    {bookingsTab === "given" ? (
                      given.length ? (
                        <div className="booking-grid">
                          {given.map((c) => (
                            <article className="booking" key={c.gift_id}>
                              <RecordPhoto record={c} />
                              <div className="booking-main">
                                <h3>{c.title}</h3>
                                <RecordPrice record={c} />
                                <Recipient
                                  record={c}
                                  text={`${c.owner_name} · подарено${c.gifted_at ? ` ${shortDate(c.gifted_at)}` : ""}`}
                                />
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="empty">
                          <Gift size={34} />
                          <h3>Здесь появятся подарки, которые вы отметите подаренными</h3>
                          <p>
                            Нажмите «Подарено» у брони, когда вручите подарок.
                          </p>
                        </div>
                      )
                    ) : (
                      <>
                        {bookings.length > 0 && (
                          <div className="booking-grid">
                            {bookings.map((b) => (
                              <article className="booking" key={b.gift_id}>
                                <div className="booking-photo">
                                  <Photo
                                    wish={
                                      {
                                        id: b.gift_id,
                                        title: b.title,
                                        has_photo: b.has_photo || 0,
                                        updated_at: b.updated_at,
                                      } as Wish
                                    }
                                    own={false}
                                  />
                                </div>
                                <div className="booking-main">
                                  <h3>{b.title}</h3>
                                  <BookingPrice booking={b} />
                                  <Recipient
                                    record={b}
                                    text={`Для ${b.owner_name}`}
                                  />
                                  <p className="booking-sub">
                                    <span className={`status-badge ${b.role}`}>
                                      {b.role === "invited"
                                        ? "Зовут скинуться"
                                        : b.role === "joined"
                                          ? "Скидываемся"
                                          : b.members.length
                                            ? "Вы собираете"
                                            : "Это дарите вы"}
                                    </span>
                                    {b.role !== "organizer" &&
                                      b.organizer_name && (
                                        <span>собирает {b.organizer_name}</span>
                                      )}
                                  </p>
                                  {b.changed_fields && (
                                    <p className="booking-note">
                                      <Info size={15} />
                                      <span>
                                        Владелец изменил{" "}
                                        {changedText(b.changed_fields)}. Бронь
                                        осталась за вами.{" "}
                                        <button
                                          className="text-link"
                                          disabled={busy}
                                          onClick={() => void changeSeen(b)}
                                        >
                                          Понятно
                                        </button>
                                      </span>
                                    </p>
                                  )}
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
                                      <button
                                        className="button primary"
                                        disabled={busy}
                                        onClick={() =>
                                          markGiven(b.gift_id, b.title)
                                        }
                                      >
                                        <Gift size={15} />
                                        Подарено
                                      </button>
                                      {b.role === "organizer" && (
                                        <button
                                          className="button secondary"
                                          disabled={busy}
                                          onClick={async () => {
                                            if (!friends.length)
                                              await loadFriends().catch(
                                                () => undefined,
                                              );
                                            setReserving({
                                              gift: {
                                                id: b.gift_id,
                                                title: b.title,
                                              },
                                              ownerId: b.owner_id,
                                              exclude: b.members.map(
                                                (m) => m.id,
                                              ),
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
                              </article>
                            ))}
                          </div>
                        )}
                        {attention.length > 0 && (
                          <>
                            <h3 className="booking-group">
                              <CircleAlert size={17} /> Требует внимания
                            </h3>
                            <div className="booking-grid">
                              {attention.map((c) => (
                                <article
                                  className="booking attention"
                                  key={c.gift_id}
                                >
                                  <RecordPhoto record={c} />
                                  <div className="booking-main">
                                    <h3>{c.title}</h3>
                                    <RecordPrice record={c} />
                                    <Recipient
                                      record={c}
                                      text={`Для ${c.owner_name}`}
                                    />
                                    <p className="booking-note">
                                      <Info size={15} />
                                      <span>{ownerActionText(c.reason)}</span>
                                    </p>
                                  </div>
                                  <div className="booking-actions">
                                    {c.reason === "gifted" && (
                                      <button
                                        className="button primary"
                                        disabled={busy}
                                        onClick={() =>
                                          markGiven(c.gift_id, c.title, true)
                                        }
                                      >
                                        Это подарил я
                                      </button>
                                    )}
                                    <button
                                      className="button secondary"
                                      disabled={busy}
                                      onClick={() => hideRecord(c)}
                                    >
                                      Удалить у меня
                                    </button>
                                  </div>
                                </article>
                              ))}
                            </div>
                          </>
                        )}
                        {!bookings.length && !attention.length && (
                          <div className="empty">
                            <Bookmark size={34} />
                            <h3>Вы пока ничего не забронировали</h3>
                            <p>Откройте вишлист друга и нажмите «Подарю».</p>
                            <button
                              className="button primary"
                              onClick={() => void navigate("friends")}
                            >
                              Посмотреть желания друзей
                            </button>
                          </div>
                        )}
                      </>
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
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                const run = toast.action!.run;
                setToast(null);
                void run();
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Закрыть уведомление"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {reserving && (
        <ReserveDialog
          gift={reserving.gift}
          photo={
            reserving.gift.has_photo !== undefined && (
              <Photo wish={reserving.gift as Wish} own={false} />
            )
          }
          ownerId={reserving.ownerId}
          exclude={reserving.exclude}
          invite={reserving.invite}
          guest={reserving.guest}
          friends={friends}
          onClose={() => setReserving(null)}
          onBooked={async (message, code) => {
            if (code) setGuestCode(reserving.gift.id, code);
            if (message)
              telegram?.HapticFeedback?.notificationOccurred("success");
            // Inviting more friends ends with a toast; a booking keeps its «Готово!».
            if (reserving.invite) {
              setReserving(null);
              notice(message);
            }
            await reloadAfterBooking();
          }}
          onBookings={
            user
              ? () => {
                  setReserving(null);
                  void navigate("bookings");
                }
              : undefined
          }
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
      {welcome !== false && !welcomeLater && user && !modal && (
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
              share: "Поделиться",
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
                if (editing) forgetGiftPhoto(editing.id);
                if (user) await loadList(user.id);
                setGiftDirty(false);
                notice("Желание сохранено");
              }}
            />
          ) : modal === "share" ? (
            <Share
              ownerId={sharingOwn ? user?.id : owner?.id}
              ownerName={sharingOwn ? undefined : owner?.name.split(" ")[0]}
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
              friends={people.friends.length}
              webSession={webSession}
              onShare={() => setModal("share")}
              onLogout={(everywhere) => void logout(everywhere)}
            />
          ) : (
            <Suspense
              fallback={
                <div className="loading" role="status">
                  <span />
                  Загрузка…
                </div>
              }
            >
              <ImportDialog
                activeCount={own ? gifts.length : 0}
                onClose={() => setModal(null)}
                onImported={async (message) => {
                  notice(message);
                  if (user) await loadList(user.id);
                }}
              />
            </Suspense>
          )}
        </Modal>
      )}
      {confirmation && (
        <Confirm
          text={confirmation.text}
          action={confirmation.action}
          danger={confirmation.danger}
          option={confirmation.option}
          onCancel={() => setConfirmation(null)}
          onConfirm={(option) => {
            const c = confirmation;
            setConfirmation(null);
            void c.run(option);
          }}
        />
      )}
    </div>
  );
}
/** One block of «Друзья»: a heading, a note and the people in it. */
function PeopleGroup({
  title,
  note,
  children,
}: {
  title?: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="people-group">
      {title && <h2>{title}</h2>}
      {note}
      <div className="members">{children}</div>
    </div>
  );
}
/** Someone in «Друзья»; buttons under the tile, if any. */
function MemberTile({
  person: m,
  tone,
  pending,
  badge,
  onOpen,
  children,
}: {
  person: Person;
  tone: number;
  pending?: boolean;
  badge?: string;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="member-tile">
      <button className={`member ${pending ? "pending" : ""}`} onClick={onOpen}>
        <span className={`avatar tone-${tone % 4}`}>
          <Face user={m} />
        </span>
        <strong>
          {m.name.split(" ")[0]}
        </strong>
        {m.username && <small>@{m.username}</small>}
        {!pending && <span>{wishCount(m.gift_count)}</span>}
        {badge && <em className="pending-badge">{badge}</em>}
      </button>
      {children && <div className="member-actions">{children}</div>}
    </div>
  );
}
/** The public card: name, photo, @nick, how many wishes. */
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
      </p>
    </div>
  );
}
/** Add to friends (a closed list after approval), or undo it. */
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
        <Check size={16} /> В друзьях
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
      {card.follows_you ? "Добавить в ответ" : "Добавить в друзья"}
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
  mode: "own" | "friend" | "guest" | "archive";
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
          ) : g.reservation === "mine" ||
            (guestCode && g.reservation === "reserved") ? (
            // My own choice: say so, with a quiet way to cancel.
            <span className="reserve-mine">
              <span className="reserve-status mine">
                <Check size={15} />
                Это дарите вы
              </span>
              <button
                className="text-link danger"
                disabled={busy}
                onClick={onReserve}
              >
                Отменить бронь
              </button>
            </span>
          ) : mode === "friend" || mode === "guest" ? (
            g.reservation === "reserved" ? (
              <span className="reserve-status">
                <Bookmark size={14} />
                Уже выбрал кто-то другой
              </span>
            ) : (
              <button
                disabled={busy}
                className="reserve-button wide"
                onClick={onReserve}
              >
                <Gift size={17} />
                Подарю
              </button>
            )
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
    [failed, setFailed] = useState(false),
    // The photo is asked for when the card is about half a screen away.
    [near, setNear] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (near || !el) return;
    if (!("IntersectionObserver" in window)) {
      setNear(true);
      return;
    }
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "50% 0px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [near]);
  useEffect(() => {
    let alive = true;
    if (!demo && near && wish.has_photo)
      void giftPhoto(wish.id, wish.updated_at)
        .then((photo) => {
          if (alive) {
            setSrc(photo);
            setFailed(false);
          }
          if (own && /^https:\/\//.test(photo)) keepShopPhoto(wish.id, photo);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    return () => {
      alive = false;
    };
  }, [wish.id, wish.updated_at, wish.has_photo, own, near]);
  return src && !failed ? (
    <img
      loading="lazy"
      referrerPolicy="no-referrer"
      src={src}
      alt={wish.title}
      onError={() => setFailed(true)}
    />
  ) : (
    <div className="photo-placeholder" ref={box}>
      <Gift size={42} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ErrorScreen>
    <App />
  </ErrorScreen>,
);

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

/** What the owner did to a gift I chose, as my card says it (flow 16). */
function ownerActionText(reason: GiverRecord["reason"]) {
  return reason === "deleted"
    ? "Владелец удалил своё желание. Бронь закрыта."
    : reason === "changed_mind"
      ? "Передумал: больше не хочет этот подарок. Бронь закрыта."
      : reason === "bought_self"
        ? "Куплено: владелец купил его сам. Бронь закрыта."
        : "Получатель отметил, что получил подарок. Если это ваш, нажмите «Это подарил я».";
}
function changedText(fields: string) {
  return fields
    .split(",")
    .map((f) => ({ title: "название", price: "цену", link: "ссылку" })[f])
    .filter(Boolean)
    .join(", ");
}
const shortDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
/** The recipient on a booking card: avatar and «Для …» or «Подарено …». */
function Recipient({
  record,
  text,
}: {
  record: { owner_id: string; owner_name: string; owner_photo_at?: number | null };
  text: string;
}) {
  return (
    <p className="booking-for">
      <span className="avatar tiny">
        <Face
          user={{
            id: record.owner_id,
            name: record.owner_name,
            photo_at: record.owner_photo_at ?? null,
          }}
        />
      </span>
      {text}
    </p>
  );
}
function RecordPrice({ record: r }: { record: GiverRecord }) {
  return r.price_minor !== null || r.price_max_minor !== null ? (
    <p className="booking-price">
      <strong>{formatPrice(r)}</strong>
    </p>
  ) : null;
}
/** The photo kept with my own record, read even after the wish is gone. */
function RecordPhoto({ record }: { record: GiverRecord }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!record.has_photo || demo) return;
    let alive = true;
    api<{ photo: string }>(`/api/reservations/${record.gift_id}/photo`)
      .then((r) => alive && setSrc(r.photo))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [record.gift_id, record.has_photo]);
  return (
    <div className="booking-photo">
      {src ? (
        <img src={src} alt={record.title} referrerPolicy="no-referrer" />
      ) : (
        <div className="photo-placeholder">
          <Gift size={36} />
        </div>
      )}
    </div>
  );
}
