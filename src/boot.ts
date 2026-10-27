// Starts the app. Telegram's Mini App script is loaded first, but only inside
// Telegram: in a regular browser the site does not wait for telegram.org,
// which can be slow or unreachable.
const TELEGRAM_SCRIPT = "https://telegram.org/js/telegram-web-app.js";

function inTelegram() {
  // Telegram passes the launch data in the address (tgWebAppData, tgWebAppVersion…).
  if (/tgWebApp/.test(location.hash + location.search)) return true;
  // Telegram's mobile and desktop apps inject this bridge.
  if ("TelegramWebviewProxy" in window) return true;
  try {
    // Telegram's script keeps the launch data here for reloads inside Telegram
    // (outside Telegram it stores "{}", so only real launch data counts).
    const saved = sessionStorage.getItem("__telegram__initParams") || "";
    if (/tgWebApp/.test(saved)) return true;
  } catch {
    // Storage can be unavailable; the checks above are enough.
  }
  return false;
}

function loadTelegram() {
  return new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = TELEGRAM_SCRIPT;
    // Without the script the app still starts, as before when telegram.org failed.
    script.onload = script.onerror = () => resolve();
    document.head.appendChild(script);
  });
}

// src/api.ts reads window.Telegram when it is first imported, so the app is
// imported only after the script has run.
void (inTelegram() ? loadTelegram() : Promise.resolve()).then(
  () => import("./main"),
);
