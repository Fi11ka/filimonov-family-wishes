// Events (flows 5, 6 and 10): as many as you like, each with its guests, two
// dates and the wishes it shows. The standard occasions from the profile only
// suggest what to create. Guests take part at once and may decline.
import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BellRing,
  CalendarPlus,
  ChevronRight,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import {
  daysLeft,
  daysUntil,
  eventDay,
  eventSpecs,
  untilText,
  upcomingEvents,
  type EventKey,
  type UpcomingEvent,
} from "../shared/events";
import { api, demo } from "./api";
import { Confirm, Modal } from "./forms";
import { WishPicker } from "./wish-picker";
import type { EventCard, Friend, ToastTone, User, Wish } from "./types";

const icons: Record<string, string> = {
  birthday: "🎂",
  new_year: "🎄",
  march8: "💐",
  feb23: "🎖",
  custom: "🎉",
};
const modeText = {
  hero: "Для одного: подарки организатору",
  everyone: "Для всех: обмен подарками",
};
const guestWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? "гость"
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? "гостя"
      : "гостей";
const when = (date: string, today: Date) => {
  const d = Math.max(0, daysUntil(date, today));
  return `${eventDay(date)} · ${d ? untilText(d) : "сегодня"}`;
};
/** «Фактическая дата» and «Когда отмечаем»: one line when they are the same day. */
function Dates({ e, today }: { e: EventCard; today: Date }) {
  return e.actual_on === e.celebrate_on ? (
    <>{when(e.celebrate_on, today)}</>
  ) : (
    <>
      Когда отмечаем: {when(e.celebrate_on, today)} · Фактическая дата:{" "}
      {eventDay(e.actual_on)}
    </>
  );
}

/**
 * The wishlist header: the occasions (info only; the owner creates an event
 * from one) and the events the viewer takes part in, plus «Создать мероприятие».
 */
