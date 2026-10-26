// Wish priority: 1–5 hearts (more hearts — wanted more).
export const MAX_HEARTS = 5;
/** The old 1–3 priority column, kept in sync for compatibility. */
export const legacyPriority = (hearts: number) =>
  hearts <= 2 ? 1 : hearts === 3 ? 2 : 3;
/** Words and colours read by the import as 1–3 levels → hearts. */
export const heartsFromLevel = (level: 1 | 2 | 3) =>
  level === 1 ? 2 : level === 2 ? 3 : 5;
export const heartsLabel = (hearts: number) =>
  `${hearts} ${hearts === 1 ? "сердечко" : hearts < 5 ? "сердечка" : "сердечек"} из ${MAX_HEARTS}`;
