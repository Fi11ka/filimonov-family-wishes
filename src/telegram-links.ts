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
