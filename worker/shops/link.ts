import { fail } from "../security";

/** Keep product/variant identifiers, without advertising or search parameters. */
export function productLink(input: URL): URL {
  const u = new URL(input);
  let match: RegExpMatchArray | null;
  if (
    /(^|\.)amazon\.(com|co\.uk|de|fr|it|es|nl|ie|be|com\.tr|ca|com\.au|co\.jp|in|ae|sa|pl|se|sg|com\.mx|com\.br)$/.test(
      u.hostname,
    ) &&
    (match = u.pathname.match(
      /^\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i,
    ))
  ) {
    u.pathname = `/dp/${match[1].toUpperCase()}`;
    u.search = "";
  } else if (
    /(^|\.)ozon\.(ru|by|kz)$/.test(u.hostname) &&
    /^\/search\/?$/.test(u.pathname)
  ) {
    const id = u.searchParams.get("product_id");
    if (!id || !/^[1-9]\d{0,14}$/.test(id))
      fail(
        400,
        "PRODUCT_LINK",
        "Нужна ссылка на конкретный товар Ozon, а не на результаты поиска.",
      );
    u.pathname = `/product/${id}/`;
    u.search = "";
  } else if (
    /(^|\.)aliexpress\.(ru|com)$/.test(u.hostname) &&
    /^\/item\/\d+\.html$/.test(u.pathname)
  ) {
    const sku = u.searchParams.get("sku_id");
    u.search = "";
    if (sku && /^\d{1,20}$/.test(sku)) u.searchParams.set("sku_id", sku);
  } else if (
    /(^|\.)(wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru)$/.test(u.hostname) &&
    /^\/catalog\/\d+\/detail\.aspx$/.test(u.pathname)
  ) {
    const size = u.searchParams.get("size");
    u.search = "";
    if (size && /^\d{1,20}$/.test(size)) u.searchParams.set("size", size);
  } else if (
    /(^|\.)dns-shop\.(ru|kz)$/.test(u.hostname) &&
    /^\/product\/[0-9a-f]{8,32}\//.test(u.pathname)
  ) {
    u.search = "";
  }
  return u;
}
