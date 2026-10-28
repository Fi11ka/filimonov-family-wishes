import { test } from "node:test";
import assert from "node:assert/strict";
import { freshness } from "../shared/freshness";
test("a confirmation is fresh for 30 days to the second, then stale; none is never", () => {
  const at = 1_800_000_000;
  const day = 86400_000;
  assert.equal(freshness(null), "never");
  assert.equal(freshness(at, at * 1000 + 29 * day), "fresh");
  assert.equal(freshness(at, at * 1000 + 30 * day), "fresh");
  assert.equal(freshness(at, at * 1000 + 30 * day + 1000), "stale");
});
