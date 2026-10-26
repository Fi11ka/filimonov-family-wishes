import { useState } from "react";
import { Bot, CalendarDays, Heart, Users } from "lucide-react";
import { isGender } from "../shared/events";
import { api, demo, openBot, type Notifications } from "./api";
import { BirthdayGender, birthdayError } from "./friends";
import { type User } from "./types";

/** What the app can do, for someone who came by a link and sees it for the first time. */
export function Features() {
  return (
    <ul className="welcome-features">
      <li>
        <Heart size={18} />
        <span>
          <strong>Свой вишлист.</strong> Желания со ссылками на магазины, ценой
          и фото. Друзья бронируют подарки тайно — сюрприз сохранится.
        </span>
      </li>
      <li>
        <Users size={18} />
        <span>
          <strong>Друзья.</strong> Вишлисты друг друга, общие подарки, когда
          скидываетесь вместе.
        </span>
      </li>
      <li>
        <CalendarDays size={18} />
        <span>
          <strong>Мероприятия.</strong> День рождения и праздники видны друзьям:
          они знают, когда дарить.
        </span>
      </li>
      <li>
        <Bot size={18} />
        <span>
          <strong>Бот в Telegram.</strong> Добавить желание прямо в чате,
          напоминания о днях рождения друзей, заявки и приглашения с кнопками.
        </span>
      </li>
    </ul>
  );
}

/** Shown once after the first sign-in: what is here, and the birthday and gender for the events. */
export function Welcome({
  user,
  sharedName,
  notifications,
  onDone,
}: {
  user: User;
  /** Whose list the person came to look at, if they came by a link. */
  sharedName?: string;
  notifications: Notifications | null;
  onDone: (user?: User) => void;
}) {
  const [day, setDay] = useState(user.birthday?.slice(3) || "");
  const [month, setMonth] = useState(user.birthday?.slice(0, 2) || "");
  const [gender, setGender] = useState<string>(user.gender || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(values: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      if (demo) onDone();
      else
        onDone(
          (await api("/api/me", "PATCH", { ...values, welcomed: true })).user,
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="share-result profile-settings welcome-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        const invalid = birthdayError(day, month);
        if (invalid) {
          setError(invalid);
          return;
        }
        void save({
          birthday: day && month ? `${month}-${day}` : null,
          gender: isGender(gender) ? gender : null,
        });
      }}
    >
      <p>
        {sharedName ? (
          <>
            <strong>{sharedName}</strong> делится с вами вишлистом. Выберите
            подарок и нажмите «Забронировать» — никто не узнает, что это вы.
            А ещё здесь можно вести свой:
          </>
        ) : (
          <>Здесь можно вести свой вишлист и смотреть вишлисты друзей:</>
        )}
      </p>
      <Features />
      <h3>Расскажите о себе</h3>
      <p>
        Тогда в вашем профиле появятся день рождения и праздники, и друзья не
        пропустят, когда дарить. Изменить можно в профиле.
      </p>
      <BirthdayGender
        day={day}
        month={month}
        gender={gender}
        setDay={setDay}
        setMonth={setMonth}
        setGender={setGender}
      />
      {notifications && !notifications.bot_connected && (
        <p className="small-text">
          Чтобы бот напоминал о днях рождения и присылал заявки, откройте его и
          нажмите «Запустить».{" "}
          <button
            type="button"
            className="text-link"
            onClick={() => openBot(notifications.bot_url)}
          >
            Открыть бота
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="button primary full-width" disabled={busy}>
        {busy ? "Сохраняем…" : "Сохранить"}
      </button>
      <button
        type="button"
        className="text-link"
        disabled={busy}
        onClick={() => void save({})}
      >
        Позже
      </button>
    </form>
  );
}
