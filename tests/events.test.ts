import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysLeft,
  eventSpecs,
  isUpcoming,
  upcomingEvents,
} from "../shared/events";
import { sharePrice } from "../shared/price";
test("default events depend on birthday and gender; nearest comes first", () => {
  const today = new Date(2026, 9, 26);
  const specs = eventSpecs({
    birthday: "11-12",
    gender: "female",
    event_title: "Новоселье",
    event_date: "2026-11-01",
  });
  assert.deepEqual(
    upcomingEvents(specs, today).map((e) => [e.key, e.date, e.days]),
    [
      ["custom", "2026-11-01", 6],
      ["birthday", "2026-11-12", 17],
      ["new_year", "2027-01-01", 67],
      ["march8", "2027-03-08", 133],
    ],
  );
  assert.deepEqual(
    eventSpecs({ gender: "male" }).map((e) => e.key),
    ["new_year", "feb23"],
  );
  // A past event of one's own disappears; today still counts.
  assert.equal(
    upcomingEvents(
      eventSpecs({ event_title: "x", event_date: "2026-10-25" }),
      today,
    ).length,
    1,
  );
  assert.equal(
    upcomingEvents(eventSpecs({ birthday: "10-26" }), today)[0].days,
    0,
  );
  assert.ok(isUpcoming(specs, "birthday", "2026-11-12", today.getTime()));
  assert.ok(!isUpcoming(specs, "birthday", "2027-11-12", today.getTime()));
});
test("days left and a share of a shared gift", () => {
  assert.equal(daysLeft(1), "остался 1 день");
  assert.equal(daysLeft(3), "осталось 3 дня");
  assert.equal(daysLeft(11), "осталось 11 дней");
  assert.equal(daysLeft(0), "сегодня");
  assert.equal(
    sharePrice({ price_minor: 900000, currency: "RUB" }, 3).replace(/\s/g, " "),
    "3 000 ₽",
  );
  assert.equal(
    sharePrice(
      { price_minor: 600000, price_max_minor: 900000, currency: "RUB" },
      3,
    ).replace(/\s/g, " "),
    "2 000 ₽ – 3 000 ₽",
  );
  assert.equal(
    sharePrice(
      { price_minor: 1000, price_range: 1, currency: "EUR" },
      3,
    ).replace(/\s/g, " "),
    "от 3,33 €",
  );
});
