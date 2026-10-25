import React, { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { api, setSessionToken } from "./api";
// Website sign-in with Telegram Login (OpenID Connect). The popup is opened
// the same way telegram-login.js does it (response_type=post_message), but
// with the origin parameter: oauth.telegram.org answers "origin required"
// without it, and the library (?6) does not send it. No third-party script
// runs on the page. The popup must open inside the click handler, so the
// Client ID and a one-time nonce are prepared in advance.
const AUTH_ORIGIN = "https://oauth.telegram.org";
const NONCE_REFRESH_MS = 8 * 60_000; // server nonces live 10 minutes
type LoginResult = { id_token?: string; error?: string };
function openTelegramLogin(
  clientId: number,
  nonce: string,
  done: (result: LoginResult) => void,
): Window | null {
  const params = {
    response_type: "post_message",
    client_id: String(clientId),
    redirect_uri: location.origin + location.pathname,
    origin: location.origin,
    scope: "openid profile",
    nonce,
    lang: "ru",
  };
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const width = 550,
    height = 650;
  const left = Math.max(0, (screen.width - width) / 2),
    top = Math.max(0, (screen.height - height) / 2);
  const popup = window.open(
    `${AUTH_ORIGIN}/auth?${query}`,
    "telegram_oidc_login",
    `width=${width},height=${height},left=${left},top=${top},status=0,location=0,menubar=0,toolbar=0`,
  );
  if (!popup) {
    done({ error: "popup_blocked" });
    return null;
  }
  let finished = false;
  const finish = (result: LoginResult) => {
    if (finished) return;
    finished = true;
    window.removeEventListener("message", onMessage);
    clearInterval(timer);
    done(result);
  };
  // Only the popup we opened, served by oauth.telegram.org, can answer.
  function onMessage(e: MessageEvent) {
    if (e.origin !== AUTH_ORIGIN || e.source !== popup) return;
    let data = e.data;
    try {
      if (typeof data === "string") data = JSON.parse(data);
    } catch {
      return;
    }
    if (data?.event !== "auth_result") return;
    finish(
      data.error
        ? { error: String(data.error) }
        : typeof data.result === "string"
          ? { id_token: data.result }
          : { error: "missing id_token" },
    );
  }
  window.addEventListener("message", onMessage);
  const timer = setInterval(() => {
    if (popup.closed) finish({ error: "popup_closed" });
  }, 300);
  return popup;
}
export function WebLogin({
  onSignedIn,
  compact,
}: {
  onSignedIn: () => void;
  compact?: boolean;
}) {
  const [clientId, setClientId] = useState<number | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const nonce = useRef<{ value: string; at: number } | null>(null);
  const popup = useRef<Window | null>(null);
  async function freshNonce() {
    try {
      const r = await api<{ nonce: string }>("/api/auth/nonce", "POST");
      nonce.current = { value: r.nonce, at: Date.now() };
      setReady(true);
    } catch (e) {
      nonce.current = null;
      setReady(false);
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    let alive = true;
    api<{ bot_id: number | null }>("/api/auth/config")
      .then((c) => {
        if (!alive) return;
        setClientId(c.bot_id);
        return freshNonce();
      })
      .catch((e) => alive && setError((e as Error).message));
    // Keep a valid nonce ready so the popup can open immediately on click.
    const timer = setInterval(() => void freshNonce(), NONCE_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  function signIn() {
    const n = nonce.current;
    if (!clientId || !n || Date.now() - n.at > NONCE_REFRESH_MS) {
      setError("Вход ещё готовится. Нажмите ещё раз через пару секунд.");
      void freshNonce();
      return;
    }
    // A nonce is single-use: take it now and prepare the next one.
    nonce.current = null;
    setReady(false);
    setError("");
    setBusy(true);
    popup.current = openTelegramLogin(clientId, n.value, async (r) => {
      void freshNonce();
      if (!r.id_token) {
        setBusy(false);
        setError(
          r.error === "popup_closed"
            ? "Окно входа закрыто — вход не выполнен."
            : r.error === "popup_blocked"
              ? "Браузер не дал открыть окно Telegram. Разрешите всплывающие окна для сайта и нажмите ещё раз."
              : "Вход не завершён. Подтвердите его в Telegram и попробуйте ещё раз.",
        );
        return;
      }
      try {
        const s = await api<{ token: string }>(
          "/api/auth/telegram-oidc",
          "POST",
          { id_token: r.id_token },
        );
        setSessionToken(s.token);
        onSignedIn();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    });
  }
  return (
    <div className={`web-login ${compact ? "compact" : ""}`}>
      <button
        className="button telegram-login"
        disabled={!clientId || !ready || busy}
        onClick={signIn}
      >
        <Send size={17} />
        {busy ? "Ждём подтверждения…" : "Войти через Telegram"}
      </button>
      {busy && (
        <button
          className="text-link"
          onClick={() => {
            // Closing the popup ends the attempt through the usual path.
            if (popup.current && !popup.current.closed) popup.current.close();
            else setBusy(false);
          }}
        >
          Отмена
        </button>
      )}
      {!compact && !busy && (
        <p className="small-text">
          Откроется окно Telegram: выберите аккаунт и подтвердите вход — сайт
          откроется под вашим аккаунтом.
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
