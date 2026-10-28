import { isGender } from "../shared/events";
import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  Bell,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Link,
  Lock,
  LogOut,
  MessageCircle,
  Share2,
  Type,
} from "lucide-react";
import { api, demo, openBot, type Notifications } from "./api";
import { AvatarEditor, Face } from "./avatar";
import { LinkSettings } from "./forms";
import { BirthdayGender, Privacy, birthdayError } from "./friends";
import { BOT } from "./telegram-links";
import { type User } from "./types";

export type SettingsSection =
  | "profile"
  | "privacy"
  | "links"
  | "notifications"
  | "appearance"
  | "data"
  | "help";

const titles: Record<SettingsSection, string> = {
  profile: "Профиль",
  privacy: "Приватность",
  links: "Гостевые ссылки",
  notifications: "Уведомления",
  appearance: "Внешний вид",
  data: "Мои данные",
  help: "Помощь",
};

/** Phones show the list of sections or one section; wider screens show both side by side. */
const narrowQuery = "(max-width: 740px)";
function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(narrowQuery).matches);
  useEffect(() => {
    const m = matchMedia(narrowQuery);
    const update = () => setNarrow(m.matches);
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, []);
  return narrow;
}

type SaveState = "" | "saving" | "saved";

/**
 * «Настройки»: the former profile window split into sections, as on the
 * mock-up. Every change is saved at once; what the server cannot do yet is
 * shown greyed out with «Скоро».
 */
export function Settings({
  user,
  friends,
  webSession,
  initial,
  onUpdated,
  onShare,
  onArchive,
  onLogout,
}: {
  user: User;
  friends: number;
  webSession: boolean;
  initial: SettingsSection | null;
  onUpdated: (user: User) => void;
  onShare: () => void;
  onArchive: () => void;
  onLogout: (everywhere: boolean) => void;
}) {
  const narrow = useNarrow();
  const [picked, setPicked] = useState<SettingsSection | null>(initial);
  // On a wide screen some section is always open.
  const section = picked ?? (narrow ? null : "profile");
  const [notifications, setNotifications] = useState<Notifications | null>(
    null,
  );
  const [saveState, setSaveState] = useState<SaveState>("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) return;
    api("/api/me")
      .then((me) => setNotifications(me.notifications))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    setSaveState("");
    setError("");
  }, [section]);
  async function save(values: Partial<User> & { notify?: boolean }) {
    setError("");
    setSaveState("saving");
    try {
      if (demo) onUpdated({ ...user, ...values });
      else {
        const result = await api("/api/me", "PATCH", values);
        onUpdated(result.user);
        setNotifications(result.notifications);
      }
      setSaveState("saved");
    } catch (e) {
      setError((e as Error).message);
      setSaveState("");
    }
  }
  const row = (
    key: SettingsSection,
    Icon: typeof Lock,
    tone: string,
    hint: string,
  ) => (
    <button
      type="button"
      className={`settings-row ${section === key ? "active" : ""}`}
      aria-current={section === key ? "page" : undefined}
      onClick={() => setPicked(key)}
    >
      <span className={`settings-icon ${tone}`}>
        <Icon size={18} />
      </span>
      <span className="settings-row-text">
        <strong>{titles[key]}</strong>
        <small>{hint}</small>
      </span>
      <ChevronRight size={18} className="settings-chevron" />
    </button>
  );
  return (
    <section className={`settings ${section ? "has-section" : ""}`}>
      <nav className="settings-nav" aria-label="Разделы настроек">
        <button
          type="button"
          className={`settings-me ${section === "profile" ? "active" : ""}`}
          onClick={() => setPicked("profile")}
        >
          <span className="avatar">
            <Face user={user} />
          </span>
          <span className="settings-row-text">
            <strong>{user.name}</strong>
            <small>
              {user.username ? `@${user.username} · ` : ""}Фото, день рождения,
              пол
            </small>
          </span>
          <ChevronRight size={18} className="settings-chevron" />
        </button>
        <h3>Аккаунт</h3>
        <div className="settings-group">
          {row(
            "privacy",
            Lock,
            "purple",
            user.is_private === false
              ? "Все, у кого есть ссылка"
              : "Только одобренные друзья",
          )}
          {row("links", Link, "purple", "Открыть вишлист без входа")}
        </div>
        <h3>Приложение</h3>
        <div className="settings-group">
          {row(
            "notifications",
            Bell,
            "orange",
            notifications
              ? notifications.enabled
                ? "Включены"
                : "Выключены"
              : "Сообщения от бота",
          )}
          {row("appearance", Type, "blue", "Размер текста и тема")}
        </div>
        <h3>Данные и помощь</h3>
        <div className="settings-group">
          {row("data", Download, "green", "Скачать вишлист, архив")}
          {row("help", CircleHelp, "grey", "Вопросы, бот, связаться с нами")}
        </div>
        {webSession ? (
          <div className="settings-logout">
            <button
              type="button"
              className="button secondary"
              onClick={() => onLogout(false)}
            >
              <LogOut size={16} /> Выйти
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => onLogout(true)}
            >
              Выйти на всех устройствах
            </button>
          </div>
        ) : (
          !demo && (
            <div className="settings-logout">
              <button
                type="button"
                className="text-link"
                onClick={() => onLogout(true)}
              >
                Завершить входы на сайте на всех устройствах
              </button>
            </div>
          )
        )}
      </nav>
      {section && (
        <div className="settings-panel">
          <button
            type="button"
            className="text-link settings-back"
            onClick={() => setPicked(null)}
          >
            <ChevronLeft size={18} /> Настройки
          </button>
          <div className="settings-panel-head">
            <h2>{titles[section]}</h2>
            {saveState && (
              <span className="settings-saved" role="status">
                {saveState === "saving" ? "Сохраняем…" : "Сохранено"}
              </span>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {section === "profile" && (
            <ProfileSection
              user={user}
              friends={friends}
              onUpdated={onUpdated}
              onShare={onShare}
              save={save}
            />
          )}
          {section === "privacy" && (
            <PrivacySection
              user={user}
              save={save}
              onLinks={() => setPicked("links")}
            />
          )}
          {section === "links" && <LinksSection onShare={onShare} />}
          {section === "notifications" && (
            <NotificationsSection notifications={notifications} save={save} />
          )}
          {section === "appearance" && <AppearanceSection />}
          {section === "data" && <DataSection onArchive={onArchive} />}
          {section === "help" && <HelpSection />}
        </div>
      )}
    </section>
  );
}

