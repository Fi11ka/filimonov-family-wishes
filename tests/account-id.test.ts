import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_ID_PART,
  isAccountId,
  newAccountId,
} from "../shared/account-id";
test("account IDs: Telegram digits or a_<uuid>, nothing else", () => {
  for (const ok of ["1", "123456789", "99999999999999999999", newAccountId()])
    assert.equal(isAccountId(ok), true, ok);
  for (const bad of [
    "",
    "a_",
    "a_123",
    "-5",
    "12a",
    "a_7304BBBB-0000-4000-8000-000000007304",
    "123456789012345678901",
    " 123",
    "../1",
    42,
    null,
  ])
    assert.equal(isAccountId(bad), false, String(bad));
  // New IDs never look like a Telegram ID.
  assert.match(newAccountId(), /^a_/);
  // The unanchored part used in routes matches whole IDs only when anchored by the route.
  const route = new RegExp(`^/api/lists/(${ACCOUNT_ID_PART})$`);
  assert.equal(route.exec("/api/lists/42")?.[1], "42");
  assert.equal(route.test("/api/lists/a_1"), false);
  assert.equal(route.test("/api/lists/42/x"), false);
});
