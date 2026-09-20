// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: GET /api/schedule/shift-rows/:id/borrow-candidates must
 * return a structured object { candidates, hasSiblingBranches } rather than
 * a bare array.
 *
 * Bug: the route calls storage.getBorrowCandidates() and passes the result
 * straight to res.json(), which serialises it as a JSON array. The
 * BorrowStaffModal client reads this as a typed array and has no way to
 * distinguish "no candidates because no sibling branches exist" (config error)
 * from "no candidates because everyone is unavailable". Both states produce an
 * identical empty array, so the user sees a silent blank modal.
 *
 * Demonstration:
 *   - Call the borrow-candidates endpoint for any shift row
 *   - Assert that the response JSON is an *object* with a "candidates" key
 *   → With the bug the assertion FAILS (response is a bare array)
 *   → After the fix the assertion PASSES ({ candidates, hasSiblingBranches })
 */

test("borrow-candidates endpoint returns { candidates, hasSiblingBranches } not a bare array", async ({
  page,
}) => {
  await login(page);

  // ── 1. Get a shift row to query ───────────────────────────────────────────
  const branches = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json())
  );
  const branchId: string = branches[0].id;

  const ts = Date.now();

  const group = await page.evaluate(
    ([bid, name]: string[]) =>
      fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, name }),
      }).then((r) => r.json()),
    [branchId, `BorrowShape-${ts}`]
  );

  const shiftRow = await page.evaluate(
    ([bid, sgId]: string[]) =>
      fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          shiftGroupId: sgId,
          startTime: "09:00",
          endTime: "18:00",
          label: "BorrowShape Shift",
          staffRequired: 1,
        }),
      }).then((r) => r.json()),
    [branchId, group.id]
  );
  expect(shiftRow.id).toBeTruthy();

  // ── 2. Call the borrow-candidates endpoint ────────────────────────────────
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const futureDateStr = futureDate.toISOString().split("T")[0];

  const response = await page.evaluate(
    ([rowId, date, bid]: string[]) =>
      fetch(
        `/api/schedule/shift-rows/${rowId}/borrow-candidates?date=${date}&branchId=${bid}`
      ).then((r) => r.json()),
    [shiftRow.id, futureDateStr, branchId]
  );

  // ── 3. Assert the response is an object with expected keys ────────────────
  //    Without the fix: response is a plain JSON array — Array.isArray() is true
  //    and response.candidates is undefined.
  expect(
    Array.isArray(response),
    `Response should be an object { candidates, hasSiblingBranches }, not a bare array. ` +
      `Got: ${JSON.stringify(response).slice(0, 200)}`
  ).toBe(false);

  expect(
    "candidates" in response,
    `Response must have a "candidates" key. Got keys: ${Object.keys(response)}`
  ).toBe(true);

  expect(
    "hasSiblingBranches" in response,
    `Response must have a "hasSiblingBranches" key. Got keys: ${Object.keys(response)}`
  ).toBe(true);

  expect(Array.isArray(response.candidates)).toBe(true);
  expect(typeof response.hasSiblingBranches).toBe("boolean");
});