function Soon() {
  return <span className="soon">Скоро</span>;
}

function ProfileSection({
  user,
  friends,
  onUpdated,
  onShare,
  save,
}: {
  user: User;
  friends: number;
  onUpdated: (user: User) => void;
  onShare: () => void;
  save: (values: Partial<User>) => Promise<void>;
}) {
  const [month, setMonth] = useState(user.birthday?.slice(0, 2) || "");
  const [day, setDay] = useState(user.birthday?.slice(3) || "");
  const [gender, setGender] = useState(user.gender || "");
  const invalid = birthdayError(day, month);
  // Saved once both the day and the month are chosen (or both cleared).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (invalid) return;
    const birthday = day && month ? `${month}-${day}` : null;
    if (birthday !== (user.birthday || null)) void save({ birthday });
  }, [day, month]);
  return (
    <div className="settings-body">
      <div className="settings-card settings-identity">
        <AvatarEditor user={user} onUpdated={onUpdated} />
        <div>
          <strong>{user.name}</strong>
          <p className="muted">
            {user.username ? `@${user.username}` : "Нет ника Telegram"} ·
            друзей: {friends}
          </p>
          <p className="small-text">
            Имя и ник берутся из Telegram и обновляются при входе.
          </p>
        </div>
      </div>
      <div className="settings-card">
        <BirthdayGender
          day={day}
          month={month}
          gender={gender}
          setDay={setDay}
          setMonth={setMonth}
          setGender={(value) => {
            setGender(value);
            void save({ gender: isGender(value) ? value : null });
          }}
        />
        {invalid && day && month ? (
          <p className="error">{invalid}</p>
        ) : (
          invalid && <p className="small-text">{invalid}</p>
        )}
      </div>
      <button type="button" className="button primary" onClick={onShare}>
        <Share2 size={17} /> Поделиться профилем
      </button>
    </div>
  );
}

