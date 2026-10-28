import { validBirthday } from "../shared/birthday";
import React from "react";
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
