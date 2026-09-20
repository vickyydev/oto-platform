// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: Admin users logging in on a fresh device (no stored branch
 * preference in localStorage) should see tasks from ALL branches by default.
 *
 * Bug: use-branch-context.tsx step 6 auto-selects branches[0].id and stores
 * it in localStorage when no prior selection exists. This causes the tasks API
 * to be called with branchId=<firstBranch>, filtering out tasks from all other
 * branches. On a laptop where the user previously chose "All Branches" it works
 * fine, but on a fresh phone session the narrower default makes tasks invisible.
 *
 * Demonstration:
 *   - Task T exists in branch2 (the non-first branch)
 *   - Admin clears their localStorage (simulating a fresh device)
 *   - Admin reloads and navigates to /tasks
 *   - Task T should be visible (admin sees all branches)
 *   → With the bug present the assertion FAILS (branch2 task is hidden)
 *   → After the fix the assertion PASSES (admin defaults to All Branches)
 */

test("admin on a fresh device sees tasks from all branches by default", async ({
  page,
}) => {
  await login(page);

  // ── 1. Find the two branches ─────────────────────────────────────────────
  const branches = await page.evaluate(async () => {
    let existing = await fetch("/api/branches").then((r) => r.json());
    if (existing.length < 2) {
      const suffix = Date.now();
      await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Fresh Device Branch ${suffix}`,
          address: `${suffix} Test Street`,
        }),
      });
      existing = await fetch("/api/branches").then((r) => r.json());
    }
    return existing;
  });
  expect(branches.length, "Need at least 2 branches").toBeGreaterThanOrEqual(2);

  // branches[0] will be auto-selected on fresh device; we need a task in branches[1]
  const branch1 = branches[0];
  const branch2 = branches[1];
  expect(branch1.id).not.toBe(branch2.id);

  // ── 2. Create a distinctive task in branch2 ───────────────────────────────
  const marker = `FRESH_DEVICE_TASK_${Date.now()}`;
  const dueAt = new Date(Date.now() + 2 * 86400_000).toISOString().split("T")[0];

  const task = await page.evaluate(
    ([bid, title, due]: string[]) =>
      fetch("/api/core/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          branchIds: [bid],
          recurrence: "once",
          dueAt: due,
        }),
      }).then((r) => r.json()),
    [branch2.id, marker, dueAt]
  );
  expect(task.id, "Task should be created in branch2").toBeTruthy();

  // ── 3. Simulate a fresh device by clearing the branch preference ──────────
  await page.evaluate(() => localStorage.removeItem("oto_active_branch_id"));

  // ── 4. Reload to trigger auto-selection logic ─────────────────────────────
  await page.reload();
  await page.waitForLoadState("networkidle");

  // ── 5. Navigate to the Ops page where core tasks are listed ────────────────
  await page.goto("/ops");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // ── 6. The branch2 task must be visible ───────────────────────────────────
  //    Without the fix: branch1 is auto-selected → branch2 task is filtered out
  //    With the fix: admin defaults to All Branches → branch2 task is visible
  await expect(
    page.getByText(marker).first(),
    `Task in branch2 ("${branch2.name}") should be visible when admin has no stored branch preference. ` +
      `The auto-selected branch context should default to "All Branches" for admin users, not "${branch1.name}".`
  ).toBeVisible({ timeout: 8000 });
});
