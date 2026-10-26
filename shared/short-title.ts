// Rule-based short names, shared by the Worker (shop lookups, carts) and the
// browser (pasted ChatGPT lists). Workers AI does better when it is available.
export interface ShortName {
  title: string;
  details: string;
}
// Words after which a shop title only describes the thing: "Шуба … из экомеха",
// "Набор мельниц для специй", "Пижама со штанами".
const PREPOSITION = /^(?:из|для|с|со|на|в|во|под|от|по|без|и|или|до|к)$/i;
/**
 * Rule-based fallback for long Russian shop titles: drops a leading brand (Latin
 * or capitals), cuts at the first describing part and keeps up to three words.
 * The full shop title goes to the hint. Null when there is nothing to shorten.
 */
export function shortTitle(title: string): ShortName | null {
  const original = title.replace(/\s+/g, " ").trim();
  const words = original.split(" ");
  // Up to four words is short enough ("Гель для волос", "Набор спиц & аксессуары").
  if (words.length <= 4) return null;
  // Leading brand: Latin words or capitals in any script ("ТЕЛОДВИЖЕНИЯ Шуба …", "NEED MORЕ").
  while (
    words.length > 1 &&
    (/^[A-Za-z0-9&'.+-]+$/.test(words[0]) ||
      /^(?=.*[A-ZА-ЯЁ].*[A-ZА-ЯЁ])[^a-zа-яё]+$/.test(words[0]))
  )
    words.shift();
  // Russian words only, up to the first describing part or model name.
  const kept: string[] = [];
  for (let i = 0; i < words.length && kept.length < 3; i++) {
    const w = words[i];
    if (PREPOSITION.test(w)) {
      // "Подставка для ноутбука": one word alone says too little.
      if (kept.length === 1 && /^[А-ЯЁа-яё-]+$/.test(words[i + 1] || ""))
        kept.push(w.toLowerCase(), words[i + 1]);
      break;
    }
    const clean = w.replace(/[,;:)]+$/, "");
    if (!/^[А-ЯЁа-яё-]+$/.test(clean)) break;
    kept.push(clean);
    if (clean !== w) break;
  }
  const name = kept.join(" ");
  if (!name || name === original) return null;
  return {
    title: name[0].toUpperCase() + name.slice(1).toLowerCase(),
    details: original,
  };
}
