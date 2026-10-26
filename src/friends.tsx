import { validBirthday } from "../shared/birthday";
import { isGender } from "../shared/events";
import React, { useEffect, useState } from "react";
import {
  AtSign,
  Check,
  Link as LinkIcon,
  UserPlus,
  X,
  Heart,
  LogOut,
} from "lucide-react";
import { api, demo, openBot, type Notifications } from "./api";
import { CopyValue } from "./forms";
import { AvatarEditor, Face } from "./avatar";
import { type User, handle, initials } from "./types";
export function AddFriend({ onDone }: { onDone: (message: string) => void }) {
  const [mode, setMode] = useState<"nick" | "link">("nick"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState<{
      id: string;
      telegram_url: string;
      expires_at: number;
    } | null>(null),
    [active, setActive] = useState<{ id: string; expires_at: number }[]>([]);
  async function reload() {
    if (demo) return;
    try {
      setActive((await api("/api/friend-invites")).invites);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (mode === "link") void reload();
  }, [mode]);
  return (
    <>
      <div className="segmented">
        <button
          className={mode === "nick" ? "selected" : ""}
          onClick={() => setMode("nick")}
        >
          <AtSign size={15} /> По нику
        </button>
        <button
          className={mode === "link" ? "selected" : ""}
          onClick={() => setMode("link")}
        >
          <LinkIcon size={15} /> По ссылке
        </button>
      </div>
      {mode === "nick" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (demo) {
              setError("В демо заявки не отправляются.");
              return;
            }
            setBusy(true);
            setError("");
            try {
              const r = await api("/api/friends/requests", "POST", {
                username: new FormData(e.currentTarget).get("username"),
              });
              onDone(
                r.status === "accepted"
                  ? "Вы теперь друзья!"
                  : "Заявка отправлена. Друг увидит её в разделе «Друзья».",
              );
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="muted">
            Друг должен сначала войти в приложение, затем принять вашу заявку.
          </p>
          <label>
            Ник в Telegram
            <input
              name="username"
              required
              maxLength={33}
              placeholder="@nickname"
              autoCapitalize="none"
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary full-width" disabled={busy}>
            <UserPlus size={17} />
            {busy ? "Отправляем…" : "Отправить заявку"}
          </button>
        </form>
      ) : (
        <div className="share-result">
          <p className="muted">
            Отправьте ссылку другу. После подтверждения вы увидите вишлисты друг
            друга.
          </p>
          {invite && <CopyValue value={invite.telegram_url} />}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button
            className="button primary full-width"
            disabled={busy}
            onClick={async () => {
              if (demo) {
                setError("В демо приглашения не создаются.");
                return;
              }
              setBusy(true);
              setError("");
              try {
                setInvite(await api("/api/friend-invites", "POST"));
                await reload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <LinkIcon size={17} />
            {invite ? "Заменить ссылку" : "Создать приглашение"}
          </button>
          <p className="small-text">
            Срок — 30 дней. Новое приглашение заменит старое.
          </p>
          {active.map((l) => (
            <div className="active-link" key={l.id}>
              <span>
                Действует до{" "}
                {new Date(l.expires_at * 1000).toLocaleDateString("ru-RU")}
              </span>
              <button
                className="text-link danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/api/friend-invites/${l.id}`, "DELETE");
                    setInvite(null);
                    await reload();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Отозвать
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
export function Requests({
  incoming,
  outgoing,
  onChanged,
  notice,
}: {
  incoming: User[];
  outgoing: User[];
  onChanged: () => void;
  notice: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!incoming.length && !outgoing.length) return null;
  async function act(path: string, method: string, message: string) {
    if (demo) {
      notice("В демо заявки не меняются.");
      return;
    }
    setBusy(true);
    try {
      await api(path, method);
      notice(message);
      onChanged();
    } catch (e) {
      notice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="requests">
      {incoming.map((u) => (
        <div className="request" key={u.id}>
          <span className="avatar small">
            <Face user={u} />
          </span>
          <span>
            <strong>{u.name}</strong> {handle(u)}
            <small>хочет добавить вас в друзья</small>
          </span>
          <button
            className="button primary small-button"
            disabled={busy}
            onClick={() =>
              void act(
                `/api/friends/${u.id}/accept`,
                "POST",
                "Вы теперь друзья!",
              )
            }
          >
            <Check size={15} /> Принять
          </button>
          <button
            className="icon-button"
            aria-label={`Отклонить заявку ${u.name}`}
            disabled={busy}
            onClick={() =>
              void act(`/api/friends/${u.id}`, "DELETE", "Заявка отклонена")
            }
          >
            <X size={16} />
          </button>
        </div>
      ))}
      {outgoing.map((u) => (
        <div className="request outgoing" key={u.id}>
          <span className="avatar small">
            <Face user={u} />
          </span>
          <span>
            <strong>{u.name}</strong> {handle(u)}
            <small>ждём подтверждения</small>
          </span>
          <button
            className="text-link"
            disabled={busy}
            onClick={() =>
              void act(`/api/friends/${u.id}`, "DELETE", "Заявка отменена")
            }
          >
            Отменить
          </button>
        </div>
      ))}
    </div>
  );
}
export function AcceptInvite({
  token,
  onDone,
}: {
  token: string;
  onDone: (message: string) => void;
}) {
  const [owner, setOwner] = useState<User | null>(null),
    [already, setAlready] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api("/api/friend-invites/preview", "POST", { token })
      .then((r) => {
        setOwner(r.owner);
        setAlready(r.already_friends);
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!owner)
    return (
      <div className="loading" role="status">
        <span />
        Проверяем приглашение…
      </div>
    );
  return (
    <div className="share-result">
      <span className="avatar large">
        <Face user={owner} />
      </span>
      <h3>
        {owner.name} {handle(owner)}
      </h3>
      <p>
        {already
          ? "Вы уже друзья — вишлисты друг друга доступны в разделе «Друзья»."
          : "приглашает вас в друзья. Вы сможете видеть вишлисты друг друга."}
      </p>
      {!already && (
        <button
          className="button primary full-width"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/api/friend-invites/accept", "POST", { token });
              onDone(`Вы теперь друзья с ${owner.name.split(" ")[0]}!`);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Heart size={17} /> Добавить в друзья
        </button>
      )}
    </div>
  );
}
export function Profile({
  user,
  friends,
  webSession,
  onAddFriend,
  onLogout,
  onUpdated,
}: {
  user: User | null;
  friends: number;
  webSession: boolean;
  onAddFriend: () => void;
  onLogout: (everywhere: boolean) => void;
  onUpdated: (user: User) => void;
}) {
  const [month, setMonth] = useState(user?.birthday?.slice(0, 2) || "");
  const [day, setDay] = useState(user?.birthday?.slice(3) || "");
  const [gender, setGender] = useState<string>(user?.gender || "");
  const [allow, setAllow] = useState(user?.allow_resharing !== 0);
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
          <>Нет ника Telegram. Чтобы добавить друга, отправьте приглашение.</>
        )}
      </p>
      <p className="small-text">Друзей: {friends}</p>
      <form
        className="profile-settings"
        onChange={() => setSaved(false)}
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setSaved(false);
          if (!!day !== !!month) {
            setError("Укажите день и месяц рождения.");
            return;
          }
          if (day && month && !validBirthday(`${month}-${day}`)) {
            setError("Укажите существующую дату рождения.");
            return;
          }
          setSaving(true);
          try {
            const values = {
              birthday: day && month ? `${month}-${day}` : null,
              gender: isGender(gender) ? gender : null,
              allow_resharing: allow,
              ...(notifications ? { notify } : {}),
            };
            if (demo) {
              onUpdated({
                ...user!,
                ...values,
                allow_resharing: allow ? 1 : 0,
              });
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
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={allow}
            onChange={(e) => setAllow(e.target.checked)}
          />
          Разрешить другим делиться моим вишлистом
        </label>
        <p className="small-text">
          Отключает ссылки, созданные другими. Ваши ссылки остаются рабочими.
        </p>
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
              Бот напишет о заявках в друзья, днях рождения друзей, новых
              желаниях и мероприятиях друзей, на которых вы подписаны,
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
      <button className="button primary full-width" onClick={onAddFriend}>
        <UserPlus size={17} /> Добавить друга
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
