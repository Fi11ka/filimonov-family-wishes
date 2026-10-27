import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarPlus,
  ChevronRight,
  Eye,
  Pencil,
  PartyPopper,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  eventDay,
  eventSpecs,
  daysLeft,
  daysUntil,
  untilText,
  upcomingEvents,
  type UpcomingEvent,
} from "../shared/events";
import { api, demo } from "./api";
import { Confirm, Modal } from "./forms";
import type { Friend, Invitation, ToastTone, User } from "./types";
const icons: Record<string, string> = {
  birthday: "🎂",
  new_year: "🎄",
  march8: "💐",
  feb23: "🎖",
  custom: "🎉",
};
const modeText = {
  hero: "Подарки виновнику торжества",
  everyone: "Обмен подарками",
};
/** Events in the wishlist header; the owner adds their own and invites friends. */
export function WishlistEvents({
  owner,
  own,
  today,
  invitations,
  friends,
  onChanged,
  onProfile,
  onOpen,
  notice,
}: {
  owner: User;
  own: boolean;
  today: Date;
  invitations: Invitation[];
  friends: Friend[];
  onChanged: () => Promise<void>;
  onProfile: () => void;
  /** Opens the event page (owner: any event; guests: the ones they are invited to). */
  onOpen?: (e: UpcomingEvent) => void;
  notice: (message: string, tone?: ToastTone) => void;
}) {
  const [dialog, setDialog] = useState<"event" | "invite" | null>(null);
  const events = upcomingEvents(owner.events ?? eventSpecs(owner), today);
  const custom = events.find((e) => e.key === "custom");
  const invited = (e: UpcomingEvent) =>
    invitations.find((i) => i.key === e.key && i.date === e.date);
  // One compact row of chips: each opens the event page, where guests and
  // details live. Events with invited guests stand out and show the count.
  return (
    <div className="wishlist-events">
      <ul className="event-chips">
        {events.map((e) => {
          const party = invited(e);
          const guests = party?.guests.length || 0;
          const label = (
            <>
              <span className="event-chip-icon" aria-hidden="true">
                {icons[e.key]}
              </span>
              <span className="event-chip-text">
                <strong>{e.title}</strong>
                <small>
                  {eventDay(e.date)} · {untilText(e.days)}
                </small>
              </span>
              {guests > 0 && (
                <span
                  className="event-chip-guests"
                  aria-label={`Гостей: ${guests}`}
                  title={`${modeText[party!.mode]} · гостей: ${guests}`}
                >
                  <Users size={13} />
                  {guests}
                </span>
              )}
            </>
          );
          return (
            <li key={e.key} className={guests ? "has-party" : undefined}>
              {onOpen ? (
                <button className="event-chip" onClick={() => onOpen(e)}>
                  {label}
                  <ChevronRight size={14} className="event-chip-arrow" />
                </button>
              ) : (
                <span className="event-chip">{label}</span>
              )}
              {own && e.key === "custom" && (
                <button
                  className="icon-button event-edit"
                  aria-label="Изменить мероприятие"
                  title="Изменить мероприятие"
                  onClick={() => setDialog("event")}
                >
                  <Pencil size={14} />
                </button>
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
        {own && !custom && (
          <li>
            <button
              className="event-chip add"
              onClick={() => setDialog("event")}
            >
              <CalendarPlus size={15} /> Мероприятие
            </button>
          </li>
        )}
        {own && (
          <li>
            <button
              className="event-chip add"
              onClick={() => setDialog("invite")}
            >
              <PartyPopper size={15} /> Пригласить
            </button>
          </li>
        )}
      </ul>
      {dialog === "event" && (
        <EventDialog
          current={custom}
          onClose={() => setDialog(null)}
          onSaved={async (message) => {
            setDialog(null);
            notice(message);
            await onChanged();
          }}
        />
      )}
      {dialog === "invite" && (
        <InviteDialog
          events={events}
          invitations={invitations}
          friends={friends}
          onClose={() => setDialog(null)}
          onSaved={async (message) => {
            setDialog(null);
            notice(message);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function EventDialog({
  current,
  onClose,
  onSaved,
}: {
  current?: UpcomingEvent;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(current?.title || ""),
    [date, setDate] = useState(current?.date || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    if (demo) {
      setError("В демо мероприятия не сохраняются.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={current ? "Мероприятие" : "Добавить мероприятие"}
      onClose={() => !busy && onClose()}
    >
      <form
        className="share-result"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/events/custom", "PUT", { title, date });
            await onSaved(
              current ? "Мероприятие сохранено" : "Мероприятие добавлено",
            );
          });
        }}
      >
        <label>
          Название
          <input
            autoFocus
            required
            maxLength={80}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Например: новоселье"
          />
        </label>
        <label>
          Дата
          <input
            type="date"
            required
            min={isoDay(new Date())}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <p className="small-text">
          Своё мероприятие может быть одно: новое заменит прежнее. Друзья с
          включёнными уведомлениями получат сообщение в Telegram.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary full-width"
          disabled={busy || !title.trim() || !date}
        >
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
        {current && (
          <button
            type="button"
            className="text-link danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api("/api/events/custom", "DELETE");
                await onSaved("Мероприятие удалено");
              })
            }
          >
            <Trash2 size={14} /> Удалить мероприятие
          </button>
        )}
      </form>
    </Modal>
  );
}
export function InviteDialog({
  events,
  initialKey,
  invitations,
  friends,
  onClose,
  onSaved,
}: {
  events: UpcomingEvent[];
  initialKey?: string;
  invitations: Invitation[];
  friends: Friend[];
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const partyOf = (e?: UpcomingEvent) =>
    invitations.find((i) => i.key === e?.key && i.date === e?.date);
  const [key, setKey] = useState<string>(initialKey || events[0]?.key || "");
  const event = events.find((e) => e.key === key);
  const [mode, setMode] = useState(partyOf(event)?.mode || "hero");
  const [picked, setPicked] = useState<string[]>(
    partyOf(event)?.guests.map((g) => g.id) || [],
  );
  // People who are not friends are added by their Telegram username.
  const [usernames, setUsernames] = useState<string[]>([]),
    [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Friends plus guests invited earlier by username.
  const people = [
    ...friends,
    ...(partyOf(event)?.guests || []).filter(
      (g) => !friends.some((f) => f.id === g.id),
    ),
  ];
  function addNick() {
    const v = nick.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z][a-z0-9_]{3,31}$/.test(v)) {
      setError("Введите ник Telegram, например @anna_filimonova.");
      return;
    }
    setError("");
    const friend = people.find((p) => p.username?.toLowerCase() === v);
    if (friend) {
      if (!picked.includes(friend.id)) setPicked([...picked, friend.id]);
    } else if (!usernames.includes(v)) setUsernames([...usernames, v]);
    setNick("");
  }
  function choose(next: string) {
    setKey(next);
    const party = partyOf(events.find((e) => e.key === next));
    setMode(party?.mode || "hero");
    setPicked(party?.guests.map((g) => g.id) || []);
  }
  return (
    <Modal title="Пригласить на мероприятие" onClose={() => !busy && onClose()}>
      <form
        className="share-result"
        onSubmit={(e) => {
          e.preventDefault();
          if (!event) return;
          if (demo) {
            setError("В демо приглашения не отправляются.");
            return;
          }
          setBusy(true);
          setError("");
          void api("/api/events/party", "PUT", {
            key: event.key,
            date: event.date,
            mode,
            friends: picked,
            usernames,
          })
            .then(() =>
              onSaved(
                picked.length || usernames.length
                  ? "Список гостей сохранён, новым гостям ушли приглашения"
                  : "Список гостей пуст",
              ),
            )
            .catch((err) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <label hidden={!!initialKey}>
          Мероприятие
          <select value={key} onChange={(e) => choose(e.target.value)}>
            {events.map((e) => (
              <option key={e.key} value={e.key}>
                {e.title} · {eventDay(e.date)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="event-mode">
          <legend>Для кого праздник</legend>
          {(["hero", "everyone"] as const).map((m) => (
            <label key={m} className="setting-toggle">
              <input
                type="radio"
                name="mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <span>
                {modeText[m]}
                <small>
                  {m === "hero"
                    ? "Гости видят, кто из них что забронировал, только в вашем вишлисте."
                    : "Вы и гости видите, кто из участников что забронировал, в вишлистах друг друга."}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="small-text">
          Гости увидят, кто ещё приглашён. Кто и что забронировал в своём
          вишлисте, не видит никто — и вы тоже.
        </p>
        {people.length ? (
          <div className="friend-picker">
            {people.map((f) => (
              <label key={f.id} className="setting-toggle">
                <input
                  type="checkbox"
                  checked={picked.includes(f.id)}
                  disabled={busy}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked
                        ? [...picked, f.id]
                        : picked.filter((id) => id !== f.id),
                    )
                  }
                />
                {f.name}
                {f.username ? ` · @${f.username}` : ""}
              </label>
            ))}
          </div>
        ) : (
          <p className="small-text">
            <Users size={14} /> Пока некого выбрать: здесь будут ваши
            друзья и те, кто добавил вас в друзья. Остальных можно позвать по
            нику Telegram.
          </p>
        )}
        <div className="invite-nick">
          <input
            aria-label="Ник Telegram"
            placeholder="@ник в Telegram"
            value={nick}
            disabled={busy}
            onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addNick();
              }
            }}
          />
          <button
            type="button"
            className="button secondary"
            disabled={busy || !nick.trim()}
            onClick={addNick}
          >
            <UserPlus size={15} /> Добавить
          </button>
        </div>
        {usernames.length > 0 && (
          <ul className="invite-nicks">
            {usernames.map((u) => (
              <li key={u}>
                @{u}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Убрать @${u}`}
                  onClick={() => setUsernames(usernames.filter((x) => x !== u))}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="small-text">
          По нику можно позвать и тех, кого нет в ваших друзьях: человек
          должен хотя бы раз открыть приложение. Гости видят вишлист виновника
          торжества.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full-width" disabled={busy || !event}>
          {busy ? "Сохраняем…" : "Сохранить приглашения"}
        </button>
      </form>
    </Modal>
  );
}
type EventPageData = {
  owner: { id: string; name: string; username: string | null };
  event: UpcomingEvent;
  mode: "hero" | "everyone";
  description: string;
  guests: { id: string; name: string; username: string | null }[];
  is_owner: boolean;
  /** Guests and the description are shown only to the owner and the guests. */
  invited?: boolean;
};
/** Who is invited and what the party is about; the owner edits it here. */
export function EventPage({
  owner,
  eventKey,
  date,
  me,
  friends,
  today,
  onBack,
  onOpenList,
  notice,
}: {
  owner: string;
  eventKey: string;
  date: string;
  me: string;
  friends: Friend[];
  today: Date;
  onBack: () => void;
  /** `named`: the event whose guests' bookings are named in that list. */
  onOpenList: (id: string, named?: string) => void;
  notice: (message: string, tone?: ToastTone) => void;
}) {
  const [data, setData] = useState<EventPageData | null>(null),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<"guests" | "cancel" | null>(null),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    if (demo) {
      // The demo shows a party for everyone with two of the demo friends.
      setData({
        owner: { id: me, name: "Анастасия Филимонова", username: "nastya_f" },
        event: {
          key: eventKey as UpcomingEvent["key"],
          title: eventKey === "new_year" ? "Новый год" : "Праздник",
          date,
          days: daysUntil(date, today),
        },
        mode: "everyone",
        description:
          "Встречаемся у нас дома в 19:00. Дресс-код — что-нибудь блестящее ✨",
        guests: friends.slice(0, 2).map(({ id, name, username }) => ({
          id,
          name,
          username: username ?? null,
        })),
        is_owner: owner === me,
        invited: owner !== me,
      });
      return;
    }
    try {
      setData(await api(`/api/events/${owner}/${eventKey}/${date}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [owner, eventKey, date]);
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
  const days = Math.max(0, daysUntil(event.date, today));
  const people = [
    { ...data.owner, host: true },
    ...data.guests.map((g) => ({ ...g, host: false })),
  ];
  // In «праздник для всех» every list shows who of the party booked; in the
  // hero's case only the hero's list does. Nobody sees it in their own list.
  const named = (id: string) =>
    id !== me && (data.mode === "everyone" || id === data.owner.id);
  async function saveText() {
    setBusy(true);
    try {
      await api("/api/events/party", "PUT", {
        key: event.key,
        date: event.date,
        description: text,
      });
      setEditing(false);
      await load();
    } catch (e) {
      notice((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="event-page">
      <button className="text-link" onClick={onBack}>
        <ArrowLeft size={15} /> Назад
      </button>
      <div className="event-head">
        <span className="event-icon">{icons[event.key]}</span>
        <div>
          <h2>{event.title}</h2>
          <p className="muted">
            {own ? "Ваш праздник" : `Праздник: ${data.owner.name}`} ·{" "}
            {eventDay(event.date)} · {days ? daysLeft(days) : "сегодня"}
          </p>
          {data.guests.length > 0 && (
            <p className="small-text">
              {modeText[data.mode]}:{" "}
              {data.mode === "everyone"
                ? "участники видят, кто из них что забронировал, в вишлистах друг друга"
                : `гости видят, кто из них что забронировал, в вишлисте ${own ? "виновника торжества" : data.owner.name}`}
              . Брони людей не из числа гостей показываются без имени, а в
              своём вишлисте никто не видит, кто что дарит.
            </p>
          )}
        </div>
      </div>
      {editing ? (
        <div className="about-form">
          <textarea
            autoFocus
            rows={4}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Описание мероприятия"
            placeholder="Где и когда собираемся, дресс-код, что взять с собой"
          />
          <div className="about-actions">
            <span className="small-text">{text.length}/1000</span>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void saveText()}
            >
              {busy ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </div>
      ) : data.description ? (
        <p className="event-description">
          {data.description}
          {own && (
            <button
              className="icon-button about-edit"
              aria-label="Изменить описание"
              onClick={() => {
                setText(data.description);
                setEditing(true);
              }}
            >
              <Pencil size={14} />
            </button>
          )}
        </p>
      ) : own ? (
        <button
          className="text-link"
          onClick={() => {
            setText("");
            setEditing(true);
          }}
        >
          <Pencil size={14} /> Добавить описание: место, время, дресс-код
        </button>
      ) : null}
      <h3 className="event-subtitle" hidden={!own && !data.invited}>
        Участники{data.guests.length ? ` · ${data.guests.length + 1}` : ""}
      </h3>
      {!own && !data.invited ? (
        <>
          <p className="muted">
            Описание и список гостей видят только приглашённые.
          </p>
          <button
            className="button secondary event-open-list"
            onClick={() => onOpenList(data.owner.id, undefined)}
          >
            Вишлист: {data.owner.name} <ArrowUpRight size={14} />
          </button>
        </>
      ) : data.guests.length ? (
        <ul className="event-people">
          {people.map((p) => (
            <li key={p.id}>
              <span className="event-person">
                <strong>{p.id === me ? "Вы" : p.name}</strong>
                {p.username && p.id !== me && <small> @{p.username}</small>}
                {p.host && (
                  <span className="person-role">
                    {data.mode === "everyone"
                      ? "организатор"
                      : "виновник торжества"}
                  </span>
                )}
                {named(p.id) && (
                  <small className="person-names">
                    <Eye size={13} /> В вишлисте видно, кто из гостей что
                    дарит
                  </small>
                )}
              </span>
              {(p.id === me || data.mode === "everyone" || p.host) && (
                <button
                  className="button secondary"
                  onClick={() =>
                    onOpenList(p.id, named(p.id) ? event.title : undefined)
                  }
                >
                  {p.id === me ? "Мой вишлист" : "Вишлист"}
                  <ArrowUpRight size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {own ? "Пока никто не приглашён." : "Список гостей пуст."}
        </p>
      )}
      {own && (
        <div className="event-owner-actions">
          <button
            className="button primary"
            onClick={() => setDialog("guests")}
          >
            <Users size={16} />
            {data.guests.length
              ? "Изменить список гостей"
              : "Пригласить друзей"}
          </button>
          {data.guests.length > 0 && (
            <button
              className="text-link danger"
              onClick={() => setDialog("cancel")}
            >
              Отменить праздник
            </button>
          )}
        </div>
      )}
      {dialog === "guests" && (
        <InviteDialog
          events={[event]}
          initialKey={event.key}
          invitations={
            data.guests.length || data.description
              ? [
                  {
                    key: event.key,
                    date: event.date,
                    title: event.title,
                    mode: data.mode,
                    guests: data.guests,
                  },
                ]
              : []
          }
          friends={friends}
          onClose={() => setDialog(null)}
          onSaved={async (message) => {
            setDialog(null);
            notice(message);
            await load();
          }}
        />
      )}
      {dialog === "cancel" && (
        <Confirm
          title="Отменить праздник?"
          text="Приглашения отменятся, гостям придёт сообщение в Telegram. Само мероприятие и описание останутся — пригласить можно будет снова."
          action="Отменить праздник"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            if (demo) return;
            void api("/api/events/cancel", "POST", {
              key: event.key,
              date: event.date,
            })
              .then(async () => {
                notice("Праздник отменён, гостям ушло сообщение");
                await load();
              })
              .catch((e) => notice((e as Error).message, "error"));
          }}
        />
      )}
    </section>
  );
}
type EventsData = {
  mine: {
    event: UpcomingEvent;
    mode: "hero" | "everyone" | null;
    guests: number;
  }[];
  invited: {
    owner: { id: string; name: string; username: string | null };
    event: UpcomingEvent;
    mode: "hero" | "everyone";
  }[];
};
const guestWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? "гость"
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? "гостя"
      : "гостей";
/** «Мероприятия»: parties one is invited to and one's own upcoming events. */
export function EventsList({
  me,
  today,
  onOpen,
}: {
  me: string;
  today: Date;
  onOpen: (owner: string, key: string, date: string) => void;
}) {
  const [data, setData] = useState<EventsData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (demo) {
      setData({
        mine: upcomingEvents(eventSpecs({}), today).map((event) => ({
          event,
          mode: null,
          guests: 0,
        })),
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
  const left = (e: UpcomingEvent) => {
    const d = Math.max(0, daysUntil(e.date, today));
    return d ? daysLeft(d) : "сегодня";
  };
  return (
    <section className="events-list">
      <h3 className="event-subtitle">Меня пригласили</h3>
      {data.invited.length ? (
        <ul className="event-people">
          {data.invited.map((p) => (
            <li key={`${p.owner.id}:${p.event.key}:${p.event.date}`}>
              <button
                className="event-row"
                onClick={() => onOpen(p.owner.id, p.event.key, p.event.date)}
              >
                <span className="event-icon small">{icons[p.event.key]}</span>
                <span>
                  <strong>{p.event.title}</strong> · {p.owner.name}
                  <small>
                    {eventDay(p.event.date)} · {left(p.event)} ·{" "}
                    {modeText[p.mode]}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Пока никто не пригласил.</p>
      )}
      <h3 className="event-subtitle">Мои мероприятия</h3>
      <ul className="event-people">
        {data.mine.map((m) => (
          <li
            key={m.event.key}
            className={m.guests ? "has-party" : undefined}
          >
            <button
              className="event-row"
              onClick={() => onOpen(me, m.event.key, m.event.date)}
            >
              <span className="event-icon small">{icons[m.event.key]}</span>
              <span>
                <strong>{m.event.title}</strong>
                <small>
                  {eventDay(m.event.date)} · {left(m.event)} ·{" "}
                  {m.guests
                    ? `${m.guests} ${guestWord(m.guests)} · ${modeText[m.mode || "hero"]}`
                    : "гостей нет"}
                </small>
              </span>
              <ChevronRight size={16} />
            </button>
          </li>
        ))}
      </ul>
      <p className="small-text">
        Своё мероприятие и день рождения добавляются в шапке «Моего вишлиста».
      </p>
    </section>
  );
}
