import { test } from "node:test";
import assert from "node:assert/strict";
import { LookupState } from "../src/lookup-state";
const empty = { title: true, price: true, photo: true };
test("editing during a lookup preserves the edited field while other empty fields may fill", () => {
  const state = new LookupState(),
    pending = state.begin(empty);
  state.edit("price");
  assert.equal(pending.canApply("price"), false);
  assert.equal(pending.canApply("title"), true);
  state.edit("title");
  state.edit("photo");
  assert.equal(pending.canApply("title"), false);
  assert.equal(pending.canApply("photo"), false);
});
test("URL changes, retries and unmounting invalidate every phase of the old request", () => {
  const state = new LookupState(),
    old = state.begin(empty);
  state.invalidate(); // URL changed during the debounce period, before a new fetch starts.
  assert.equal(old.current(), false);
  assert.equal(old.canApply("photo"), false);
  const next = state.begin(empty),
    retry = state.begin(empty);
  assert.equal(next.current(), false);
  assert.equal(retry.current(), true);
  state.invalidate();
  assert.equal(retry.canApply("title"), false);
});
test("a retry cannot overwrite existing manual fields, and late photos cannot reclaim them", async () => {
  const state = new LookupState();
  const pending = state.begin({ title: false, price: false, photo: true });
  let release!: () => void;
  const download = new Promise<void>((resolve) => {
    release = resolve;
  });
  let photo = "manual-photo";
  const apply = download.then(() => {
    if (pending.canApply("photo")) photo = "shop-photo";
  });
  state.edit("photo");
  release();
  await apply;
  assert.equal(photo, "manual-photo");
  assert.equal(pending.canApply("title"), false);
  assert.equal(pending.canApply("price"), false);
});
