import assert from "node:assert/strict";
import test from "node:test";
import { calculateChalongBirthdayPackageRevenue } from "./papaya";

test("includes an override-only reception birthday day", () => {
  assert.equal(
    calculateChalongBirthdayPackageRevenue(
      [],
      [{ date: "2026-03-01", terminal: "reception", partyTotal: 16_700 }],
    ),
    16_700,
  );
});

test("uses the reception override once when only the restaurant has raw orders", () => {
  assert.equal(
    calculateChalongBirthdayPackageRevenue(
      [
        {
          date: "2026-03-15",
          terminal: "restaurant",
          packageRevenue: 2_500,
        },
      ],
      [{ date: "2026-03-15", terminal: "reception", partyTotal: 5_000 }],
    ),
    7_500,
  );
});

test("replaces raw package revenue for the same date and terminal", () => {
  assert.equal(
    calculateChalongBirthdayPackageRevenue(
      [
        {
          date: "2026-03-27",
          terminal: "reception",
          packageRevenue: 10_000,
        },
        {
          date: "2026-03-27",
          terminal: "restaurant",
          packageRevenue: 1_500,
        },
      ],
      [{ date: "2026-03-27", terminal: "reception", partyTotal: 12_000 }],
    ),
    13_500,
  );
});