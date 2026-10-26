export const BOT = "FilimonovFamilyWishes_bot";
/** A Main Mini App link opens the app, while t.me/<bot> alone opens the chat.
 * Carry the current guest/friend invitation into Telegram instead of dropping it. */
export function telegramAppLink(
  guestToken = "",
  friendInvite = "",
  authenticatedShare = false,
) {
  const start = guestToken
    ? `${authenticatedShare ? "s" : "g"}_${guestToken}`
    : friendInvite
      ? `f_${friendInvite}`
      : "";
  return `https://t.me/${BOT}?startapp${start ? `=${encodeURIComponent(start)}` : ""}`;
}
/** Telegram in a web browser (web.telegram.org): the site opens as a tab there. */
const TELEGRAM_WEB = new Set(["web", "weba", "webk"]);
/**
 * After «В браузере» the Mini App closes, so two copies are not left open —
 * except in Telegram Web, where the new tab may be blocked as a pop-up and
 * the Mini App must stay to return to.
 */
export const closesAfterSwitch = (platform = "") => !TELEGRAM_WEB.has(platform);
