import React, { useEffect, useState } from "react";
import { Bell, ChevronRight } from "lucide-react";
import { api } from "./api";

export type Note = {
  id: number;
  text: string;
  /** The app screen it leads to: l_<id>, b, e_…, f. */
  open: string | null;
  created_at: number;
  read: boolean;
};

/** The bot's text is Telegram HTML with <b> only and everything else escaped. */
function BotText({ html }: { html: string }) {
  const plain = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return (
    <>
      {html
        .split(/(<b>.*?<\/b>)/s)
        .map((part, i) =>
          part.startsWith("<b>") ? (
            <strong key={i}>{plain(part.slice(3, -4))}</strong>
          ) : (
            <React.Fragment key={i}>{plain(part)}</React.Fragment>
          ),
        )}
    </>
  );
}

/**
 * «Уведомления»: everything the bot sent. Opening the section reads them all;
 * the ones that were new stay highlighted until it is opened again.
 */
export function Notifications({
  onOpen,
  onRead,
}: {
  onOpen: (target: string) => void;
  onRead: () => void;
}) {
  const [items, setItems] = useState<Note[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api("/api/notifications")
      .then(async (d) => {
        setItems(d.items);
        if (d.unread) {
          await api("/api/notifications/read", "POST", { all: true });
          onRead();
        }
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!items)
    return (
      <div className="loading" role="status">
        <span />
        Загрузка…
      </div>
    );
  if (!items.length)
    return (
      <div className="empty">
        <Bell size={34} />
        <h3>Уведомлений пока нет</h3>
        <p>
          Здесь будет всё, что пишет бот: запросы на подписку, дни рождения,
          приглашения и новости о вишлистах.
        </p>
      </div>
    );
  return (
    <ul className="notes">
      {items.map((n) => {
        const body = (
          <>
            <span className="note-text">
              <BotText html={n.text} />
            </span>
            <time dateTime={new Date(n.created_at * 1000).toISOString()}>
              {new Date(n.created_at * 1000).toLocaleString("ru-RU", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </>
        );
        return (
          <li key={n.id} className={n.read ? "" : "unread"}>
            {n.open ? (
              <button onClick={() => onOpen(n.open!)}>
                {body}
                <ChevronRight size={16} />
              </button>
            ) : (
              <div>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
