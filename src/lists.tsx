// Wishlists kept for people close to you (П35, flow 17): one switcher by name,
// and a list made from a name alone. Access is the same as for your own list.
import React, { useState } from "react";
import { Plus } from "lucide-react";
import { api, demo } from "./api";
import { Modal } from "./forms";
import type { ListRef } from "./types";

/**
 * «Мой · Маша · Бабушка» for the manager, «Анна · Маша» for a friend. Not shown
 * to a friend until there is more than one list; the manager always has «+».
 */
export function ListSwitcher({
  ownerFirst,
  lists,
  current,
  canAdd,
  onPick,
  onAdd,
}: {
  ownerFirst: string;
  lists: ListRef[];
  current: string | null;
  canAdd: boolean;
  onPick: (id: string | null) => void;
  onAdd: () => void;
}) {
  return (
    <div className="list-switcher" role="tablist" aria-label="Вишлисты">
      {lists.length > 0 && (
        <>
          <button
            role="tab"
            aria-selected={current === null}
            className={current === null ? "selected" : ""}
            onClick={() => onPick(null)}
          >
            {ownerFirst}
          </button>
          {lists.map((l) => (
            <button
              key={l.id}
              role="tab"
              aria-selected={current === l.id}
              className={current === l.id ? "selected" : ""}
              onClick={() => onPick(l.id)}
            >
              {l.name}
            </button>
          ))}
        </>
      )}
      {canAdd && (
        <button className="list-add" onClick={onAdd}>
          <Plus size={15} />
          {lists.length ? "Близкий" : "Добавить вишлист близкого"}
        </button>
      )}
    </div>
  );
}

/** «Добавить вишлист близкого»: only a name; cancelling creates nothing. */
export function AddList({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (list: ListRef) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Вишлист близкого"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="share-result"
        onSubmit={async (e) => {
          e.preventDefault();
          if (demo) {
            setError("В демо списки не создаются.");
            return;
          }
          if (!name.trim()) return;
          setBusy(true);
          setError("");
          try {
            const r = await api<{ list: ListRef }>("/api/wishlists", "POST", {
              name: name.trim(),
            });
            await onAdded(r.list);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Имя
          <input
            autoFocus
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, Маша или Бабушка"
          />
        </label>
        <p className="small-text">
          Список увидят все, кому виден ваш вишлист. Регистрироваться близкому не
          нужно.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary full-width"
          disabled={busy || !name.trim()}
        >
          {busy ? "Создаём…" : "Создать"}
        </button>
      </form>
    </Modal>
  );
}