function PrivacySection({
  user,
  save,
  onLinks,
}: {
  user: User;
  save: (values: Partial<User>) => Promise<void>;
  onLinks: () => void;
}) {
  const isPrivate = user.is_private !== false;
  return (
    <div className="settings-body">
      <div className="settings-card">
        <Privacy
          value={isPrivate}
          onChange={(value) => {
            if (value !== isPrivate) void save({ is_private: value });
          }}
        />
      </div>
      {isPrivate && (
        <p className="settings-note">
          Если выбрать «Все, у кого есть ссылка», ожидающие запросы в друзья
          одобрятся сами.
        </p>
      )}
      <div className="settings-card">
        <h3>Всегда видно</h3>
        <p className="settings-check">
          Свои брони вы не видите — подарки останутся сюрпризом.
        </p>
        <p className="settings-check">
          Имя дарителя видят только участники праздника, остальные — «Занято».
        </p>
      </div>
      <button type="button" className="settings-row" onClick={onLinks}>
        <span className="settings-row-text">
          <strong>Гостевые ссылки</strong>
          <small>Открыть вишлист без входа</small>
        </span>
        <ChevronRight size={18} className="settings-chevron" />
      </button>
    </div>
  );
}

function LinksSection({ onShare }: { onShare: () => void }) {
  return (
    <div className="settings-body">
      <p className="muted">
        Ссылка без входа открывает вишлист тем, у кого нет Telegram. По ней
        можно выбрать подарок, просто указав имя. Отзыв ссылки не снимает брони,
        которые по ней уже сделали.
      </p>
      <div className="settings-card">
        {demo ? (
          <p className="small-text">В демо ссылки не создаются.</p>
        ) : (
          <LinkSettings />
        )}
      </div>
      <button type="button" className="button primary" onClick={onShare}>
        <Share2 size={17} /> Новая ссылка без входа
      </button>
    </div>
  );
}

const notificationKinds = [
  ["Запросы в друзья", "Кто-то хочет видеть ваш вишлист"],
  ["Дни рождения друзей", "Заранее, чтобы успеть выбрать подарок"],
  ["Новые мероприятия друзей", "Друг создал праздник"],
  ["Приглашения", "На мероприятие или скинуться на подарок"],
  ["Изменения в моих бронях", "Подарок удалили или изменили"],
];