export function WishlistEvents({
  owner,
  own,
  today,
  events,
  onOpen,
  onCreate,
  onProfile,
}: {
  owner: User;
  own: boolean;
  today: Date;
  /** The owner's events this viewer may see: all for the owner, else where invited. */
  events: EventCard[];
  onOpen?: (id: string) => void;
  onCreate: (occasion?: UpcomingEvent) => void;
  onProfile: () => void;
}) {
  const occasions = upcomingEvents(owner.events ?? eventSpecs(owner), today);
  return (
    <div className="wishlist-events">
      <ul className="event-chips">
        {events.map((e) => (
          <li key={e.id} className="has-party">
            <button className="event-chip" onClick={() => onOpen?.(e.id)}>
              <span className="event-chip-icon" aria-hidden="true">
                {icons[e.base]}
              </span>
              <span className="event-chip-text">
                <strong>{e.title}</strong>
                <small>
                  {eventDay(e.celebrate_on)} · {untilText(e.days)}
                </small>
              </span>
              {!!e.guests && (
                <span className="event-chip-guests" aria-label={`Гостей: ${e.guests}`}>
                  <Users size={13} />
                  {e.guests}
                </span>
              )}
              <ChevronRight size={14} className="event-chip-arrow" />
            </button>
          </li>
        ))}
        {occasions.map((o) => {
          const label = (
            <>
              <span className="event-chip-icon" aria-hidden="true">
                {icons[o.key]}
              </span>
              <span className="event-chip-text">
                <strong>{o.title}</strong>
                <small>
                  {eventDay(o.date)} · {untilText(o.days)}
                </small>
              </span>
            </>
          );
          return (
            <li key={o.key}>
              {own ? (
                <button
                  className="event-chip occasion"
                  title="Создать мероприятие по этому поводу"
                  onClick={() => onCreate(o)}
                >
                  {label}
                </button>
              ) : (
                <span className="event-chip occasion">{label}</span>
              )}
            </li>
          );
        })}
        {own && !owner.birthday && (
          <li>
            <button className="event-chip add" onClick={onProfile}>
              🎂 День рождения
            </button>
          </li>
        )}
        {own && (
          <li>
            <button className="event-chip add" onClick={() => onCreate()}>
              <CalendarPlus size={15} /> Создать мероприятие
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * «Создать мероприятие» in one form, and its edit: occasion or a title, the
 * two dates, «для одного» / «для всех», the place, which wishes and whom to
 * invite (the four groups of «Друзья»). Editing keeps the occasion and the
 * actual date.
 */
export function EventForm({
  me,
  event,
  occasion,
  people,
  wishes,
  initialWishes = null,
  initialGuests = [],
  initialPlace = "",
  onClose,
  onSaved,
}: {
  me: User;
  event?: EventCard;
  occasion?: UpcomingEvent;
  people: Friend[];
  /** My active wishes, to pick from; loaded here when not given. */
  wishes?: Pick<Wish, "id" | "title">[];
  initialWishes?: string[] | null;
  initialGuests?: string[];
  initialPlace?: string;
  onClose: () => void;
  onSaved: (e: EventCard) => Promise<void> | void;
}) {
  const occasions = upcomingEvents(me.events ?? eventSpecs(me), new Date());
  const [base, setBase] = useState<EventKey>(event?.base ?? occasion?.key ?? "custom");
  const [title, setTitle] = useState(
    event?.title ?? (occasion ? "" : ""),
  );
  const fromOccasion = occasions.find((o) => o.key === base);
  const [actual, setActual] = useState(
    event?.actual_on ?? occasion?.date ?? "",
  );
  const [later, setLater] = useState(
    !!event && event.celebrate_on !== event.actual_on,
  );
  const [celebrate, setCelebrate] = useState(event?.celebrate_on ?? "");
  const [mode, setMode] = useState<"hero" | "everyone">(event?.mode ?? "hero");
  const [place, setPlace] = useState(initialPlace);
  const [picked, setPicked] = useState<string[] | null>(initialWishes);
  const [picking, setPicking] = useState(false);
  const [guests, setGuests] = useState<string[]>(initialGuests);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mine, setMine] = useState(wishes ?? []);
  useEffect(() => {
    if (wishes || demo) return;
    api<{ gifts: Wish[] }>(`/api/lists/${me.id}`)
      .then((d) => setMine(d.gifts))
      .catch(() => undefined);
  }, []);
  const today = isoDay(new Date());
  return (
    <Modal
      title={event ? "Мероприятие" : "Создать мероприятие"}
      closeOnBackdrop={false}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="share-result event-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (demo) {
            setError("В демо мероприятия не создаются.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            const common = {
              celebrate_on: later && celebrate ? celebrate : actual,
              mode,
              place,
              wishes: picked,
              guests,
            };
            const r = event
              ? await api<{ event: EventCard }>(`/api/events/${event.id}`, "PATCH", {
                  ...common,
                  ...(event.base === "custom" ? { title } : {}),
                })
              : await api<{ event: EventCard }>("/api/events", "POST", {
                  ...common,
                  base,
                  title: base === "custom" ? title : title || undefined,
                  actual_on: actual,
                });
            await onSaved(r.event);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!event && (
          <label>
            Повод
            <select
              value={base}
              onChange={(e) => {
                const key = e.target.value as EventKey;
                setBase(key);
                const o = occasions.find((x) => x.key === key);
                if (o) setActual(o.date);
              }}
            >
              {occasions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.title} · {eventDay(o.date)}
                </option>
              ))}
              <option value="custom">Другое</option>
            </select>
          </label>
        )}
        {(base === "custom" || event?.base === "custom") && (
          <label>
            Название
            <input
              required
              maxLength={80}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Новоселье, выпускной…"
            />
          </label>
        )}
        <label>
          Фактическая дата
          <input
            type="date"
            required
            min={today}
            value={actual}
            disabled={!!event || (base !== "custom" && !!fromOccasion)}
            onChange={(e) => setActual(e.target.value)}
          />
        </label>
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={later}
            onChange={(e) => setLater(e.target.checked)}
          />
          <span>Отмечаем в другой день</span>
        </label>
        {later && (
          <label>
            Когда отмечаем
            <input
              type="date"
              required
              min={today}
              value={celebrate}
              onChange={(e) => setCelebrate(e.target.value)}
            />
          </label>
        )}
        <fieldset className="event-mode">
          <legend>Формат</legend>
          {(["hero", "everyone"] as const).map((m) => (
            <label key={m} className="setting-toggle">
              <input
                type="radio"
                name="event-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <span>{modeText[m]}</span>
            </label>
          ))}
        </fieldset>
        <label>
          Место и время
          <textarea
            rows={2}
            maxLength={1000}
            value={place}
            onChange={(e) => setPlace(e.target.value)}
            placeholder="Где и когда собираемся"
          />
        </label>
        <fieldset className="event-mode">
          <legend>Желания</legend>
          <label className="setting-toggle">
            <input
              type="radio"
              name="event-wishes"
              checked={picked === null}
              onChange={() => setPicked(null)}
            />
            <span>
              Весь вишлист
              <small className="muted"> · новые желания появятся сами</small>
            </span>
          </label>
          <label className="setting-toggle">
            <input
              type="radio"
              name="event-wishes"
              checked={picked !== null}
              onChange={() => setPicking(true)}
            />
            <span>
              {picked === null ? "Выбрать желания" : `Выбрано желаний: ${picked.length}`}
              {picked !== null && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setPicking(true)}
                >
                  Изменить
                </button>
              )}
            </span>
          </label>
        </fieldset>
        <fieldset className="event-mode">
          <legend>Кого пригласить</legend>
          {people.length ? (
            <div className="friend-picker">
              {people.map((p) => (
                <label key={p.id} className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={guests.includes(p.id)}
                    onChange={(e) =>
                      setGuests(
                        e.target.checked
                          ? [...guests, p.id]
                          : guests.filter((g) => g !== p.id),
                      )
                    }
                  />
                  {p.name}
                  {p.username ? ` · @${p.username}` : ""}
                </label>
              ))}
            </div>
          ) : (
            <p className="small-text">
              Пригласить можно людей из «Друзей»: добавьте кого-нибудь или
              поделитесь своим профилем.
            </p>
          )}
          <small className="muted">
            Приглашённые сразу участвуют; отказаться они смогут сами.
            Приглашение не меняет дружбу.
          </small>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full-width" disabled={busy}>
          {busy ? "Сохраняем…" : event ? "Сохранить" : "Создать"}
        </button>
      </form>
      {picking && (
        <WishPicker
          wishes={mine}
          initial={picked}
          onClose={() => setPicking(false)}
          onDone={(ids) => {
            setPicked(ids);
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

type EventPageData = {
  event: EventCard;
  owner: { id: string; name: string; username: string | null };
  place: string;
  is_owner: boolean;
  member: { declined: boolean } | null;
  guests: { id: string; name: string; username: string | null; declined: boolean }[];
  wishes: Wish[];
  wish_ids: string[] | null;
};

/**
 * One event: what and when, the place, who takes part, and the wishes it
 * shows. The organizer edits and cancels it here; a guest declines or comes
 * back. An event that is gone says so and leads to «Мои мероприятия».
 */
export function EventPage({
  id,
  me,
  today,
  people,
  onBack,
  onEvents,
  onOpenList,
  renderWishes,
  notice,
}: {
  id: string;
  me: User;
  today: Date;
  people: Friend[];
  onBack: () => void;
  onEvents: () => void;
  onOpenList: (id: string, named?: string) => void;
  /** The wishes as cards with «Подарю»; reloads after a booking via `reload`. */
  renderWishes: (wishes: Wish[], reload: () => Promise<void>) => React.ReactNode;
  notice: (message: string, tone?: ToastTone) => void;
}) {
  const [data, setData] = useState<EventPageData | null>(null),
    [gone, setGone] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [busy, setBusy] = useState(false);
  async function load() {
    if (demo) {
      setGone(true);
      return;
    }
    try {
      setData(await api(`/api/events/${id}`));
      setError("");
    } catch (e) {
      if ((e as { status?: number }).status === 404) setGone(true);
      else setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  if (gone)
    return (
      <section className="closed-profile">
        <span className="event-icon">🎈</span>
        <h3>Мероприятие недоступно</h3>
        <p className="muted">
          {demo
            ? "В демо мероприятия не открываются."
            : "Его отменили, оно уже прошло или вас больше нет среди гостей. Ваши брони остались в «Моих бронях»."}
        </p>
        <button className="button primary" onClick={onEvents}>
          Мои мероприятия
        </button>
      </section>
    );
  if (error)
    return (
      <section className="event-page">
        <button className="text-link" onClick={onBack}>
          <ArrowLeft size={15} /> Назад
        </button>
        <div className="error" role="alert">
          {error}
        </div>
      </section>
    );
  if (!data)
    return (
      <div className="loading" role="status">
        <span />
        Загрузка…
      </div>
    );
  const { event, is_owner: own } = data;
  const taking = own || (!!data.member && !data.member.declined);
  const days = Math.max(0, daysUntil(event.celebrate_on, today));
  async function decline(back: boolean) {
    setBusy(true);
    try {
      await api(`/api/events/${id}/decline`, back ? "DELETE" : "POST");
      notice(back ? "Вы снова участвуете" : "Вы отказались от участия");
      await load();
    } catch (e) {
      notice((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  const free = data.wishes.filter(
    (w) => w.reservation === "available" || w.reservation === "invited",
  );
  return (
    <section className="event-page">
      <button className="text-link" onClick={onBack}>
        <ArrowLeft size={15} /> Назад
      </button>
      <div className="event-head">
        <span className="event-icon">{icons[event.base]}</span>
        <div>
          <h2>{event.title}</h2>
          <p className="muted">
            {own ? "Ваше мероприятие" : `Организатор: ${data.owner.name}`} ·{" "}
            {days ? daysLeft(days) : "сегодня"}
          </p>
          <p className="small-text">
            <Dates e={event} today={today} />
          </p>
          {taking && <p className="small-text">{modeText[event.mode]}</p>}
        </div>
      </div>
      {data.place && <p className="event-description">{data.place}</p>}
      {own && (
        <div className="event-owner-actions">
          <button className="button secondary" onClick={() => setEditing(true)}>
            <Pencil size={15} /> Изменить: дата, место, гости, желания
          </button>
          <button
            className="button secondary danger"
            onClick={() => setCancelling(true)}
          >
            <Trash2 size={15} /> Отменить мероприятие
          </button>
        </div>
      )}
      {data.member && (
        <div className="event-owner-actions">
          {data.member.declined ? (
            <>
              <p className="muted">Вы отказались от участия.</p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void decline(true)}
              >
                Всё-таки участвую
              </button>
            </>
          ) : (
            <button
              className="text-link danger"
              disabled={busy}
              onClick={() => void decline(false)}
            >
              Отказаться от участия
            </button>
          )}
        </div>
      )}
      {taking && (
        <>
          <h3 className="event-subtitle">
            Участники · {data.guests.filter((g) => !g.declined).length + 1}
          </h3>
          <ul className="event-people">
            {[{ ...data.owner, declined: false, host: true }, ...data.guests.map((g) => ({ ...g, host: false }))].map(
              (p) => (
                <li key={p.id}>
                  <span className="event-person">
                    <strong>{p.id === me.id ? "Вы" : p.name}</strong>
                    {p.username && p.id !== me.id && <small> @{p.username}</small>}
                    {p.host && <span className="person-role">организатор</span>}
                    {p.declined && <span className="person-role">отказался(-ась)</span>}
                  </span>
                  {!p.declined && p.id !== me.id && (p.host || event.mode === "everyone") && (
                    <button
                      className="button secondary"
                      onClick={() => onOpenList(p.id, event.title)}
                    >
                      Вишлист <ArrowUpRight size={14} />
                    </button>
                  )}
                </li>
              ),
            )}
          </ul>
          <h3 className="event-subtitle">
            Желания{event.picked ? " · выбраны организатором" : ""}
          </h3>
          {!data.wishes.length ? (
            // «Пока нет желаний»: a gentle nudge to the organizer through the bot.
            <div className="empty">
              <h3>Пока нет желаний</h3>
              {!own && (
                <button
                  className="text-link"
                  onClick={async () => {
                    try {
                      await api(`/api/events/${id}/remind`, "POST");
                      notice("Бот напомнит организатору, не называя вас");
                    } catch (e) {
                      notice((e as Error).message, "error");
                    }
                  }}
                >
                  <BellRing size={15} /> Напомнить
                </button>
              )}
            </div>
          ) : (
            <>
              {!own && !free.length && (
                // Only givers see this; the organizer never sees booking states.
                <p className="muted">Свободных желаний нет: все уже кто-то выбрал.</p>
              )}
              {renderWishes(data.wishes, load)}
            </>
          )}
        </>
      )}
      {!taking && !data.member && (
        <button
          className="button secondary event-open-list"
          onClick={() => onOpenList(data.owner.id)}
        >
          Вишлист: {data.owner.name} <ArrowUpRight size={14} />
        </button>
      )}
      {editing && (
        <EventForm
          me={me}
          event={event}
          people={people}
          initialWishes={data.wish_ids}
          initialGuests={data.guests.map((g) => g.id)}
          initialPlace={data.place}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            notice("Мероприятие сохранено");
            await load();
          }}
        />
      )}
      {cancelling && (
        <Confirm
          title="Отменить мероприятие?"
          text="Участники получат сообщение. Брони останутся у дарителей."
          action="Отменить мероприятие"
          cancel="Не отменять"
          danger
          onCancel={() => setCancelling(false)}
          onConfirm={async () => {
            setCancelling(false);
            try {
              await api(`/api/events/${id}`, "DELETE");
              notice("Мероприятие отменено");
              onEvents();
            } catch (e) {
              notice((e as Error).message, "error");
            }
          }}
        />
      )}
    </section>
  );
}

type EventsData = {
  occasions: UpcomingEvent[];
  mine: EventCard[];
  invited: (EventCard & {
    owner: { id: string; name: string; username: string | null };
    declined: boolean;
  })[];
};

/**
 * «Мероприятия»: my events to manage, the occasions to start one from (they are
 * not events yet: no guests, no invitations), and where I am invited.
 */
export function EventsList({
  today,
  onOpen,
  onCreate,
}: {
  today: Date;
  onOpen: (id: string) => void;
  onCreate: (occasion?: UpcomingEvent) => void;
}) {
  const [data, setData] = useState<EventsData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (demo) {
      setData({
        occasions: upcomingEvents(eventSpecs({}), today),
        mine: [],
        invited: [],
      });
      return;
    }
    api<EventsData>("/api/events")
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data)
    return (
      <div className="loading" role="status">
        <span />
        Загрузка…
      </div>
    );
  const row = (e: EventCard, sub: React.ReactNode, extra?: string) => (
    <li key={e.id} className={extra}>
      <button className="event-row" onClick={() => onOpen(e.id)}>
        <span className="event-icon small">{icons[e.base]}</span>
        <span>
          <strong>{e.title}</strong>
          <small>{sub}</small>
        </span>
        <ChevronRight size={16} />
      </button>
    </li>
  );
  return (
    <section className="events-list">
      <div className="events-list-head">
        <h3 className="event-subtitle">Мои мероприятия</h3>
        <button className="button primary" onClick={() => onCreate()}>
          <CalendarPlus size={16} /> Создать мероприятие
        </button>
      </div>
      {data.mine.length ? (
        <ul className="event-people">
          {data.mine.map((e) =>
            row(
              e,
              <>
                <Dates e={e} today={today} /> ·{" "}
                {e.guests ? `${e.guests} ${guestWord(e.guests)}` : "гостей нет"}
              </>,
              "has-party",
            ),
          )}
        </ul>
      ) : (
        <p className="muted">Пока нет своих мероприятий.</p>
      )}
      <h3 className="event-subtitle">Поводы</h3>
      <p className="small-text">
        Из профиля: это ещё не мероприятия — гостей и приглашений у них нет.
        Нажмите, чтобы создать.
      </p>
      <ul className="event-people">
        {data.occasions.map((o) => (
          <li key={o.key}>
            <button className="event-row" onClick={() => onCreate(o)}>
              <span className="event-icon small">{icons[o.key]}</span>
              <span>
                <strong>{o.title}</strong>
                <small>{when(o.date, today)}</small>
              </span>
              <CalendarPlus size={16} />
            </button>
          </li>
        ))}
        <li>
          <button className="event-row" onClick={() => onCreate()}>
            <span className="event-icon small">🎉</span>
            <span>
              <strong>Другое</strong>
              <small>Новоселье, выпускной — любой повод</small>
            </span>
            <CalendarPlus size={16} />
          </button>
        </li>
      </ul>
      <h3 className="event-subtitle">Меня пригласили</h3>
      {data.invited.length ? (
        <ul className="event-people">
          {data.invited.map((e) =>
            row(
              e,
              <>
                {e.owner.name} · <Dates e={e} today={today} />
                {e.declined ? " · вы отказались" : ""}
              </>,
            ),
          )}
        </ul>
      ) : (
        <p className="muted">Пока никто не пригласил.</p>
      )}
    </section>
  );
}
