// seed: full
import { test, expect } from "@playwright/test";
import { db } from "../server/db";
import {
  branches,
  departments,
  employeeRoles,
  employees,
  roles,
  scheduleShiftRowRoles,
  scheduleShiftRows,
  shiftGroups,
  tenants,
  users,
} from "../shared/schema";
import { eq } from "drizzle-orm";
import { login, testId } from "./helpers";

/**
 * Regression test: In the Employees scheduling view, the + button on an
 * employee's row must only offer shifts that belong to that employee's
 * own department.
 */

test("employees view + popover must not show shifts from a different department", async ({
  page,
}) => {
  const suffix = testId();
  const [tenant] = await db.select().from(tenants).limit(1);
  const [admin] = await db.select().from(users).where(eq(users.email, "admin@example.com")).limit(1);
  const [branch] = await db.select().from(branches).where(eq(branches.name, "Bangkok")).limit(1);
  const existingDepartments = await db.select().from(departments).where(eq(departments.tenantId, tenant.id)).limit(2);
  const [ownDepartment, otherDepartment] = existingDepartments;
  const [role] = await db.select().from(roles).where(eq(roles.tenantId, tenant.id)).limit(1);

  expect(branch, "Full seed should include a branch").toBeTruthy();
  expect(ownDepartment, "Full seed should include departments").toBeTruthy();
  expect(otherDepartment, "Full seed should include at least two departments").toBeTruthy();
  expect(role, "Full seed should include roles").toBeTruthy();

  const employeeName = `Cross Dept ${suffix}`;
  const employeeNickname = `CD${suffix}`;
  const forbiddenShiftLabel = `Forbidden Cross Dept ${suffix}`;

  const [employee] = await db.insert(employees).values({
    tenantId: tenant.id,
    branchId: branch.id,
    primaryDepartmentId: ownDepartment.id,
    fullName: employeeName,
    nickname: employeeNickname,
    email: `cross-dept-${suffix}@example.com`,
    status: "active",
    employmentState: "ACTIVE",
    startDate: new Date(),
  }).returning();

  await db.insert(employeeRoles).values({
    employeeId: employee.id,
    roleId: role.id,
    isPrimary: true,
  });

  const [group] = await db.insert(shiftGroups).values({
    tenantId: tenant.id,
    branchId: branch.id,
    name: `CrossDeptGroup-${suffix}`,
    sortOrder: 999,
    isActive: true,
    createdBy: admin.id,
  }).returning();

  const [shiftRow] = await db.insert(scheduleShiftRows).values({
    tenantId: tenant.id,
    branchId: branch.id,
    departmentId: otherDepartment.id,
    shiftGroupId: group.id,
    label: forbiddenShiftLabel,
    startTime: "09:00",
    endTime: "17:00",
    staffRequired: 1,
    rowOrder: 999,
    createdBy: admin.id,
  }).returning();

  await db.insert(scheduleShiftRowRoles).values({
    tenantId: tenant.id,
    shiftRowId: shiftRow.id,
    roleId: role.id,
  });

  await login(page);

  await page.goto("/scheduling");
  await page.waitForLoadState("networkidle");

  const branchSelector = page.getByTestId("branch-selector-trigger");
  await expect(branchSelector).toBeVisible({ timeout: 10000 });
  await branchSelector.click();
  await page
    .locator("[data-testid^='branch-option-branch-']", { hasText: branch.name })
    .click();
  await page.waitForLoadState("networkidle");

  await page.getByTestId("button-view-employees").click();
  await page.waitForTimeout(500);

  const employeeInfoButton = page
    .getByTestId(/^button-employee-info-/)
    .filter({ hasText: employeeNickname })
    .first();
  await expect(employeeInfoButton).toBeVisible({ timeout: 10000 });

  const employeeTestId = await employeeInfoButton.getAttribute("data-testid");
  const employeeId = employeeTestId!.replace("button-employee-info-", "");

  const addButton = page
    .locator(`[data-testid^='button-add-action-${employeeId}-']`)
    .first();
  await expect(addButton).toBeVisible({ timeout: 10000 });
  await addButton.click();

  await page.waitForTimeout(400);

  await expect(
    page.locator("button", { hasText: forbiddenShiftLabel }),
    "A shift from a different department must not appear in the employee + popover, even when the role matches."
  ).not.toBeVisible();
});
