export const BOT = "FilimonovFamilyWishes_bot";
/** A Main Mini App link opens the app, while t.me/<bot> alone opens the chat.
 * `start` carries the current guest link (g_…) or profile (p_…) into Telegram. */
export function telegramAppLink(start = "") {
  return `https://t.me/${BOT}?startapp${start ? `=${encodeURIComponent(start)}` : ""}`;
}
/** The profile link: by itself it opens only the card of a closed profile. */
export const profileLink = (id: string) => telegramAppLink(`p_${id}`);
/** Telegram in a web browser (web.telegram.org): the site opens as a tab there. */
const TELEGRAM_WEB = new Set(["web", "weba", "webk"]);
/**
 * After «В браузере» the Mini App closes, so two copies are not left open —
 * except in Telegram Web, where the new tab may be blocked as a pop-up and
 * the Mini App must stay to return to.
 */
export const closesAfterSwitch = (platform = "") => !TELEGRAM_WEB.has(platform);
