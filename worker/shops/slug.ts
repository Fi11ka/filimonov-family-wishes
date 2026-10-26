// Shops write product names into their addresses: Ozon
// "/product/zhurnalnyy-stolik-loft-…-1348747111/", DNS
// "/product/0bcabdaf10297734/142-noutbuk-apple-macbook-pro-m5-max-cernyj/".
// When a shop does not let the server read the page, the address still gives
// a name. Russian shops write Russian words in Latin letters without ь/ъ.

// Ozon-style transliteration, longest first. DNS writes "й" as "j" and
// "ч" as "c" ("cernyj"); those are handled in cyrillic().
const TRANSLIT: [string, string][] = [
  ["shch", "щ"],
  ["sch", "щ"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ts", "ц"],
  ["ch", "ч"],
  ["sh", "ш"],
  ["yu", "ю"],
  ["ya", "я"],
  ["yo", "ё"],
  ["iy", "ий"],
  ["yi", "ый"],
  ["ii", "ий"],
  ["yy", "ый"],
  ["ey", "ей"],
  ["oy", "ой"],
  ["ay", "ай"],
  ["uy", "уй"],
  ["a", "а"],
  ["b", "б"],
  ["v", "в"],
  ["g", "г"],
  ["d", "д"],
  ["e", "е"],
  ["z", "з"],
  ["i", "и"],
  ["k", "к"],
  ["l", "л"],
  ["m", "м"],
  ["n", "н"],
  ["o", "о"],
  ["p", "п"],
  ["r", "р"],
  ["s", "с"],
  ["t", "т"],
  ["u", "у"],
  ["f", "ф"],
  ["h", "х"],
  ["c", "ц"],
  ["y", "ы"],
  ["j", "й"],
  ["w", "в"],
  ["x", "кс"],
  ["q", "к"],
];
// Brands and English words that must stay in Latin letters.
const ENGLISH = new Set(
  "apple macbook iphone ipad airpods watch pro max mini plus ultra air lite note samsung galaxy xiaomi redmi poco honor huawei realme oneplus google pixel sony playstation xbox nintendo switch lenovo asus acer hp dell msi lg philips bosch tefal braun dyson karcher logitech razer jbl marshall canon nikon gopro lego nike adidas puma reebok new balance converse vans zara mango levis smart tv usb type wifi bluetooth gaming edition series black white gold silver blue red green pink grey gray dark light home kids baby".split(
    " ",
  ),
);
function english(word: string) {
  return (
    ENGLISH.has(word) ||
    /[wqx]|th|ph|ck|oo|ee|ea|uu/.test(word) ||
    /^[a-z]{1,2}\d|\d[a-z]{1,2}$/.test(word)
  );
}
function cyrillic(word: string, dnsStyle: boolean) {
  // Numbers, sizes and model codes stay as they are.
  if (!/^[a-z]+$/.test(word)) return word;
  let out = "";
  for (let i = 0; i < word.length;) {
    // "e" at the start of a word is usually "э": "elektricheskiy", "ekomekh".
    if (i === 0 && word[0] === "e" && word.length > 2) {
      out += "э";
      i++;
      continue;
    }
    // DNS: "c" is "ч" unless it is "ts"/"ch"; "j" is "й".
    if (dnsStyle && word[i] === "c" && word[i + 1] !== "h") {
      out += "ч";
      i++;
      continue;
    }
    // "iy", "ey"… are "ий", "ей" only before a consonant or at the end:
    // "bizhuteriya" is "бижутерия", "sheyu" is "шею".
    const [lat, cyr] = TRANSLIT.find(
      ([l]) =>
        word.startsWith(l, i) &&
        !(l.length === 2 && l[1] === "y" && /[aeiouy]/.test(word[i + 2] || "")),
    )!;
    out += cyr;
    i += lat.length;
  }
  return out;
}
/** "kole-mnogourovnevoe-bizhuteriya" → "Колье многоуровневое бижутерия"; English words stay. */
export function slugWords(slug: string, russian: boolean): string | null {
  const raw = slug
    .toLowerCase()
    .split(/[-_+]+/)
    .filter(Boolean);
  // A DNS-style slug ends adjectives in "j": "cernyj", "seryj", "belyj".
  const dnsStyle = raw.some((w) => /[yi]j$/.test(w));
  // Only clearly Russian slugs are converted: "osmo-pocket-3" stays Latin.
  if (
    russian &&
    !raw.some((w) =>
      /zh|kh|ts|ch|sh|yy|iy|yj|ij|ya|yu|ye$|yi$|ii$|ykh|ogo$|aya$|oye$|nyy|nyj/.test(
        w,
      ),
    )
  )
    russian = false;
  const words = raw
    .map((w) => (russian && !english(w) ? cyrillic(w, dnsStyle) : w))
    .map((w) =>
      ENGLISH.has(w) || english(w) ? w[0].toUpperCase() + w.slice(1) : w,
    )
    // Sellers repeat words: "kole-kole".
    .filter((w, i, all) => w !== all[i - 1]);
  const title = words
    .join(" ")
    .replace(/(\d) [hх] (\d)/g, "$1 х $2")
    // The most frequent lost soft signs: "журнальный", "спальное", "колье".
    .replace(/л(н(?:ый|ая|ое|ые|ого|ой))(?=\s|$)/g, "ль$1")
    .replace(/(^|\s)коле(?=\s|$)/g, "$1колье")
    .replace(/(^|\s)ожереле(?=\s|$)/g, "$1ожерелье")
    .trim();
  if (!/[a-zа-яё]{2}/i.test(title)) return null;
  return (title[0].toUpperCase() + title.slice(1)).slice(0, 120);
}
const RUSSIAN_TLD = /\.(ru|su|by|kz|xn--p1ai)$/i;
/**
 * The most word-like part of an address: "/product/<id>/142-noutbuk-…/" gives
 * "Ноутбук Apple Macbook Pro M5 Max черный". Ids, hashes and screen sizes are dropped.
 */
export function slugTitle(url: URL): string | null {
  let best: string[] = [];
  for (const part of url.pathname.split("/")) {
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      // keep as is
    }
    decoded = decoded.replace(/\.(html?|aspx?|php)$/i, "");
    const words = decoded
      .split(/[-_+\s]+/)
      .filter(Boolean)
      // Leading numbers ("142-noutbuk", a screen size), trailing ids and path words.
      .filter(
        (w, i, all) =>
          !(/^\d+$/.test(w) && i === 0) &&
          !(/^\d{5,}$/.test(w) && i === all.length - 1) &&
          !/^(products?|catalog|item|goods|detail|card|p|dp)$/i.test(w),
      );
    const wordy = words.filter(
      (w) => /[a-zа-яё]{2}/i.test(w) && !/^[0-9a-f]{8,}$/i.test(w),
    );
    if (
      wordy.length >= 2 &&
      wordy.length > best.filter((w) => /[a-zа-яё]{2}/i.test(w)).length
    )
      best = words;
  }
  if (!best.length) return null;
  const text = best.join("-");
  // Already Cyrillic (some shops keep it in the address).
  if (/[а-яё]/i.test(text)) {
    const t = best.join(" ");
    return (t[0].toUpperCase() + t.slice(1)).slice(0, 120);
  }
  return slugWords(text, RUSSIAN_TLD.test(url.hostname));
}
