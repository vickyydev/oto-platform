// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: getBorrowCandidates must return cross-branch candidates
 * even when the destination branch has no operatorId configured.
 *
 * Bug: getBorrowCandidates immediately returns [] when destBranch.operatorId
 * is null. Single-company setups that haven't configured the "Operators"
 * feature have operatorId = null on all branches, making cross-branch staff
 * borrowing silently impossible.
 *
 * Demonstration:
 *   - Branch A exists with active employees
 *   - Branch B is created WITHOUT an operatorId (simulating a single-operator setup)
 *   - Branch B has a shift row
 *   - Call borrow-candidates for that shift row with branchId = Branch B
 *   - Should return candidates from Branch A
 *   → With the bug the response is [] (empty because operatorId check fails)
 *   → After the fix candidates from Branch A are returned
 */

test("borrow candidates are found even when the destination branch has no operatorId", async ({
  page,
}) => {
  await login(page);

  // ── 1. Get an existing branch (it has active employees we can borrow) ─────
  const branches = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json())
  );
  expect(branches.length).toBeGreaterThan(0);
  const sourceBranch = branches[0]; // has employees; we will borrow FROM this branch

  // ── 2. Create a NEW branch WITHOUT an operatorId ──────────────────────────
  //    This simulates a single-company setup where operators haven't been configured.
  const ts = Date.now();
  const newBranch = await page.evaluate(
    ([name, addr]: string[]) =>
      fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, address: addr }),
        // operatorId intentionally omitted → null
      }).then((r) => r.json()),
    [`NoBranchOp-${ts}`, `Test Street ${ts}`]
  );
  expect(newBranch.id, "New branch should be created").toBeTruthy();
  expect(
    newBranch.operatorId,
    "New branch should have no operatorId"
  ).toBeFalsy();

  // ── 3. Create a shift group in the new branch ─────────────────────────────
  const shiftGroup = await page.evaluate(
    ([bid, name]: string[]) =>
      fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, name }),
      }).then((r) => r.json()),
    [newBranch.id, `BorrowTest-${ts}`]
  );
  expect(shiftGroup.id, "Shift group should be created").toBeTruthy();

  // ── 4. Create a shift row in the new branch ───────────────────────────────
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
          label: "BorrowTest Shift",
          staffRequired: 1,
        }),
      }).then((r) => r.json()),
    [newBranch.id, shiftGroup.id]
  );
  expect(shiftRow.id, "Shift row should be created").toBeTruthy();

  // ── 5. Call borrow-candidates for the new branch's shift ──────────────────
  //    destinationBranchId = newBranch.id (has no operatorId → currently fails)
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const futureDateStr = futureDate.toISOString().split("T")[0];

  const result: { id: string; name: string }[] | { candidates: unknown[] } =
    await page.evaluate(
      ([rowId, date, destBid]: string[]) =>
        fetch(
          `/api/schedule/shift-rows/${rowId}/borrow-candidates?date=${date}&branchId=${destBid}`
        ).then((r) => r.json()),
      [shiftRow.id, futureDateStr, newBranch.id]
    );

  // ── 6. The response must contain candidates from the source branch ─────────
  //    Without the fix: result is [] (empty array — operatorId guard killed it)
  //    With the fix: result contains employees from sourceBranch
  //
  //    NOTE: the response may be the legacy bare array OR the new
  //    { candidates, hasSiblingBranches } shape. Handle both.
  const candidates: unknown[] = Array.isArray(result)
    ? result
    : (result as { candidates: unknown[] }).candidates ?? [];

  expect(
    candidates.length,
    `borrow-candidates for a branch with no operatorId returned an empty list. ` +
      `Expected to find employees from "${sourceBranch.name}" as borrow candidates. ` +
      `The current code returns [] when destBranch.operatorId is null, which breaks ` +
      `cross-branch staff borrowing for single-operator setups.`
  ).toBeGreaterThan(0);
});
