import { test } from "node:test";
import assert from "node:assert/strict";
import { validBirthday, nextBirthday } from "../shared/birthday";

test("birthday validation accepts calendar dates without collecting the birth year", () => {
  for (const birthday of ["01-01", "12-31", "02-29"])
    assert.equal(validBirthday(birthday), true);
  for (const birthday of [
    "02-30",
    "04-31",
    "13-01",
    "00-10",
    "01-00",
    "1-1",
    "2000-01-01",
    "",
    null,
    12,
  ])
    assert.equal(validBirthday(birthday), false);
});
test("countdown uses calendar days across year boundaries and DST", () => {
  assert.equal(nextBirthday("10-25", new Date(2026, 9, 25, 23, 59))?.days, 0);
  assert.equal(nextBirthday("10-26", new Date(2026, 9, 25, 23, 59))?.days, 1);
  assert.equal(nextBirthday("01-01", new Date(2026, 11, 31))?.days, 1);
  assert.equal(nextBirthday("10-24", new Date(2026, 9, 25))?.days, 364);
  assert.equal(nextBirthday("03-30", new Date(2026, 2, 28))?.days, 2);
  assert.equal(nextBirthday("bad"), null);
});
test("leap birthdays use February 28 in non-leap years and February 29 in leap years", () => {
  assert.equal(nextBirthday("02-29", new Date(2026, 1, 27))?.days, 1);
  assert.equal(nextBirthday("02-29", new Date(2026, 1, 28))?.days, 0);
  assert.equal(nextBirthday("02-29", new Date(2028, 1, 28))?.days, 1);
  assert.equal(nextBirthday("02-29", new Date(2028, 1, 29))?.days, 0);
});
