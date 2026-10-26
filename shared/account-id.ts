// Account IDs. Accounts created through Telegram keep the Telegram user ID
// (digits only), as all existing accounts do. Accounts created by another
// sign-in method get "a_" + a random UUID, so they can never collide with a
// Telegram ID. Where the bot must write to a person, use their Telegram
// identity, not the account ID.
export const ACCOUNT_ID =
  /^(\d{1,20}|a_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The same pattern without anchors, for building route patterns. */
export const ACCOUNT_ID_PART =
  "\\d{1,20}|a_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const isAccountId = (value: unknown): value is string =>
  typeof value === "string" && ACCOUNT_ID.test(value);
export const newAccountId = () => `a_${crypto.randomUUID()}`;
