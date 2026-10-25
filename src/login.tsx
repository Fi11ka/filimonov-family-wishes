import React, { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { api, setSessionToken } from "./api";
// Website sign-in with Telegram Login (OpenID Connect), using the official
// JS API of telegram-login.js. The HTML snippet with data-onauth is not used:
// the library runs that attribute through new Function, which the page CSP
// forbids. The popup must open inside the click handler, so the library, the
// Client ID and a one-time nonce are prepared in advance.
const LIBRARY = "https://oauth.telegram.org/js/telegram-login.js?6";
const NONCE_REFRESH_MS = 8 * 60_000; // server nonces live 10 minutes
type LoginResult = { id_token?: string; error?: string };
interface LoginApi {
  auth: (
    options: { client_id: number; nonce: string; lang?: string },
    callback: (result: LoginResult) => void,
  ) => void;
}
const loginApi = () =>
  (window as unknown as { Telegram?: { Login?: LoginApi } }).Telegram?.Login;
let scriptLoad: Promise<void> | null = null;
function loadLibrary() {
  if (loginApi()?.auth) return Promise.resolve();
  scriptLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIBRARY;
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
  const [clientId, setClientId] = useState<number | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const nonce = useRef<{ value: string; at: number } | null>(null);
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
    Promise.all([
      api<{ bot_id: number | null }>("/api/auth/config"),
      loadLibrary(),
    ])
      .then(([c]) => {
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
    const login = loginApi();
    const n = nonce.current;
    if (!login || !clientId || !n || Date.now() - n.at > NONCE_REFRESH_MS) {
      setError("Вход ещё готовится. Нажмите ещё раз через пару секунд.");
      void freshNonce();
      return;
    }
    // A nonce is single-use: take it now and prepare the next one.
    nonce.current = null;
    setReady(false);
    setError("");
    setBusy(true);
    login.auth(
      { client_id: clientId, nonce: n.value, lang: "ru" },
      async (r) => {
        void freshNonce();
        if (!r.id_token) {
          setBusy(false);
          setError(
            r.error === "popup_closed"
              ? "Окно входа закрыто — вход не выполнен."
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
      },
    );
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
            setBusy(false);
            setError(
              "Если окно Telegram не открылось, разрешите всплывающие окна для сайта и нажмите ещё раз.",
            );
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
