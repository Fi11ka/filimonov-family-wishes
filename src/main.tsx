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
} from "lucide-react";
import {
  api,
  apiConfigured,
  demo,
  guestToken,
  telegram,
  telegramLink,
} from "./api";
import { demoFamily, demoGifts, demoMembers, demoUser } from "./demo";
import { GiftForm, FamilyForm, Share, FamilySettings, Modal } from "./forms";
import {
  type User,
  type Family,
  type Wish,
  type Member,
  priorities,
  initials,
  money,
  wishCount,
} from "./types";
import "./style.css";
function App() {
  const [user, setUser] = useState<User | null>(demo ? demoUser : null),
    [family, setFamily] = useState<Family | null>(demo ? demoFamily : null);
  const [members, setMembers] = useState<Member[]>(demo ? demoMembers : []),
    [owner, setOwner] = useState<User | null>(demo ? demoUser : null),
    [gifts, setGifts] = useState<Wish[]>(demo ? demoGifts : []);
  const [tab, setTab] = useState<"mine" | "family" | "bookings">(
      guestToken ? "family" : "mine",
    ),
    [loading, setLoading] = useState(!demo),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const [modal, setModal] = useState<
      "gift" | "family" | "share" | "settings" | null
    >(null),
    [editing, setEditing] = useState<Wish | null>(null),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("priority");
  const [bookings, setBookings] = useState<
      { gift_id: string; title: string }[]
    >([]),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState(false);
  const own = !!user && owner?.id === user.id;
  const notice = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 4500);
  };
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
  async function refresh() {
    if (demo) return;
    setLoading(true);
    setError("");
    try {
      if (guestToken) {
        const d = await api("/api/guest");
        setOwner(d.owner);
        setGifts(d.gifts);
        if (telegram?.initData) {
          const me = await api("/api/me");
          setUser(me.user);
          setFamily(me.family);
        }
      } else if (telegram?.initData) {
        const me = await api("/api/me");
        setUser(me.user);
        setFamily(me.family);
        const d = await api(`/api/lists/${me.user.id}`);
        setOwner(d.owner);
        setGifts(d.gifts);
        if (me.family) setMembers((await api("/api/family/members")).members);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
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
  async function navigate(next: typeof tab) {
    setMenu(false);
    setTab(next);
    setSearch("");
    if (demo) {
      if (next === "mine") {
        setOwner(demoUser);
        setGifts(demoGifts);
      }
      return;
    }
    setError("");
    if (next === "mine" && user) await loadList(user.id);
    if (next === "family" && family) {
      try {
        setMembers((await api("/api/family/members")).members);
      } catch (e) {
        setError((e as Error).message);
      }
    }
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
  async function reserve(g: Wish) {
    if (demo) {
      notice("Бронирование доступно после подключения приложения.");
      return;
    }
    setBusy(true);
    try {
      await api(
        `/api/gifts/${g.id}/reservation`,
        g.reservation === "mine" ? "DELETE" : "POST",
      );
      telegram?.HapticFeedback?.notificationOccurred("success");
      if (owner) await loadList(owner.id);
      notice(
        g.reservation === "mine"
          ? "Бронь отменена"
          : "Подарок забронирован. Это наш секрет!",
      );
    } catch (e) {
      notice((e as Error).message);
      if (owner) await loadList(owner.id);
    } finally {
      setBusy(false);
    }
  }
  async function remove(g: Wish) {
    if (!confirm(`Удалить «${g.title}» из списка?`)) return;
    setBusy(true);
    try {
      await api(`/api/gifts/${g.id}`, "DELETE");
      if (user) await loadList(user.id);
      notice("Желание удалено");
    } catch (e) {
      notice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const shown = gifts
    .filter((g) => g.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      sort === "price"
        ? a.currency.localeCompare(b.currency) ||
          (a.price_minor ?? Infinity) - (b.price_minor ?? Infinity)
        : b.priority - a.priority,
    );
  const locked = !demo && !user && !guestToken && !loading;
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
          {[
            ["mine", Heart, "Мой вишлист"],
            ["family", Users, "Моя семья"],
            ["bookings", Bookmark, "Мои брони"],
          ].map(([key, Icon, label]) => {
            const I = Icon as typeof Heart;
            return (
              <button
                key={String(key)}
                className={`nav-item ${tab === key ? "active" : ""}`}
                onClick={() => void navigate(key as typeof tab)}
                disabled={!!guestToken && key !== "family" && !user}
              >
                <I size={20} />
                {String(label)}
                {tab === key && <span className="nav-dot" />}
              </button>
            );
          })}
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
            Наше семейное пространство <span>♡</span>
          </span>
          <div className="topbar-right">
            {demo && <span className="demo-badge">Демо · без сохранения</span>}
            <button
              className="family-chip"
              onClick={() => setModal(family ? "settings" : "family")}
            >
              <span className="family-dot" />
              {family?.name || "Вместе — лучше"}
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
                Все желания семьи.
                <br />
                <em>В одном месте.</em>
              </h1>
              <p>
                Мечтайте, сохраняйте подарки и готовьте друг другу сюрпризы.
              </p>
              <a className="button primary" href={telegramLink()}>
                Открыть в Telegram <ArrowUpRight size={18} />
              </a>
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
                    Гостевой список · доступ только к желаниям этого участника
                  </span>
                  {user && (
                    <a href={location.pathname}>
                      Мой вишлист <ArrowUpRight size={14} />
                    </a>
                  )}
                </div>
              )}
              <div className="page-title">
                <div>
                  <div className="eyebrow">СОБИРАЕМ ТО, ЧТО РАДУЕТ</div>
                  <h1>
                    {tab === "bookings"
                      ? "Мои маленькие сюрпризы"
                      : tab === "family" && !guestToken
                        ? "Желания любимых"
                        : own
                          ? "Мой вишлист"
                          : `Вишлист ${owner?.name.split(" ")[0] || "участника"}`}
                    <span className="title-sparkle">✧</span>
                  </h1>
                  <p>
                    {tab === "bookings"
                      ? "Подарки, которые вы выбрали для близких."
                      : own
                        ? "Пусть близким будет чуть проще сделать вас счастливее."
                        : "Самые тёплые подарки начинаются с маленькой подсказки."}
                  </p>
                </div>
                {tab === "mine" && user && (
                  <button
                    className="button primary"
                    onClick={() => {
                      if (demo) {
                        notice(
                          "Это демо. Добавление будет доступно в подключённом приложении.",
                        );
                        return;
                      }
                      setEditing(null);
                      setModal("gift");
                    }}
                  >
                    <Plus size={18} />
                    Добавить желание
                  </button>
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
              {!error && tab !== "bookings" && (
                <>
                  {tab === "family" && !guestToken && (
                    <section className="family-section">
                      <div className="section-heading">
                        <h2>Кого порадуем?</h2>
                        <button
                          className="text-link"
                          onClick={() =>
                            setModal(family ? "settings" : "family")
                          }
                        >
                          <Plus size={16} />
                          {family ? "Пригласить в семью" : "Создать семью"}
                        </button>
                      </div>
                      {family ? (
                        <div className="members">
                          {members.map((m, i) => (
                            <button
                              className={`member ${m.id === owner?.id ? "selected" : ""}`}
                              key={m.id}
                              onClick={() => {
                                if (demo) {
                                  setOwner(m);
                                  setGifts(
                                    demoGifts
                                      .slice(0, m.gift_count)
                                      .map((g, n) => ({
                                        ...g,
                                        owner_id: m.id,
                                        reservation:
                                          m.id === user?.id
                                            ? undefined
                                            : n === 1
                                              ? "reserved"
                                              : n === 2
                                                ? "mine"
                                                : "available",
                                      })),
                                  );
                                } else void loadList(m.id);
                              }}
                            >
                              <span className={`avatar tone-${i % 4}`}>
                                {initials(m.name)}
                                {m.id === owner?.id && (
                                  <span className="avatar-check">
                                    <Check size={10} />
                                  </span>
                                )}
                              </span>
                              <strong>
                                {m.name.split(" ")[0]}
                                {m.id === user?.id ? " (вы)" : ""}
                              </strong>
                              <span>{wishCount(m.gift_count)}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="empty compact">
                          <Users />
                          <h3>Вместе мечтать ещё приятнее</h3>
                          <p>
                            Создайте семью или присоединитесь по коду
                            приглашения.
                          </p>
                          <button
                            className="button primary"
                            onClick={() => setModal("family")}
                          >
                            Собрать семью
                          </button>
                        </div>
                      )}
                    </section>
                  )}
                  {(tab === "mine" || guestToken || family) && (
                    <>
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
                              : "Владелец списка ничего не узнает."}
                          </p>
                          {own && (
                            <button
                              className="hero-share"
                              onClick={() => {
                                if (demo) {
                                  notice(
                                    "Гостевая ссылка будет доступна после подключения.",
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
                      {own && (
                        <div className="privacy-note">
                          <ShieldCheck size={16} />
                          <span>
                            Вы не видите бронирования своих подарков. Всё, чтобы
                            сохранить волшебство.
                          </span>
                        </div>
                      )}
                      {guestToken && !user && (
                        <div className="privacy-note guest-login">
                          <ShieldCheck size={18} />
                          <span>
                            Для бронирования откройте этот список в Telegram.
                            Вступать в семью не нужно.
                          </span>
                          <a className="button primary" href={telegramLink()}>
                            Открыть <ArrowUpRight size={15} />
                          </a>
                        </div>
                      )}
                      <div className="list-toolbar">
                        <h2>
                          {own ? "Мои желания" : "Список желаний"}{" "}
                          <span>{gifts.length}</span>
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
                              <option value="priority">По приоритету</option>
                              <option value="price">По валюте и цене</option>
                            </select>
                            <ChevronDown size={14} />
                          </label>
                          <button
                            className="icon-button"
                            aria-label="Обновить список"
                            onClick={() => {
                              if (demo) notice("Демонстрационные данные");
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
                            <article className="gift-card" key={g.id}>
                              <div className="photo-wrap">
                                <Photo wish={g} />
                                <span className={`priority p${g.priority}`}>
                                  {g.priority === 3 ? (
                                    <Sparkles size={12} />
                                  ) : (
                                    <Heart size={12} />
                                  )}{" "}
                                  {priorities[g.priority]}
                                </span>
                                {own && (
                                  <button
                                    className="card-edit"
                                    aria-label={`Редактировать ${g.title}`}
                                    onClick={() => {
                                      if (demo) {
                                        notice(
                                          "Редактирование доступно в подключённом приложении.",
                                        );
                                        return;
                                      }
                                      setEditing(g);
                                      setModal("gift");
                                    }}
                                  >
                                    <Pencil size={15} />
                                  </button>
                                )}
                              </div>
                              <div className="card-content">
                                <div className="gift-price">{money(g)}</div>
                                <h3>{g.title}</h3>
                                <p>
                                  {g.description || "Ещё одна маленькая мечта."}
                                </p>
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
                                    <span className="card-hint">
                                      Выбрано с любовью
                                    </span>
                                  )}
                                  {own ? (
                                    <button
                                      className="icon-button delete-button"
                                      aria-label={`Удалить ${g.title}`}
                                      disabled={busy || demo}
                                      onClick={() => void remove(g)}
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  ) : user ? (
                                    <button
                                      disabled={
                                        busy || g.reservation === "reserved"
                                      }
                                      className={`reserve-button ${g.reservation === "mine" ? "mine" : ""}`}
                                      onClick={() => void reserve(g)}
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
                                    <a
                                      className="reserve-button"
                                      href={telegramLink()}
                                    >
                                      Хочу подарить
                                    </a>
                                  )}
                                </div>
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="empty">
                          <Gift size={34} />
                          <h3>
                            {search
                              ? "Ничего не нашлось"
                              : "У каждой мечты есть начало"}
                          </h3>
                          <p>
                            {search
                              ? "Попробуйте другое название."
                              : own
                                ? "Добавьте первое желание — близкие будут благодарны за подсказку."
                                : "Здесь пока нет желаний. Загляните чуть позже."}
                          </p>
                        </div>
                      )}
                    </>
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
                            <p>Вы подготовите этот сюрприз</p>
                          </div>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              try {
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
                              } catch (e) {
                                notice((e as Error).message);
                              } finally {
                                setBusy(false);
                              }
                            }}
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
                          onClick={() => void navigate("family")}
                        >
                          Посмотреть желания семьи
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
      {modal && (
        <Modal
          title={
            modal === "gift"
              ? editing
                ? "Редактировать желание"
                : "Новое маленькое желание"
              : modal === "family"
                ? "Добро пожаловать в семью"
                : modal === "share"
                  ? "Поделиться мечтами"
                  : "Наша семья"
          }
          onClose={() => setModal(null)}
        >
          {modal === "gift" ? (
            <GiftForm
              gift={editing}
              onSaved={async () => {
                setModal(null);
                if (user) await loadList(user.id);
                notice("Желание сохранено");
              }}
            />
          ) : modal === "family" ? (
            <FamilyForm
              onDone={async () => {
                setModal(null);
                await refresh();
              }}
            />
          ) : modal === "share" ? (
            <Share />
          ) : (
            <FamilySettings
              family={family}
              user={user}
              members={members}
              onChanged={async () => {
                setModal(null);
                await refresh();
              }}
            />
          )}
        </Modal>
      )}
    </div>
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
