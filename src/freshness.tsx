// The list's own «Подтвердить актуальность» (П36, Б2.23–Б2.30). The status
// follows the clock, so an open list turns stale without a reload; confirming
// tells nobody.
import React, { useState } from "react";
import { CircleCheck, RefreshCw } from "lucide-react";
import { api, demo } from "./api";
import { freshness } from "../shared/freshness";

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

export function Freshness({
  checkedAt,
  own,
  now,
  onConfirmed,
}: {
  checkedAt: number | null | undefined;
  /** The owner sees the button; others only the status. */
  own: boolean;
  now: Date;
  onConfirmed: (at: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = freshness(checkedAt, now.getTime());
  async function confirm() {
    if (demo) {
      onConfirmed(Math.floor(Date.now() / 1000));
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const r = await api<{ checked_at: number }>("/api/me/checked", "POST");
      onConfirmed(r.checked_at);
    } catch {
      // The old date and status stay as they were.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`freshness ${state}`}>
      {state === "fresh" && checkedAt ? (
        <p>
          <CircleCheck size={16} />
          <span>
            <strong>Вишлист актуален</strong> · подтверждено {day(checkedAt)}
          </span>
        </p>
      ) : own ? (
        <p>
          {state === "stale"
            ? "Всё ещё хотите эти подарки? Проверьте список и подтвердите актуальность."
            : "Проверьте список и подтвердите актуальность."}
        </p>
      ) : (
        <p>
          {state === "stale"
            ? "Актуальность подтверждена больше месяца назад. Перед покупкой советуем уточнить у владельца, актуальны ли желания."
            : "Владелец пока не подтвердил актуальность списка."}
        </p>
      )}
      {own && (
        <button
          className="button secondary small"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {failed ? <RefreshCw size={15} /> : <CircleCheck size={15} />}
          {busy
            ? "Сохраняем…"
            : failed
              ? "Повторить"
              : "Подтвердить актуальность"}
        </button>
      )}
      {failed && (
        <p className="error" role="alert">
          Не удалось подтвердить. Повторите, пожалуйста.
        </p>
      )}
    </div>
  );
}
