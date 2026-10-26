import { test } from "node:test";
import assert from "node:assert/strict";
import {
  averagePriceMinor,
  comparePrice,
  priceInRubMinor,
} from "../shared/wish-price";

const price = (
  min: number | null,
  currency = "RUB",
  max: number | null = null,
) => ({ price_minor: min, price_max_minor: max, currency });

test("closed price ranges use their midpoint", () => {
  assert.equal(averagePriceMinor(price(100_00, "RUB", 300_00)), 200_00);
  assert.equal(averagePriceMinor(price(100_00)), 100_00);
  assert.equal(averagePriceMinor(price(null, "RUB", 300_00)), 300_00);
  assert.equal(averagePriceMinor(price(null)), null);
});

test("prices are normalized to approximate rubles", () => {
  assert.equal(priceInRubMinor(price(10_00, "EUR")), 1_000_00);
  assert.equal(priceInRubMinor(price(10_00, "USD")), 900_00);
  assert.equal(priceInRubMinor(price(1_000_00, "KZT")), 180_00);
  assert.equal(priceInRubMinor(price(10_00, "UNKNOWN")), null);
});

test("sorting compares currencies and ranges by normalized average price", () => {
  const cheapRange = price(5_00, "EUR", 15_00); // 1 000 RUB
  const expensiveNominal = price(2_000_00, "KZT"); // 360 RUB
  assert.ok(comparePrice(cheapRange, expensiveNominal, 1) > 0);
  assert.ok(comparePrice(cheapRange, expensiveNominal, -1) < 0);
  assert.ok(comparePrice(price(null), cheapRange, 1) > 0);
  assert.ok(comparePrice(price(null), cheapRange, -1) > 0);
});
