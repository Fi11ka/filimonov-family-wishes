import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarPlus,
  ChevronRight,
  Pencil,
  PartyPopper,
  Trash2,
  Users,
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
import type { Friend, Invitation, User } from "./types";
const icons: Record<string, string> = {
  birthday: "🎂",
  new_year: "🎄",
  march8: "💐",
  feb23: "🎖",
  custom: "🎉",
};
const modeText = {
  hero: "Виновник торжества",
  everyone: "Праздник для всех",
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
  onOpen: (e: UpcomingEvent) => void;
  notice: (message: string) => void;
}) {
  const [dialog, setDialog] = useState<"event" | "invite" | null>(null);
  const events = upcomingEvents(owner.events ?? eventSpecs(owner), today);
  const custom = events.find((e) => e.key === "custom");
  const invited = (e: UpcomingEvent) =>
    invitations.find((i) => i.key === e.key && i.date === e.date);
  return (
    <div className="wishlist-events">
      <ul>
        {events.map((e) => {
          const party = invited(e);
          return (
            <li key={e.key}>
              <span>
                {icons[e.key]} <strong>{e.title}</strong> · {eventDay(e.date)} ·{" "}
                {untilText(e.days)}
                {own && e.key === "custom" && (
                  <button
                    className="icon-button event-edit"
                    aria-label="Изменить мероприятие"
                    onClick={() => setDialog("event")}
                  >
                    <Pencil size={13} />
                  </button>
                )}
                {(own || party) && (
                  <button
                    className="text-link event-more"
                    onClick={() => onOpen(e)}
                  >
                    Подробнее <ChevronRight size={13} />
                  </button>
                )}
              </span>
              {!!party?.guests.length && (
                <small>
                  {modeText[party.mode]} · приглашены:{" "}
                  {party.guests.map((g) => g.name).join(", ")}
                </small>
              )}
            </li>
          );
        })}
      </ul>
      {own && (
        <div className="event-actions">
          {!owner.birthday && (
            <button className="text-link" onClick={onProfile}>
              Указать дату рождения
            </button>
          )}
          {!custom && (
            <button className="text-link" onClick={() => setDialog("event")}>
              <CalendarPlus size={15} /> Добавить мероприятие
            </button>
          )}
          <button className="text-link" onClick={() => setDialog("invite")}>
            <PartyPopper size={15} /> Пригласить на мероприятие
          </button>
        </div>
      )}
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
          Своё мероприятие может быть одно: новое заменит прежнее. Подписчики
          получат сообщение в Telegram.
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
          })
            .then(() =>
              onSaved(
                picked.length
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
        {friends.length ? (
          <div className="friend-picker">
            {friends.map((f) => (
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
            <Users size={14} /> Пока некого позвать: добавьте друзей во вкладке
            «Друзья».
          </p>
        )}
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
  onOpenList: (id: string) => void;
  notice: (message: string) => void;
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
      notice((e as Error).message);
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
                : `гости видят, кто из них что забронировал, в вишлисте ${own ? "виновника" : data.owner.name}`}
              . В своём вишлисте этого не видит никто.
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
      <h3 className="event-subtitle">
        Участники{data.guests.length ? ` · ${data.guests.length + 1}` : ""}
      </h3>
      {data.guests.length ? (
        <ul className="event-people">
          {people.map((p) => (
            <li key={p.id}>
              <span>
                <strong>{p.id === me ? "Вы" : p.name}</strong>
                {p.username && p.id !== me && <small> @{p.username}</small>}
                {p.host && <small> · виновник торжества</small>}
              </span>
              {(p.id === me || data.mode === "everyone" || p.host) && (
                <button
                  className="button secondary"
                  onClick={() => onOpenList(p.id)}
                >
                  {p.id === me ? "Мой вишлист" : "Вишлист"}
                  {named(p.id) && " · с именами"}
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
              .catch((e) => notice((e as Error).message));
          }}
        />
      )}
    </section>
  );
}
