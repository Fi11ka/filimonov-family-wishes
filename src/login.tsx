import React, { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { api, setSessionToken } from "./api";
// Website sign-in with Telegram. The page CSP forbids eval, which the iframe
// widget needs for data-onauth, so the official popup API Telegram.Login.auth
// is used with our own button. The popup must open inside the click handler,
// hence the script and bot ID are loaded in advance.
const WIDGET = "https://telegram.org/js/telegram-widget.js?22";
type AuthData = Record<string, string | number> | false;
interface LoginApi {
  auth: (
    options: { bot_id: number; lang?: string },
    callback: (data: AuthData) => void,
  ) => void;
}
const loginApi = () =>
  (window as unknown as { Telegram?: { Login?: LoginApi } }).Telegram?.Login;
let scriptLoad: Promise<void> | null = null;
function loadWidget() {
  if (loginApi()) return Promise.resolve();
  scriptLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = WIDGET;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptLoad = null;
      reject(new Error("Не удалось загрузить вход через Telegram."));
    };
    document.head.appendChild(s);
  });
  return scriptLoad;
}
export function WebLogin({
  onSignedIn,
  compact,
}: {
  onSignedIn: () => void;
  compact?: boolean;
}) {
  const [botId, setBotId] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ bot_id: number | null }>("/api/auth/config"),
      loadWidget(),
    ])
      .then(([c]) => alive && setBotId(c.bot_id))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);
  function signIn() {
    const login = loginApi();
    if (!login || !botId) return;
    setError("");
    setBusy(true);
    login.auth({ bot_id: botId, lang: "ru" }, async (data) => {
      if (!data) {
        setBusy(false);
        setError(
          "Вход не завершён. Подтвердите его в Telegram и попробуйте ещё раз.",
        );
        return;
      }
      try {
        const r = await api<{ token: string }>(
          "/api/auth/telegram-login",
          "POST",
          data,
        );
        setSessionToken(r.token);
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
        disabled={!botId || busy}
        onClick={signIn}
      >
        <Send size={17} />
        {busy ? "Ждём подтверждения…" : "Войти через Telegram"}
      </button>
      {!compact && (
        <p className="small-text">
          Откроется окно Telegram: подтвердите вход, и сайт откроется под вашим
          аккаунтом.
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
