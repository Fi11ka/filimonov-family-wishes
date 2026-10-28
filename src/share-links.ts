// «Поделиться» always sends a link to the website, whichever app it goes to:
// Telegram in the system menu does not turn it into a Mini App link (П19).
export { siteProfileLink } from "../shared/site-link";
/** This site's address, without the Telegram launch data or a guest token. */
export const currentSite = () => location.origin + location.pathname;
type ShareResult = "shared" | "cancelled" | "unavailable";
/**
 * Opens the system menu: any app, or copying the link. "cancelled" when the
 * person closed it, so nothing claims the link was sent.
 */
export async function shareLink(
  url: string,
  text: string,
  nav: Pick<Navigator, "share" | "canShare"> | undefined = globalThis.navigator,
): Promise<ShareResult> {
  const data = { title: "Вишлист", text, url };
  if (!nav?.share || (nav.canShare && !nav.canShare(data)))
    return "unavailable";
  try {
    await nav.share(data);
    return "shared";
  } catch (e) {
    // AbortError: closed by the person. Anything else (no user gesture left
    // after loading the link, blocked by the webview): offer copying instead.
    return (e as Error)?.name === "AbortError" ? "cancelled" : "unavailable";
  }
}
