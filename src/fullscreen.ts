import { useEffect, useState } from "react";
import { telegram } from "./api";
// Telegram decides the Mini App window size; the app can only ask for full screen
// (Bot API 8.0). Desktop clients start full screen unless the user turned it off.
const KEY = "fw:fullscreen";
const DESKTOP = new Set(["tdesktop", "macos"]);
export const fullscreenSupported =
  !!telegram?.requestFullscreen && !!telegram.isVersionAtLeast?.("8.0");
function preference() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function remember(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage can be unavailable; the toggle still works for this session.
  }
}
export function useFullscreen(onError: (message: string) => void) {
  const [on, setOn] = useState(!!telegram?.isFullscreen);
  useEffect(() => {
    const tg = telegram;
    if (!fullscreenSupported || !tg) return;
    const changed = () => {
      setOn(!!tg.isFullscreen);
      document.documentElement.classList.toggle(
        "tg-fullscreen",
        !!tg.isFullscreen,
      );
    };
    const failed = (e?: { error?: string }) => {
      if (e?.error !== "ALREADY_FULLSCREEN")
        onError("Telegram не разрешил полноэкранный режим на этом устройстве.");
    };
    tg.onEvent?.("fullscreenChanged", changed);
    tg.onEvent?.("fullscreenFailed", failed);
    changed();
    const pref = preference();
    if (
      !tg.isFullscreen &&
      (pref === "on" || (pref === null && DESKTOP.has(tg.platform || "")))
    )
      tg.requestFullscreen?.();
    return () => {
      tg.offEvent?.("fullscreenChanged", changed);
      tg.offEvent?.("fullscreenFailed", failed);
    };
  }, []);
  function toggle() {
    const next = !telegram?.isFullscreen;
    remember(next);
    if (next) telegram?.requestFullscreen?.();
    else telegram?.exitFullscreen?.();
  }
  return { supported: fullscreenSupported, on, toggle };
}
