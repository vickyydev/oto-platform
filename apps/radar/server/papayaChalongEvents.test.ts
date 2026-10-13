import assert from "node:assert/strict";
import test from "node:test";
import { buildChalongEventRow } from "./papaya";

function order(
  total: number,
  billTotal: number,
  items: Array<{ name: string; itemTotal: number; status?: string }>,
) {
  return { status: "complete", total, billTotal, items };
}

const metadata = (id: string, date: string) => ({
  id,
  terminal: "reception",
  orderDate: `${date}T12:00:00+07:00`,
  orderNumber: id.toUpperCase(),
});

test("allocates a discounted birthday order in cents and includes extras", () => {
  const event = buildChalongEventRow(
    order(12_500, 14_500, [
      { name: "Birthday Package", itemTotal: 12_000, status: "confirmed" },
      { name: "Pinata", itemTotal: 2_500, status: "confirmed" },
      { name: "Free Socks", itemTotal: 0, status: "confirmed" },
    ]),
    metadata("aug2", "2026-08-02"),
  );

  assert.ok(event);
  assert.equal(event.totalRevenue, 12_500);
  assert.equal(event.packageRevenue + event.fnbRevenue + event.otherRevenue, 12_500);
  assert.equal(event.packageName, "Birthday Package");
  assert.equal(event.partyOrderId, "reception:aug2");
  assert.equal(event.packageRevenue, 10_344.83);
  assert.equal(event.otherRevenue, 2_155.17);
  assert.deepEqual(event.entertainmentItems.map((item) => item.name), ["Pinata", "Free Socks"]);
});

test("uses the fallback title when package lines are generic", () => {
  const event = buildChalongEventRow(
    order(15_620, 15_620, [
      { name: "1 Kid", itemTotal: 3_300, status: "confirmed" },
      { name: "Parent Restaurant Credit", itemTotal: 1_080, status: "confirmed" },
      { name: "Games", itemTotal: 9_000, status: "confirmed" },
      { name: "Pinata", itemTotal: 2_000, status: "confirmed" },
      { name: "Socks", itemTotal: 240, status: "confirmed" },
    ]),
    metadata("aug21", "2026-08-21"),
  );

  assert.ok(event);
  assert.equal(event.packageName, "Birthday party");
  assert.equal(event.totalRevenue, 15_620);
  assert.equal(event.packageRevenue + event.fnbRevenue + event.otherRevenue, 15_620);
  assert.equal(event.otherRevenue, 11_240);
});

test("excludes cancelled lines from both totals and entertainment detail", () => {
  const event = buildChalongEventRow(
    order(5_190, 5_190, [
      { name: "1 Kid", itemTotal: 4_950, status: "confirmed" },
      { name: "Socks", itemTotal: 240, status: "confirmed" },
      { name: "Cancelled Game", itemTotal: 4_400, status: "cancelled" },
    ]),
    metadata("aug26", "2026-08-26"),
  );

  assert.ok(event);
  assert.equal(event.totalRevenue, 5_190);
  assert.equal(event.packageRevenue + event.fnbRevenue + event.otherRevenue, 5_190);
  assert.equal(event.otherRevenue, 240);
  assert.equal(event.entertainmentItems.some((item) => item.name === "Cancelled Game"), false);
});

test("keeps active Bubble Show upgrade as entertainment and excludes cancelled lines", () => {
  const event = buildChalongEventRow(
    order(19_400, 19_400, [
      { name: "Birthday Package", itemTotal: 4_260, status: "confirmed" },
      { name: "1 Kid", itemTotal: 8_640, status: "confirmed" },
      { name: "Photozone", itemTotal: 3_000, status: "confirmed" },
      { name: "Bubble Show upgrade", itemTotal: 3_500, status: "confirmed" },
      { name: "Cancelled Package", itemTotal: 9_500, status: "cancelled" },
    ]),
    metadata("aug29", "2026-08-29"),
  );

  assert.ok(event);
  assert.equal(event.packageName, "Birthday Package");
  assert.equal(event.packageRevenue, 12_900);
  assert.equal(event.otherRevenue, 6_500);
  assert.equal(event.totalRevenue, 19_400);
  assert.equal(event.packageRevenue + event.fnbRevenue + event.otherRevenue, event.totalRevenue);
  assert.deepEqual(event.entertainmentItems.map((item) => item.name), ["Bubble Show upgrade", "Photozone"]);
});

test("treats an explicit zero total as authoritative", () => {
  const event = buildChalongEventRow(
    order(0, 100, [{ name: "Birthday Package", itemTotal: 100, status: "confirmed" }]),
    metadata("zero", "2026-08-30"),
  );

  assert.ok(event);
  assert.equal(event.totalRevenue, 0);
  assert.equal(event.reconciliationRevenue, undefined);
  assert.equal(event.packageRevenue, 0);
  assert.equal(event.packageRevenue + event.fnbRevenue + event.otherRevenue, 0);
});

test("exposes an unmatched bill amount without silently changing known lines", () => {
  const event = buildChalongEventRow(
    order(150, 200, [{ name: "Birthday Package", itemTotal: 100, status: "confirmed" }]),
    metadata("unmatched", "2026-08-30"),
  );
  assert.ok(event);
  assert.equal(event.packageRevenue, 100);
  assert.equal(event.otherRevenue, 50);
  assert.equal(event.reconciliationRevenue, 50);
  assert.equal(event.totalRevenue, 150);
});

test("excludes cancelled orders and distinguishes terminal identities", () => {
  const sample = order(100, 100, [{ name: "Birthday Package", itemTotal: 100 }]);
  assert.equal(buildChalongEventRow({ ...sample, status: "cancelled" }, metadata("same", "2026-08-30")), null);
  const reception = buildChalongEventRow(sample, metadata("same", "2026-08-30"));
  const restaurant = buildChalongEventRow(sample, { ...metadata("same", "2026-08-30"), terminal: "restaurant" });
  assert.notEqual(reception?.partyOrderId, restaurant?.partyOrderId);
});

test("keeps restaurant food separate from entertainment and unspent credit", () => {
  const event = buildChalongEventRow(
    order(300, 300, [
      { name: "Bubble Tea", itemTotal: 50 },
      { name: "Birthday Cake", itemTotal: 150 },
      { name: "Parent Restaurant Credit", itemTotal: 100 },
    ]),
    { ...metadata("cafe", "2026-08-30"), terminal: "restaurant" },
  );
  assert.ok(event);
  assert.equal(event.fnbRevenue, 200);
  assert.equal(event.packageRevenue, 100);
  assert.equal(event.otherRevenue, 0);
  assert.equal(event.packageName, "Birthday party");
});
