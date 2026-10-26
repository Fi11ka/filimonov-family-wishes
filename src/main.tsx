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
  SlidersHorizontal,
} from "lucide-react";
import { useFullscreen } from "./fullscreen";
import { Hearts } from "./hearts";
import {
  api,
  apiConfigured,
  BOT,
  demo,
  friendInvite,
  guestCodes,
  guestToken,
  openBot,
  openInBrowser,
  openTarget,
  redeemHandoff,
  RequestError,
  setGuestCode,
  authShare,
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
import { AcceptInvite, AddFriend, Profile, Requests } from "./friends";
import { Features, Welcome } from "./welcome";
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
  type User,
  type Friend,
  type Wish,
  initials,
  handle,
  wishCount,
  money,
} from "./types";
import "./style.css";
type Tab = "mine" | "friends" | "bookings" | "events" | "archive" | "event";
type ModalKind =
  "gift" | "share" | "add-friend" | "profile" | "import" | "invite";
interface Confirmation {
  text: string;
  action: string;
  danger?: boolean;
  run: () => Promise<void>;
}
function App() {
  const [user, setUser] = useState<User | null>(demo ? demoUser : null),
    [friends, setFriends] = useState<Friend[]>(demo ? demoFriends : []),
    [incoming, setIncoming] = useState<User[]>(demo ? demoIncoming : []),
    [outgoing, setOutgoing] = useState<User[]>([]);
  const [owner, setOwner] = useState<User | null>(demo ? demoUser : null),
    [gifts, setGifts] = useState<Wish[]>(demo ? demoGifts : []),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [archive, setArchive] = useState<Wish[]>(demo ? demoArchive : []);
  const [tab, setTab] = useState<Tab>(guestToken ? "friends" : "mine"),
    [loading, setLoading] = useState(!demo),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const [modal, setModal] = useState<ModalKind | null>(
      friendInvite && !demo ? "invite" : null,
    ),
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
      setTab("friends");
      setFilters(noFilters);
      const demoFriend = demo && friends.find((f) => f.id === id);
      if (demoFriend) openFriend(demoFriend);
      else await loadList(id);
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
  /** Whose list the shared link opened for a signed-in user: it offers to add them as a friend. */
  const [sharedOwner, setSharedOwner] = useState("");
  const sharedOpened = useRef(false);
  /** The first-visit tour, with the bot status for its «Открыть бота». */
  const [welcome, setWelcome] = useState<Notifications | null | false>(false);
  const welcomeShown = useRef(false);
  /** A link opened without an account: only that list, with bookings by name.
   * Signed in, the link just opens the list and the rest of the app works as usual. */
  const guestView = () => !!guestToken && !authShare && !signedIn();
  const own = !!user && owner?.id === user.id;
  const notice = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 4500);
  };
  const fullscreen = useFullscreen(notice);
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
    const f = await api("/api/friends");
    setFriends(f.friends);
    setIncoming(f.incoming);
    setOutgoing(f.outgoing);
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
      } else if (signedIn()) {
        const me = await api("/api/me");
        setUser(me.user);
        setWebSession(!!me.web_session);
        if (me.welcome && !welcomeShown.current) {
          welcomeShown.current = true;
          setWelcome(me.notifications || null);
        }
        let id = tab === "mine" || !owner ? me.user.id : owner.id;
        if (guestToken && !sharedOpened.current) {
          // First open of a shared link: show that list like a friend's one.
          sharedOpened.current = true;
          const shared = await api("/api/guest").catch(() => null);
          if (!shared) notice("Ссылка не найдена или отозвана");
          else if (shared.owner.id !== me.user.id) {
            id = shared.owner.id;
            setSharedOwner(id);
            setTab("friends");
          } else setTab("mine");
        }
        const d = await api(`/api/lists/${id}`);
        setOwner(d.owner);
        setGifts(d.gifts);
        setInvitations(d.invitations || []);
        await loadFriends();
      }
    } catch (e) {
      setError((e as Error).message);
      // A revoked website session is cleared by api(); show the sign-in screen.
      if (!signedIn()) setUser(null);
    } finally {
      setLoading(false);
    }
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
    setFriends([]);
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
    const handoff = redeemHandoff().catch((e) => notice((e as Error).message));
    void handoff.then(refresh).then(async () => {
      // Buttons in bot messages open a friend's list or «Мои брони».
      if (demo || !signedIn() || guestToken) return;
      if (new RegExp(`^l_(${ACCOUNT_ID_PART})$`).test(openTarget)) {
        setTab("friends");
        await loadList(openTarget.slice(2));
      } else if (openTarget === "b") await navigate("bookings");
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
    void loadList(f.id);
  }
  async function guarded(action: () => Promise<void>, demoMessage: string) {
    if (demo) {
      notice(demoMessage);
      return;
    }
    setBusy(true);
    try {
      await action();
    } catch (e) {
      notice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reserve(g: Wish) {
    if (guestView()) {
      if (g.reservation === "reserved" && guestCodes()[g.id])
        await guarded(async () => {
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
        }, "");
      else setGuestGift(g);
      return;
    }
    if (g.reservation !== "mine") {
      // Friends are needed to offer «Подарить вместе»; a shared link may come without them.
      if (!friends.length) await loadFriends().catch(() => undefined);
      setReserving({ gift: g, ownerId: g.owner_id });
      return;
    }
    await guarded(async () => {
      try {
        await api(`/api/gifts/${g.id}/reservation`, "DELETE");
        notice("Бронь отменена");
      } finally {
        if (owner) await loadList(owner.id);
      }
    }, "Бронирование доступно после подключения приложения.");
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
  async function cancelBooking(b: Booking) {
    await guarded(async () => {
      await api(`/api/gifts/${b.gift_id}/reservation`, "DELETE");
      setBookings(bookings.filter((x) => x.gift_id !== b.gift_id));
      notice(b.role === "organizer" ? "Бронь отменена" : "Вы вышли из подарка");
    }, "Бронирование доступно после подключения приложения.");
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
  async function toggleSubscription(f: Friend) {
    await guarded(async () => {
      const r = await api(
        `/api/subscriptions/${f.id}`,
        f.subscribed ? "DELETE" : "PUT",
      );
      setFriends((list) =>
        list.map((x) =>
          x.id === f.id ? { ...x, subscribed: r.subscribed } : x,
        ),
      );
      if (r.subscribed && !r.notifications.bot_connected) {
        notice("Уведомления включены. Откройте бота и нажмите «Запустить»");
        openBot(r.notifications.bot_url);
      } else if (r.subscribed && !r.notifications.enabled)
        notice("Уведомления включены, но в профиле выключены сообщения бота");
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
  function unfriend(f: User) {
    setConfirmation({
      text: `Убрать ${f.name} из друзей? Вы перестанете видеть вишлисты друг друга. Уже сделанные брони сохранятся.`,
      action: "Убрать",
      danger: true,
      run: () =>
        guarded(async () => {
          await api(`/api/friends/${f.id}`, "DELETE");
          setOwner(null);
          setGifts([]);
          await loadFriends();
          notice("Удалено из друзей");
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
  const locked = !demo && !user && (!guestToken || authShare) && !loading;
  const viewingFriend = tab === "friends" && !!owner && !own;
  const showList =
    tab === "mine" || tab === "archive" || guestView() || viewingFriend;
  const ownerFirst = owner?.name.split(" ")[0] || "друга";
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
              disabled={!!guestToken && key !== "friends" && !user}
            >
              <I size={20} />
              <span className="nav-label">{label}</span>
              {/* The phone tab bar has no room for the long names. */}
              <span className="nav-label-short">{short}</span>
              {key === "friends" && incoming.length > 0 && (
                <span
                  className="nav-count"
                  aria-label={`Заявок: ${incoming.length}`}
                >
                  {incoming.length}
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
                        .catch((e) => notice((e as Error).message))
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
              {guestToken ? (
                <>
                  <h1>Вам прислали вишлист</h1>
                  <p>
                    Войдите через Telegram, чтобы открыть его и забронировать
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
              {viewingFriend &&
                owner?.id === sharedOwner &&
                !friends.some((f) => f.id === owner.id) &&
                !outgoing.some((f) => f.id === owner.id) && (
                  <button
                    className="button primary add-shared-friend"
                    disabled={busy}
                    onClick={() =>
                      void guarded(async () => {
                        // The owner's own link counts as their consent; a reshared one sends a request.
                        const r = await api(
                          "/api/friend-invites/accept",
                          "POST",
                          { token: guestToken },
                        ).catch(async (e) => {
                          if ((e as RequestError).status !== 404) throw e;
                          return api("/api/friends/requests", "POST", {
                            user_id: owner.id,
                          });
                        });
                        notice(
                          r.status === "pending"
                            ? "Запрос в друзья отправлен"
                            : `Вы теперь друзья с ${owner.name.split(" ")[0]}!`,
                        );
                        await loadFriends();
                      }, "")
                    }
                  >
                    <UserPlus size={17} /> Добавить в друзья · {owner.name}
                  </button>
                )}
              {viewingFriend && (
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
                                : `Вишлист: ${owner?.name || ownerFirst}`}
                  </h1>
                  {tab === "mine" && user && (
                    <button
                      className="share-button"
                      onClick={() => {
                        if (demo) {
                          notice("В демо ссылки не создаются.");
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
                  {owner && showList && tab !== "bookings" && (
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
              {!error && tab === "friends" && !guestView() && !viewingFriend && (
                <section className="family-section">
                  <div className="section-heading">
                    <span className="muted">
                      {friends.length ? `Друзей: ${friends.length}` : ""}
                    </span>
                    <button
                      className="text-link"
                      onClick={() => setModal("add-friend")}
                    >
                      <UserPlus size={16} />
                      Добавить друга
                    </button>
                  </div>
                  <Requests
                    incoming={incoming}
                    outgoing={outgoing}
                    notice={notice}
                    onChanged={() => void loadFriends()}
                  />
                  {friends.length ? (
                    <div className="members">
                      {friends.map((m, i) => (
                        <button
                          className={`member ${m.id === owner?.id ? "selected" : ""}`}
                          key={m.id}
                          onClick={() => openFriend(m)}
                        >
                          <span className={`avatar tone-${i % 4}`}>
                            <Face user={m} />
                            {m.id === owner?.id && (
                              <span className="avatar-check">
                                <Check size={10} />
                              </span>
                            )}
                          </span>
                          <strong>{m.name.split(" ")[0]}</strong>
                          {m.username && <small>@{m.username}</small>}
                          <span>{wishCount(m.gift_count)}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty compact">
                      <Users />
                      <h3>Друзей пока нет</h3>
                      <p>
                        Добавьте друга по нику Telegram или отправьте
                        приглашение.
                      </p>
                    </div>
                  )}
                  {friends.length > 0 && !viewingFriend && (
                    <p className="muted pick-hint">
                      Выберите друга, чтобы открыть его вишлист.
                    </p>
                  )}
                </section>
              )}
              {!error && showList && (
                <>
                  {(() => {
                    // Share, notifications and unfriending in one row.
                    const canShare =
                      !!user &&
                      !own &&
                      !!owner &&
                      tab !== "archive" &&
                      owner.allow_resharing !== 0;
                    const friend = viewingFriend
                      ? friends.find((f) => f.id === owner?.id)
                      : undefined;
                    if (!owner || (!canShare && !friend)) return null;
                    return (
                      <div className="wishlist-actions">
                        {canShare && (
                          <button
                            className="button secondary"
                            onClick={() => {
                              if (demo) {
                                notice("В демо ссылки не создаются.");
                                return;
                              }
                              setModal("share");
                            }}
                          >
                            <LinkIcon size={16} />
                            Поделиться
                          </button>
                        )}
                        {friend && (
                          <>
                            {/* A switch for bot messages, not «unfollowing» the person. */}
                            <button
                              className={`button secondary notify-toggle ${friend.subscribed ? "on" : ""}`}
                              disabled={busy}
                              aria-pressed={!!friend.subscribed}
                              onClick={() => void toggleSubscription(friend)}
                              title={
                                friend.subscribed
                                  ? "Бот пишет в Telegram, когда вишлист меняется. Нажмите, чтобы выключить"
                                  : "Бот напишет в Telegram о новых и удалённых желаниях"
                              }
                            >
                              {friend.subscribed ? (
                                <>
                                  <BellRing size={16} />
                                  Уведомления включены
                                </>
                              ) : (
                                <>
                                  <Bell size={16} />
                                  Уведомлять об изменениях
                                </>
                              )}
                            </button>
                            <button
                              className="text-link danger remove-friend"
                              onClick={() => unfriend(owner)}
                            >
                              <UserMinus size={15} />
                              Удалить из друзей
                            </button>
                          </>
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
                          if (demo) notice("Демонстрационные данные");
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
                                  onClick={() => void cancelBooking(b)}
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
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            className="icon-button"
            onClick={() => setToast("")}
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
              share: "Поделиться вишлистом",
              "add-friend": "Добавить друга",
              profile: "Мой профиль",
              import: "Добавить много желаний",
              invite: "Приглашение в друзья",
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
            <Share ownerId={owner?.id} own={own} />
          ) : modal === "add-friend" ? (
            <AddFriend
              onDone={async (message) => {
                setModal(null);
                notice(message);
                await loadFriends().catch(() => undefined);
              }}
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
              friends={friends.length}
              webSession={webSession}
              onAddFriend={() => setModal("add-friend")}
              onLogout={(everywhere) => void logout(everywhere)}
            />
          ) : modal === "import" ? (
            <ImportDialog
              activeCount={own ? gifts.length : 0}
              onClose={() => setModal(null)}
              onImported={async (message) => {
                notice(message);
                if (user) await loadList(user.id);
              }}
            />
          ) : (
            <AcceptInvite
              token={friendInvite}
              onDone={async (message) => {
                setModal(null);
                notice(message);
                await loadFriends().catch(() => undefined);
                void navigate("friends");
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
        <Photo wish={g} />
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
function Photo({ wish }: { wish: Wish }) {
  const [src, setSrc] = useState(wish.photo || ""),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!demo && wish.has_photo)
      void api<{ photo: string }>(`/api/gifts/${wish.id}/photo`)
        .then((r) => {
          if (alive) setSrc(r.photo);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    return () => {
      alive = false;
    };
  }, [wish]);
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
