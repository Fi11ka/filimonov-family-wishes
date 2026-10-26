import React, { useState } from "react";
import { CalendarPlus, Pencil, PartyPopper, Trash2, Users } from "lucide-react";
import {
  eventDay,
  eventSpecs,
  untilText,
  upcomingEvents,
  type UpcomingEvent,
} from "../shared/events";
import { api, demo } from "./api";
import { Modal } from "./forms";
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
  notice,
}: {
  owner: User;
  own: boolean;
  today: Date;
  invitations: Invitation[];
  friends: Friend[];
  onChanged: () => Promise<void>;
  onProfile: () => void;
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
              </span>
              {party && (
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
function InviteDialog({
  events,
  invitations,
  friends,
  onClose,
  onSaved,
}: {
  events: UpcomingEvent[];
  invitations: Invitation[];
  friends: Friend[];
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const partyOf = (e?: UpcomingEvent) =>
    invitations.find((i) => i.key === e?.key && i.date === e?.date);
  const [key, setKey] = useState<string>(events[0]?.key || "");
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
          void api("/api/events/guests", "PUT", {
            key: event.key,
            date: event.date,
            mode,
            friends: picked,
          })
            .then(() =>
              onSaved(
                picked.length
                  ? "Список гостей сохранён, новым гостям ушли приглашения"
                  : "Приглашения отменены",
              ),
            )
            .catch((err) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
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
