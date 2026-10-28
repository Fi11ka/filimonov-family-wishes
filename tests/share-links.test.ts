import { test } from "node:test";
import assert from "node:assert/strict";
import { shareLink, siteProfileLink } from "../src/share-links";
test("the profile link always leads to the site, without launch data or a guest token", () => {
  assert.equal(
    siteProfileLink(
      "https://family.example/app/?tgWebAppData=x#guest=y",
      "a_1",
    ),
    "https://family.example/app/?p=a_1",
  );
});
test("sharing goes through the system menu; closing it is not a success; no menu means copying", async () => {
  const sent: unknown[] = [];
  const ok = { share: async (d: unknown) => void sent.push(d) } as any;
  assert.equal(await shareLink("https://s/?p=1", "Мой вишлист", ok), "shared");
  assert.deepEqual(sent, [
    { title: "Вишлист", text: "Мой вишлист", url: "https://s/?p=1" },
  ]);
  const closed = {
    share: async () => {
      throw Object.assign(new Error("closed"), { name: "AbortError" });
    },
  } as any;
  assert.equal(await shareLink("https://s", "", closed), "cancelled");
  const denied = {
    share: async () => {
      throw Object.assign(new Error("no gesture"), { name: "NotAllowedError" });
    },
  } as any;
  assert.equal(await shareLink("https://s", "", denied), "unavailable");
  assert.equal(await shareLink("https://s", "", {} as any), "unavailable");
  assert.equal(await shareLink("https://s", "", undefined), "unavailable");
});
