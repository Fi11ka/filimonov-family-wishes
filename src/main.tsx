import { GuestBookings, ArchiveWish } from "./forms";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Gift,
  Heart,
  Users,
  Bookmark,
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
  ShieldCheck,
  RefreshCw,
  Menu,
  Archive,
  ArchiveRestore,
  FileSpreadsheet,
  UserPlus,
  UserMinus,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useFullscreen } from "./fullscreen";
import {
  api,
  apiConfigured,
  demo,
  friendInvite,
  guestToken,
  authShare,
  setSessionToken,
  signedIn,
  telegram,
  telegramLink,
} from "./api";
import { WebLogin } from "./login";
import {
  demoArchive,
  demoFriends,
  demoGifts,
  demoIncoming,
  demoUser,
} from "./demo";
import { GiftForm, Share, Modal, Confirm, CopyValue } from "./forms";
import { AcceptInvite, AddFriend, Profile, Requests } from "./friends";
import { ImportDialog } from "./import/ImportDialog";
import {
  type User,
  type Friend,
  type Wish,
  priorities,
  initials,
  handle,
  money,
  wishCount,
} from "./types";
import "./style.css";
type Tab = "mine" | "friends" | "bookings" | "archive";
type ModalKind =
  | "guest-bookings"
  | "gift"
  | "share"
  | "add-friend"
  | "profile"
  | "import"
  | "invite";
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
    [sort, setSort] = useState("priority");
  const [bookings, setBookings] = useState<
      { gift_id: string; title: string; archived?: number }[]
    >([]),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState(false),
    [webSession, setWebSession] = useState(false),
    [showBrowserLogin, setShowBrowserLogin] = useState(false);
  const [archiveGift, setArchiveGift] = useState<Wish | null>(null);
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
  const [guestName, setGuestName] = useState("");
  const own =
    !!user &&
    owner?.id === user.id &&
    !(guestToken && !authShare && tab === "friends");
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
      setArchive((await api("/api/archive")).gifts);
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
      if (guestToken && (!authShare || signedIn())) {
        const d = await api("/api/guest");
        setOwner(d.owner);
        setGifts(d.gifts);
        if (signedIn()) {
          const me = await api("/api/me");
          setUser(me.user);
          setWebSession(!!me.web_session);
        }
      } else if (signedIn()) {
        const me = await api("/api/me");
        setUser(me.user);
        setWebSession(!!me.web_session);
        if (tab === "mine" || !owner) {
          const d = await api(`/api/lists/${me.user.id}`);
          setOwner(d.owner);
          setGifts(d.gifts);
        } else if (owner) await loadList(owner.id);
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
    void refresh();
  }, []);
  async function navigate(next: Tab) {
    setMenu(false);
    setTab(next);
    setSearch("");
    setError("");
    if (demo) {
      if (next === "mine") {
        setOwner(demoUser);
        setGifts(demoGifts);
      }
      if (next === "friends") {
        setOwner(null);
        setGifts([]);
      }
      return;
    }
    if (next === "mine" && user) await loadList(user.id);
    if (next === "friends" && guestToken) await refresh();
    if (next === "friends" && !guestToken) {
      setOwner(null);
      setGifts([]);
      try {
        await loadFriends();
      } catch (e) {
        setError((e as Error).message);
      }
    }
    if (next === "archive") await loadArchive();
    if (next === "bookings") {
      setLoading(true);
      try {
        setBookings((await api("/api/reservations")).reservations);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }
  }
  function openFriend(f: Friend) {
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
    if (guestToken && !authShare) {
      setGuestGift(g);
      return;
    }
    await guarded(async () => {
      try {
        await api(
          `/api/gifts/${g.id}/reservation`,
          g.reservation === "mine" ? "DELETE" : "POST",
        );
        telegram?.HapticFeedback?.notificationOccurred("success");
        notice(
          g.reservation === "mine"
            ? "Бронь отменена"
            : "Подарок забронирован. Это наш секрет!",
        );
      } finally {
        if (owner) await loadList(owner.id);
      }
    }, "Бронирование доступно после подключения приложения.");
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
  const shown = list
    .filter((g) => g.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      sort === "price"
        ? byPrice(a, b, 1)
        : sort === "price-desc"
          ? byPrice(a, b, -1)
          : sort === "priority-asc"
            ? a.priority - b.priority
            : b.priority - a.priority,
    );
  const locked = !demo && !user && (!guestToken || authShare) && !loading;
  const viewingFriend = tab === "friends" && !!owner && !own;
  const showList =
    tab === "mine" || tab === "archive" || !!guestToken || viewingFriend;
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
        <div className="sidebar-caption">МАЛЕНЬКИЕ МЕЧТЫ. БОЛЬШАЯ СЕМЬЯ.</div>
        <nav aria-label="Основная навигация">
          {(
            [
              ["mine", Heart, "Мой вишлист"],
              ["friends", Users, "Друзья"],
              ["bookings", Bookmark, "Мои брони"],
              ["archive", Archive, "Архив"],
            ] as const
          ).map(([key, I, label]) => (
            <button
              key={key}
              className={`nav-item ${tab === key ? "active" : ""}`}
              onClick={() => void navigate(key)}
              disabled={!!guestToken && key !== "friends" && !user}
            >
              <I size={20} />
              {label}
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
        <div className="sidebar-note">
          <div className="note-icon">
            <Sparkles size={22} />
          </div>
          <strong>Дарить — это про любовь</strong>
          <p>
            Сохраняйте желания.
            <br />
            Радуйте друг друга.
          </p>
          <span className="note-hearts">
            ♡ <span>♡</span> ♡
          </span>
        </div>
        <div className="sidebar-bottom">
          <ShieldCheck size={17} />
          <span>Сюрпризы под защитой</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setMenu(!menu)}
            aria-label="Открыть меню"
          >
            <Menu />
          </button>
          <span className="breadcrumb">
            Вишлисты близких <span>♡</span>
          </span>
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
            <button
              className="family-chip"
              onClick={() => setModal("profile")}
              disabled={!user}
            >
              <span className="family-dot" />
              {user ? handle(user) || user.name.split(" ")[0] : "Гость"}
              <ChevronDown size={14} />
            </button>
            <span className="avatar small">
              {initials(user?.name || "Гость")}
            </span>
          </div>
        </header>
        <main>
          {locked ? (
            <section className="welcome">
              <span className="welcome-icon">
                <Gift size={42} />
              </span>
              <div className="eyebrow">FILIMONOV FAMILY WISHES</div>
              <h1>
                Все желания близких.
                <br />
                <em>В одном месте.</em>
              </h1>
              <p>
                Мечтайте, сохраняйте подарки и готовьте друг другу сюрпризы.
              </p>
              <a className="button primary" href={telegramLink()}>
                Открыть в Telegram <ArrowUpRight size={18} />
              </a>
              <p className="small-text">
                Приложение откроется внутри Telegram. Вход — вашим
                Telegram-аккаунтом.
              </p>
              <div className="welcome-app-link">
                <span className="small-text">
                  Ссылка для открытия и отправки близким
                </span>
                <CopyValue value={telegramLink()} />
              </div>
              {apiConfigured && !telegram?.initData && (
                <details
                  className="browser-login-option"
                  onToggle={(e) => setShowBrowserLogin(e.currentTarget.open)}
                >
                  <summary>Остаться в браузере</summary>
                  {showBrowserLogin && (
                    <WebLogin onSignedIn={() => void refresh()} />
                  )}
                </details>
              )}
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              {!apiConfigured && (
                <p className="small-text">
                  Приложение подготовлено. Осталось подключить API и
                  опубликовать его.
                </p>
              )}
              <a className="text-link" href="?demo=1">
                Посмотреть интерфейс
              </a>
            </section>
          ) : (
            <>
              {guestToken && (
                <div className="guest-banner">
                  <LinkIcon size={18} />
                  <span>
                    {authShare
                      ? "Вишлист по ссылке Telegram"
                      : "Вишлист для близких · без регистрации"}
                  </span>
                  {user && (
                    <a href={location.pathname}>
                      Мой вишлист <ArrowUpRight size={14} />
                    </a>
                  )}
                </div>
              )}
              {guestToken && authShare && user && owner && !own && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void guarded(async () => {
                      await api("/api/friends/requests", "POST", {
                        user_id: owner.id,
                      });
                      notice("Запрос в друзья отправлен");
                    }, "")
                  }
                >
                  Добавить в друзья · {owner.name}
                </button>
              )}
              <div className="page-title">
                <div>
                  <div className="eyebrow">
                    {tab === "archive"
                      ? "ИСПОЛНЕННЫЕ МЕЧТЫ"
                      : "СОБИРАЕМ ТО, ЧТО РАДУЕТ"}
                  </div>
                  <h1>
                    {tab === "bookings"
                      ? "Мои маленькие сюрпризы"
                      : tab === "archive"
                        ? "Архив"
                        : tab === "friends" && !guestToken && !viewingFriend
                          ? "Желания друзей"
                          : own
                            ? "Мой вишлист"
                            : `Вишлист ${ownerFirst}`}
                    <span className="title-sparkle">✧</span>
                  </h1>
                  <p>
                    {tab === "bookings"
                      ? "Подарки, которые вы выбрали для близких."
                      : tab === "archive"
                        ? "Желания, которые вы убрали из списка. Любое можно вернуть в вишлист."
                        : own
                          ? "Пусть близким будет чуть проще сделать вас счастливее."
                          : "Самые тёплые подарки начинаются с маленькой подсказки."}
                  </p>
                </div>
                {tab === "mine" && user && (
                  <div className="title-actions">
                    <button
                      className="button secondary"
                      onClick={() => setModal("import")}
                    >
                      <FileSpreadsheet size={18} />
                      Импорт
                    </button>
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
              {!error && tab === "friends" && !guestToken && (
                <section className="family-section">
                  <div className="section-heading">
                    <h2>Кого порадуем?</h2>
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
                            {initials(m.name)}
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
                      <h3>Вместе мечтать ещё приятнее</h3>
                      <p>
                        Добавьте близких по нику в Telegram или отправьте им
                        ссылку-приглашение.
                      </p>
                      <button
                        className="button primary"
                        onClick={() => setModal("add-friend")}
                      >
                        Добавить друга
                      </button>
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
                  {tab !== "archive" && (
                    <section className="hero">
                      <div className="hero-copy">
                        <span className="hero-label">
                          <Heart size={14} /> ДЛЯ ТЕХ, КТО РЯДОМ
                        </span>
                        <h2>
                          {own
                            ? "Здесь живут мои «хочу»"
                            : "Идеи для счастливых улыбок"}
                        </h2>
                        <p>
                          {own
                            ? "От маленьких радостей до большой мечты."
                            : "Выберите подарок, забронируйте и сохраните сюрприз."}
                          <br />
                          {own
                            ? "А сюрпризы пусть остаются сюрпризами."
                            : guestToken && !authShare
                              ? "Для бронирования достаточно вашего имени."
                              : "Владелец списка ничего не узнает."}
                        </p>
                        {own && (
                          <button
                            className="hero-share"
                            onClick={() => {
                              if (demo) {
                                notice(
                                  "Ссылки для близких будут доступны после подключения.",
                                );
                                return;
                              }
                              setModal("share");
                            }}
                          >
                            <LinkIcon size={16} />
                            Поделиться вишлистом
                            <ArrowUpRight size={15} />
                          </button>
                        )}
                        {viewingFriend && owner && (
                          <button
                            className="hero-share subtle"
                            onClick={() => unfriend(owner)}
                          >
                            <UserMinus size={15} />
                            Убрать из друзей
                          </button>
                        )}
                      </div>
                      <div className="gift-art" aria-hidden="true">
                        <span className="art-star s1">✧</span>
                        <span className="art-star s2">✦</span>
                        <span className="art-heart">♡</span>
                        <div className="present shadow-present">
                          <i />
                          <b />
                        </div>
                        <div className="present main-present">
                          <div className="bow b1" />
                          <div className="bow b2" />
                          <i />
                          <b />
                        </div>
                        <span className="art-dot" />
                      </div>
                      <div className="wish-counter">
                        <strong>{gifts.length}</strong>
                        <span>
                          маленьких
                          <br />
                          подсказок
                        </span>
                      </div>
                    </section>
                  )}
                  {own && tab === "mine" && (
                    <button
                      className="button secondary guest-management"
                      onClick={() => setModal("guest-bookings")}
                    >
                      Выбор подарков без входа в Telegram
                    </button>
                  )}
                  {own && tab === "mine" && (
                    <div className="privacy-note">
                      <ShieldCheck size={16} />
                      <span>
                        Вы не видите бронирования своих подарков. Всё, чтобы
                        сохранить волшебство.
                      </span>
                    </div>
                  )}

                  <div className="list-toolbar">
                    <h2>
                      {tab === "archive"
                        ? "Архив желаний"
                        : own
                          ? "Мои желания"
                          : "Список желаний"}{" "}
                      <span>{list.length}</span>
                    </h2>
                    <div className="list-controls">
                      <label className="search">
                        <Search size={16} />
                        <input
                          aria-label="Найти желание"
                          placeholder="Найти желание"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
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
                        className="icon-button"
                        aria-label="Обновить список"
                        onClick={() => {
                          if (demo) notice("Демонстрационные данные");
                          else if (tab === "archive") void loadArchive();
                          else if (owner) void loadList(owner.id);
                        }}
                      >
                        <RefreshCw size={17} />
                      </button>
                    </div>
                  </div>
                  {loading ? (
                    <div className="loading" role="status">
                      <span />
                      Собираем желания…
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
                        {search
                          ? "Ничего не нашлось"
                          : tab === "archive"
                            ? "Архив пока пуст"
                            : "У каждой мечты есть начало"}
                      </h3>
                      <p>
                        {search
                          ? "Попробуйте другое название."
                          : tab === "archive"
                            ? "Когда желание исполнится, нажмите «Отправить в архив» — оно переедет сюда."
                            : own
                              ? "Добавьте первое желание — близкие будут благодарны за подсказку."
                              : "Здесь пока нет желаний. Загляните чуть позже."}
                      </p>
                    </div>
                  )}
                </>
              )}
              {tab === "bookings" &&
                (loading ? (
                  <div className="loading" role="status">
                    <span />
                    Загружаем сюрпризы…
                  </div>
                ) : (
                  <section className="bookings">
                    {bookings.length ? (
                      bookings.map((b) => (
                        <div className="booking" key={b.gift_id}>
                          <span className="booking-icon">
                            <Gift />
                          </span>
                          <div>
                            <h3>{b.title}</h3>
                            <p>
                              {b.archived
                                ? "Владелец отметил желание как исполненное"
                                : "Вы подготовите этот сюрприз"}
                            </p>
                          </div>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void guarded(async () => {
                                await api(
                                  `/api/gifts/${b.gift_id}/reservation`,
                                  "DELETE",
                                );
                                setBookings(
                                  bookings.filter(
                                    (x) => x.gift_id !== b.gift_id,
                                  ),
                                );
                                notice("Бронь отменена");
                              }, "Бронирование доступно после подключения приложения.")
                            }
                          >
                            Отменить бронь
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="empty">
                        <Bookmark size={34} />
                        <h3>Самое приятное ещё впереди</h3>
                        <p>
                          Выберите желание близкого человека и нажмите
                          «Подарю!».
                        </p>
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
          <footer>
            <Heart size={13} />
            <span>Сделано для нашей семьи, с любовью</span>
            <span className="footer-brand">Filimonov Family Wishes</span>
          </footer>
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
                  await api(`/api/guest-reservations/${guestGift.id}`, "POST", {
                    name: guestName,
                  });
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
              Регистрация не нужна. Если ошиблись, владелец вишлиста сможет
              исправить или отменить эту бронь.
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
      {modal && (
        <Modal
          wide={modal === "import"}
          title={
            {
              gift: editing
                ? "Редактировать желание"
                : "Новое маленькое желание",
              "guest-bookings": "Выбор подарков без входа в Telegram",
              share: "Поделиться мечтами",
              "add-friend": "Добавить друга",
              profile: "Мой профиль",
              import: "Импорт вишлиста",
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
          ) : modal === "guest-bookings" ? (
            <GuestBookings />
          ) : modal === "share" ? (
            <Share />
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
/**
 * Prices in different currencies cannot be compared, so wishes are grouped by
 * currency; wishes without a price always go last. A range counts by its lower
 * bound when sorting cheap first and by its upper bound when sorting expensive first.
 */
function byPrice(a: Wish, b: Wish, dir: 1 | -1) {
  const key = (g: Wish) =>
    dir === 1
      ? (g.price_minor ?? g.price_max_minor ?? null)
      : (g.price_max_minor ?? g.price_minor ?? null);
  const ka = key(a),
    kb = key(b);
  if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? 1 : -1;
  return a.currency.localeCompare(b.currency) || dir * (ka - kb);
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
}: {
  wish: Wish;
  mode: "own" | "friend" | "guest" | "archive";
  busy: boolean;
  onEdit: () => void;
  onBought: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onReserve: () => void;
}) {
  return (
    <article className={`gift-card ${mode === "archive" ? "archived" : ""}`}>
      <div className="photo-wrap">
        <Photo wish={g} />
        <span className={`priority p${g.priority}`}>
          {g.priority === 3 ? <Sparkles size={12} /> : <Heart size={12} />}{" "}
          {priorities[g.priority]}
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
        {mode === "archive" && (
          <span className="archived-badge">
            <Check size={12} />{" "}
            {g.archive_reason === "changed_mind"
              ? "Передумал"
              : g.archive_reason === "gifted"
                ? "Подарили"
                : "Купил сам"}
            {g.archived_at
              ? ` · ${new Date(g.archived_at * 1000).toLocaleDateString("ru-RU")}`
              : ""}
          </span>
        )}
      </div>
      <div className="card-content">
        <div className="gift-price">{money(g)}</div>
        <h3>{g.title}</h3>
        <p>{g.description || "Ещё одна маленькая мечта."}</p>
        {mode === "archive" && g.gifted_by_name && (
          <p className="archive-donor">
            Подарил(а): {g.gifted_by_name}
            {g.gifted_by_username ? ` · @${g.gifted_by_username}` : ""}
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
          ) : (
            <span className="card-hint">Выбрано с любовью</span>
          )}
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
          ) : mode === "friend" || mode === "guest" ? (
            <button
              disabled={busy || g.reservation === "reserved"}
              className={`reserve-button ${g.reservation === "mine" ? "mine" : ""}`}
              onClick={onReserve}
            >
              {g.reservation === "reserved" ? (
                <>
                  <Bookmark size={13} />
                  Уже выбрали
                </>
              ) : g.reservation === "mine" ? (
                <>
                  <Check size={14} />
                  Отменить бронь
                </>
              ) : (
                <>
                  <Gift size={14} />
                  Подарю!
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
      <span>Маленькая мечта</span>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