function NotificationsSection({
  notifications,
  save,
}: {
  notifications: Notifications | null;
  save: (values: { notify: boolean }) => Promise<void>;
}) {
  if (demo) return <p className="muted">В демо уведомления не приходят.</p>;
  if (!notifications)
    return (
      <div className="loading" role="status">
        <span />
        Загрузка…
      </div>
    );
  return (
    <div className="settings-body">
      {notifications.bot_connected ? (
        <p className="settings-note ok">
          Бот запущен — сообщения приходят вам в Telegram.
        </p>
      ) : (
        <p className="settings-note">
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
      <div className="settings-card">
        <label className="settings-switch">
          <span>
            <strong>Уведомления в Telegram</strong>
            <small>Главный переключатель: выключает все сообщения сразу</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={notifications.enabled}
            onChange={(e) => void save({ notify: e.target.checked })}
          />
        </label>
      </div>
      <h3>
        О чём писать <Soon />
      </h3>
      <div className="settings-card">
        {notificationKinds.map(([title, hint]) => (
          <label className="settings-switch" key={title}>
            <span>
              <strong>{title}</strong>
              <small>{hint}</small>
            </span>
            <input type="checkbox" role="switch" checked disabled readOnly />
          </label>
        ))}
      </div>
    </div>
  );
}

function AppearanceSection() {
  return (
    <div className="settings-body">
      <h3>
        Размер текста <Soon />
      </h3>
      <div className="settings-card">
        <div className="segmented" role="radiogroup" aria-label="Размер текста">
          <button
            type="button"
            role="radio"
            aria-checked
            className="selected"
            disabled
          >
            Обычный
          </button>
          <button type="button" role="radio" aria-checked={false} disabled>
            Крупный
          </button>
        </div>
        <p className="small-text">
          Крупный текст увеличит шрифт и кнопки во всём приложении.
        </p>
      </div>
      <h3>
        Тема <Soon />
      </h3>
      <div className="settings-card">
        {["Как в системе", "Светлая", "Тёмная"].map((name) => (
          <label className="settings-radio" key={name}>
            <input
              type="radio"
              name="theme"
              checked={name === "Светлая"}
              disabled
              readOnly
            />
            {name}
          </label>
        ))}
      </div>
    </div>
  );
}

function DataSection({ onArchive }: { onArchive: () => void }) {
  return (
    <div className="settings-body">
      <div className="settings-card">
        <h3>
          Скачать вишлист <Soon />
        </h3>
        <p className="small-text">
          Excel-файл со всеми желаниями: название, цена, ссылка и комментарий.
          Брони друзей в файл не попадают.
        </p>
        <button type="button" className="button secondary" disabled>
          <Download size={16} /> Скачать Excel
        </button>
      </div>
      <button type="button" className="settings-row" onClick={onArchive}>
        <span className="settings-icon grey">
          <Archive size={18} />
        </span>
        <span className="settings-row-text">
          <strong>Архив желаний</strong>
          <small>Купленные, подаренные и ненужные</small>
        </span>
        <ChevronRight size={18} className="settings-chevron" />
      </button>
      <div className="settings-card danger">
        <h3>
          Удалить аккаунт <Soon />
        </h3>
        <p className="small-text">
          Навсегда удалит ваш вишлист, архив, друзей, мероприятия и ссылки.
        </p>
        <button type="button" className="button secondary" disabled>
          Удалить аккаунт…
        </button>
      </div>
    </div>
  );
}

const questions = [
  [
    "Как выбрать подарок другу?",
    "Откройте вишлист друга и нажмите «Подарю» у желания. Остальные увидят, что оно занято, и не купят то же самое.",
  ],
  [
    "Узнает ли друг, что я выбрал подарок?",
    "Нет. Владелец вишлиста не видит, какие его желания уже выбраны и кем.",
  ],
  [
    "Как добавить друга?",
    "Нажмите «Поделиться профилем» и отправьте ссылку. Когда человек попросится в друзья, одобрите запрос во вкладке «Друзья».",
  ],
  [
    "Что такое ссылка без входа?",
    "Она открывает вишлист тем, у кого нет Telegram. Подарок по ней выбирают, просто указав имя.",
  ],
  [
    "Как добавить сразу много желаний?",
    "В «Моём вишлисте» нажмите «Добавить много»: подойдёт Google Таблица, файл, корзина WB или Ozon либо просто текст.",
  ],
];

function HelpSection() {
  return (
    <div className="settings-body">
      <h3>Как пользоваться</h3>
      <div className="settings-card settings-faq">
        {questions.map(([q, a], i) => (
          <details key={q} open={i === 0}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
      <h3>Ещё</h3>
      <div className="settings-group">
        <button
          type="button"
          className="settings-row"
          onClick={() => openBot(`https://t.me/${BOT}`)}
        >
          <span className="settings-icon blue">
            <Bot size={18} />
          </span>
          <span className="settings-row-text">
            <strong>Чат с ботом</strong>
            <small>Уведомления и быстрые действия</small>
          </span>
          <ChevronRight size={18} className="settings-chevron" />
        </button>
        <button type="button" className="settings-row" disabled>
          <span className="settings-icon orange">
            <MessageCircle size={18} />
          </span>
          <span className="settings-row-text">
            <strong>
              Написать нам <Soon />
            </strong>
            <small>Вопросы и предложения</small>
          </span>
        </button>
      </div>
    </div>
  );
}
