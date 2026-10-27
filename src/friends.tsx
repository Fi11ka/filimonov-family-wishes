import { validBirthday } from "../shared/birthday";
import { isGender } from "../shared/events";
import React, { useEffect, useState } from "react";
import { LogOut, Share2 } from "lucide-react";
import { api, demo, openBot, type Notifications } from "./api";
import { AvatarEditor, Face } from "./avatar";
import { type User } from "./types";
const months = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];
/** Birthday and gender: from them the profile gets its events (birthday, 8 March or 23 February). */
export function BirthdayGender({
  day,
  month,
  gender,
  setDay,
  setMonth,
  setGender,
}: {
  day: string;
  month: string;
  gender: string;
  setDay: (v: string) => void;
  setMonth: (v: string) => void;
  setGender: (v: string) => void;
}) {
  return (
    <>
      <fieldset>
        <legend>Дата рождения</legend>
        <div className="birthday-inputs">
          <select
            aria-label="День рождения"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
            <option value="">День</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={String(d).padStart(2, "0")}>
                {d}
              </option>
            ))}
          </select>
          <select
            aria-label="Месяц рождения"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            <option value="">Месяц</option>
            {months.map((m, i) => (
              <option key={m} value={String(i + 1).padStart(2, "0")}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <fieldset>
        <legend>Пол</legend>
        <select
          aria-label="Пол"
          value={gender}
          onChange={(e) => setGender(e.target.value)}
        >
          <option value="">Не указан</option>
          <option value="female">Женский</option>
          <option value="male">Мужской</option>
        </select>
        <p className="small-text">
          Виден только вам. По нему в вишлист добавляется 8 Марта или 23
          Февраля.
        </p>
      </fieldset>
    </>
  );
}
/** The error to show for a half-filled or impossible birthday, or "" when it is fine. */
export function birthdayError(day: string, month: string) {
  if (!!day !== !!month) return "Укажите день и месяц рождения.";
  if (day && month && !validBirthday(`${month}-${day}`))
    return "Укажите существующую дату рождения.";
  return "";
}
/** Open or closed profile: who sees the wishlist besides friends I approved. */
export function Privacy({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (isPrivate: boolean) => void;
}) {
  return (
    <fieldset className="privacy">
      <legend>Кто видит мой вишлист</legend>
      <label className="setting-toggle">
        <input
          type="radio"
          name="privacy"
          checked={value}
          onChange={() => onChange(true)}
        />
        <span>
          <strong>Только те, кого я одобрю</strong>
          <small>
            Остальные видят имя, фото и кнопку «Добавить в друзья»: вишлист
            откроется, когда вы одобрите запрос.
          </small>
        </span>
      </label>
      <label className="setting-toggle">
        <input
          type="radio"
          name="privacy"
          checked={!value}
          onChange={() => onChange(false)}
        />
        <span>
          <strong>Все, у кого есть ссылка</strong>
          <small>
            Добавить вас в друзья можно без одобрения. В ваших друзьях эти люди
            не появятся, пока вы сами их не добавите.
          </small>
        </span>
      </label>
    </fieldset>
  );
}
export function Profile({
  user,
  friends,
  webSession,
  onShare,
  onLogout,
  onUpdated,
}: {
  user: User | null;
  friends: number;
  webSession: boolean;
  onShare: () => void;
  onLogout: (everywhere: boolean) => void;
  onUpdated: (user: User) => void;
}) {
  const [month, setMonth] = useState(user?.birthday?.slice(0, 2) || "");
  const [day, setDay] = useState(user?.birthday?.slice(3) || "");
  const [gender, setGender] = useState<string>(user?.gender || "");
  const [isPrivate, setPrivate] = useState(user?.is_private !== false);
  const [notifications, setNotifications] = useState<Notifications | null>(
    null,
  );
  const [notify, setNotify] = useState(true);
  useEffect(() => {
    if (demo) return;
    api("/api/me")
      .then((me) => {
        setNotifications(me.notifications);
        setNotify(me.notifications.enabled);
      })
      .catch(() => undefined);
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <div className="share-result">
      <AvatarEditor user={user} onUpdated={onUpdated} />
      <h3>{user?.name || "Гость"}</h3>
      <p className="muted">
        {user?.username ? (
          <>
            <strong>@{user.username}</strong>
          </>
        ) : (
          <>Нет ника Telegram</>
        )}
      </p>
      <p className="small-text">
        Друзей: {friends}
      </p>
      <form
        className="profile-settings"
        onChange={() => setSaved(false)}
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setSaved(false);
          const invalid = birthdayError(day, month);
          if (invalid) {
            setError(invalid);
            return;
          }
          setSaving(true);
          try {
            const values = {
              birthday: day && month ? `${month}-${day}` : null,
              gender: isGender(gender) ? gender : null,
              is_private: isPrivate,
              ...(notifications ? { notify } : {}),
            };
            if (demo) {
              onUpdated({ ...user!, ...values });
            } else {
              const result = await api("/api/me", "PATCH", values);
              onUpdated(result.user);
              setNotifications(result.notifications);
            }
            setSaved(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <BirthdayGender
          day={day}
          month={month}
          gender={gender}
          setDay={setDay}
          setMonth={setMonth}
          setGender={setGender}
        />
        <Privacy value={isPrivate} onChange={setPrivate} />
        {user?.is_private !== false && !isPrivate && (
          <p className="small-text">
            Ожидающие запросы будут одобрены автоматически.
          </p>
        )}
        {notifications && (
          <>
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
              />
              Уведомления в Telegram
            </label>
            <p className="small-text">
              Бот напишет о запросах в друзья, а ещё о днях рождения, новых
              желаниях и мероприятиях тех, у кого вы включили колокольчик, о
              приглашениях на мероприятия и скинуться, об удалённых подарках из
              ваших броней.
            </p>
            {notify && !notifications.bot_connected && (
              <p className="small-text">
                Чтобы бот мог писать вам, откройте его и нажмите «Запустить».{" "}
                <button
                  type="button"
                  className="text-link"
                  onClick={() => openBot(notifications.bot_url)}
                >
                  Открыть бота
                </button>
              </p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {saved && <p role="status">Настройки сохранены</p>}
        <button className="button secondary full-width" disabled={saving}>
          {saving ? "Сохраняем…" : "Сохранить настройки"}
        </button>
      </form>
      <button className="button primary full-width" onClick={onShare}>
        <Share2 size={17} /> Поделиться профилем
      </button>
      {webSession ? (
        <div className="profile-logout">
          <button className="button secondary" onClick={() => onLogout(false)}>
            <LogOut size={16} /> Выйти
          </button>
          <button className="text-link danger" onClick={() => onLogout(true)}>
            Выйти на всех устройствах
          </button>
        </div>
      ) : (
        user &&
        !demo && (
          <div className="profile-logout">
            <button className="text-link" onClick={() => onLogout(true)}>
              Завершить входы на сайте на всех устройствах
            </button>
          </div>
        )
      )}
    </div>
  );
}
