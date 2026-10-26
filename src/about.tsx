import React, { useState } from "react";
import { Pencil } from "lucide-react";
import { api, demo } from "./api";
import type { User } from "./types";
/** The description under the wishlist title; the owner edits it in place. */
export function WishlistAbout({
  owner,
  own,
  onSaved,
}: {
  owner: User;
  own: boolean;
  onSaved: (user: User) => void;
}) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(owner.about || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!editing)
    return owner.about ? (
      <p className="wishlist-about">
        {owner.about}
        {own && (
          <button
            className="icon-button about-edit"
            aria-label="Изменить описание вишлиста"
            onClick={() => {
              setValue(owner.about || "");
              setEditing(true);
            }}
          >
            <Pencil size={14} />
          </button>
        )}
      </p>
    ) : own ? (
      <button className="text-link about-add" onClick={() => setEditing(true)}>
        <Pencil size={14} /> Добавить описание вишлиста
      </button>
    ) : null;
  return (
    <form
      className="about-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const about = value.trim();
          if (demo) onSaved({ ...owner, about });
          else onSaved((await api("/api/me", "PATCH", { about })).user);
          setEditing(false);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea
        autoFocus
        rows={3}
        maxLength={500}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Описание вишлиста"
        placeholder="Например: люблю книги, уютные вещи и всё фиолетовое. Размер одежды M, обуви 38."
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="about-actions">
        <span className="small-text">{value.length}/500</span>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          Отмена
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </form>
  );
}
