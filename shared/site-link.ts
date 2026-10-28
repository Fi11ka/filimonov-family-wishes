// The website, not the Mini App, is what «Поделиться» sends (П19).
/** The profile on the site: without signing in it shows only the card. */
export function siteProfileLink(site: string, id: string, list?: string | null) {
  const u = new URL(site);
  u.search = "";
  u.hash = "";
  u.searchParams.set("p", id);
  // A list kept for someone close: the same access, that list opened first.
  if (list) u.searchParams.set("l", list);
  return u.href;
}
