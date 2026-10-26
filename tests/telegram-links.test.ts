import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closesAfterSwitch,
  profileLink,
  telegramAppLink,
} from "../src/telegram-links";
test("the default family link targets the Main Mini App, not just the bot chat", () => {
  assert.equal(
    telegramAppLink(),
    "https://t.me/FilimonovFamilyWishes_bot?startapp",
  );
});
test("guest links and profiles survive the browser-to-Telegram transition", () => {
  const token = "A".repeat(43);
  assert.equal(
    new URL(telegramAppLink(`g_${token}`)).searchParams.get("startapp"),
    `g_${token}`,
  );
  assert.equal(
    new URL(profileLink("a_1")).searchParams.get("startapp"),
    "p_a_1",
  );
});
test("a crafted parameter cannot change the destination or add Telegram actions", () => {
  const url = new URL(telegramAppLink("g_token&domain=evil&start=other"));
  assert.equal(url.origin, "https://t.me");
  assert.equal(url.pathname, "/FilimonovFamilyWishes_bot");
  assert.deepEqual([...url.searchParams.keys()], ["startapp"]);
  assert.equal(
    url.searchParams.get("startapp"),
    "g_token&domain=evil&start=other",
  );
});
test("«В браузере» closes the Mini App except in Telegram Web", () => {
  for (const p of [
    "android",
    "ios",
    "tdesktop",
    "macos",
    "unigram",
    "unknown",
    "",
  ])
    assert.equal(closesAfterSwitch(p), true, p);
  for (const p of ["web", "weba", "webk"])
    assert.equal(closesAfterSwitch(p), false, p);
  assert.equal(closesAfterSwitch(), true);
});
