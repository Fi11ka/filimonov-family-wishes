// Picking some of my active wishes with ticks (П25, П30): for a guest link now,
// for an event later. Nothing applies until «Готово»; closing keeps the old choice.
import React, { useState } from "react";
import { Modal } from "./forms";
import type { Wish } from "./types";

export function WishPicker({
  wishes,
  initial,
  onDone,
  onClose,
}: {
  wishes: Pick<Wish, "id" | "title">[];
  /** The current choice; null is «Весь вишлист», which starts with everything ticked. */
  initial: string[] | null;
  onDone: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(initial ?? wishes.map((w) => w.id)),
  );
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Modal title="Выбрать желания" onClose={onClose}>
      <div className="share-result wish-picker">
        <div className="wish-picker-tools">
          <button
            type="button"
            className="text-link"
            onClick={() => setPicked(new Set(wishes.map((w) => w.id)))}
          >
            Выбрать все
          </button>
          <button
            type="button"
            className="text-link"
            onClick={() => setPicked(new Set())}
          >
            Снять выбор
          </button>
        </div>
        {wishes.length ? (
          <div className="friend-picker">
            {wishes.map((w) => (
              <label key={w.id} className="setting-toggle">
                <input
                  type="checkbox"
                  checked={picked.has(w.id)}
                  onChange={() => toggle(w.id)}
                />
                {w.title}
              </label>
            ))}
          </div>
        ) : (
          <p className="small-text">В списке пока нет желаний.</p>
        )}
        <button
          type="button"
          className="button primary full-width"
          onClick={() => onDone(wishes.filter((w) => picked.has(w.id)).map((w) => w.id))}
        >
          Готово · {picked.size}
        </button>
      </div>
    </Modal>
  );
}
