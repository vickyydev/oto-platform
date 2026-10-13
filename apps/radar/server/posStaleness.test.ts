import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStaleness, STALE_THRESHOLD_MINUTES, BRANCH_CONFIG } from "./posStaleness";

const HOURS = { openHour: 10, closeHour: 20 }; // 10:00–20:00 Bangkok
const min = (h: number, m = 0) => h * 60 + m;

test("branch config uses the published 10:00–20:00 operating hours", () => {
  for (const cfg of BRANCH_CONFIG) {
    assert.equal(cfg.openHour, 10);
    assert.equal(cfg.closeHour, 20);
  }
  assert.equal(STALE_THRESHOLD_MINUTES, 120);
});

test("no alert before opening, even with a stale last order from context", () => {
  assert.equal(evaluateStaleness(HOURS, min(8), null), false);
  assert.equal(evaluateStaleness(HOURS, min(9, 59), null), false);
});

test("no alert during the first 2 hours after opening (slow-morning grace)", () => {
  assert.equal(evaluateStaleness(HOURS, min(10), null), false);
  assert.equal(evaluateStaleness(HOURS, min(11, 59), null), false);
});

test("alerts at open + threshold when no orders have arrived all morning", () => {
  assert.equal(evaluateStaleness(HOURS, min(12), null), true);
  assert.equal(evaluateStaleness(HOURS, min(15), null), true);
});

test("no alert while orders keep flowing", () => {
  // last order 30 minutes ago mid-day
  assert.equal(evaluateStaleness(HOURS, min(14), min(13, 30)), false);
  // gap just under the threshold
  assert.equal(evaluateStaleness(HOURS, min(15), min(13, 1)), false);
});

test("alerts on a mid-day gap at/over the threshold (Aug 2 scenario: last order 13:00)", () => {
  assert.equal(evaluateStaleness(HOURS, min(15), min(13)), true); // exactly 2h
  assert.equal(evaluateStaleness(HOURS, min(17, 30), min(13)), true);
});

test("no alert at/after closing time even with a large gap", () => {
  assert.equal(evaluateStaleness(HOURS, min(20), min(13)), false);
  assert.equal(evaluateStaleness(HOURS, min(22), null), false);
});

test("pre-opening staff/test orders don't suppress the zero-activity alert", () => {
  // last order 08:30 (before open) — gap measured from opening time
  assert.equal(evaluateStaleness(HOURS, min(11, 59), min(8, 30)), false);
  assert.equal(evaluateStaleness(HOURS, min(12), min(8, 30)), true);
});
