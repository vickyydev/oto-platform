// seed: full
import { test, expect } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import {
  branches,
  DEFAULT_TENANT_SLUG,
  fixReports,
  tenants,
  users,
} from "../shared/schema";
import { login } from "./helpers";

test("global admin Fix Board honors an explicit branch and restores all branches", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const titlePrefix = `Fix branch regression ${suffix}`;
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "admin@example.com"))
    .limit(1);
  const availableBranches = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(eq(branches.tenantId, tenant.id))
    .limit(2);

  expect(tenant, "Full seed should include the default tenant").toBeTruthy();
  expect(admin, "Full seed should include the global admin").toBeTruthy();
  expect(availableBranches, "Full seed should include at least two branches").toHaveLength(2);

  const [selectedBranch, otherBranch] = availableBranches;
  const seededReports = await db
    .insert(fixReports)
    .values([
      {
        tenantId: tenant.id,
        branchId: selectedBranch.id,
        reportedBy: admin.id,
        title: `${titlePrefix} pending`,
        location: "Regression test",
        status: "pending",
      },
      {
        tenantId: tenant.id,
        branchId: selectedBranch.id,
        reportedBy: admin.id,
        title: `${titlePrefix} in progress`,
        location: "Regression test",
        status: "in_progress",
      },
      {
        tenantId: tenant.id,
        branchId: selectedBranch.id,
        reportedBy: admin.id,
        title: `${titlePrefix} completed`,
        location: "Regression test",
        status: "done",
      },
      {
        tenantId: tenant.id,
        branchId: otherBranch.id,
        reportedBy: admin.id,
        title: `${titlePrefix} other branch`,
        location: "Regression test",
        status: "pending",
      },
    ])
    .returning({ id: fixReports.id });

  try {
    await login(page);

    const selectedResponse = await page.request.get(
      `/api/fix-reports?branchId=${selectedBranch.id}`,
    );
    expect(selectedResponse.status()).toBe(200);
    const selectedReports = (await selectedResponse.json()) as Array<{
      title: string;
      branchId: string;
      status: string;
    }>;
    const selectedSeededReports = selectedReports.filter((report) =>
      report.title.startsWith(titlePrefix),
    );

    expect(selectedSeededReports).toHaveLength(3);
    expect(selectedSeededReports.every((report) => report.branchId === selectedBranch.id)).toBe(true);
    expect({
      pending: selectedSeededReports.filter((report) => ["new", "pending"].includes(report.status)).length,
      inProgress: selectedSeededReports.filter((report) => ["in_progress", "acknowledged"].includes(report.status)).length,
      completed: selectedSeededReports.filter((report) => ["done", "completed"].includes(report.status)).length,
    }).toEqual({ pending: 1, inProgress: 1, completed: 1 });

    const allResponse = await page.request.get("/api/fix-reports");
    expect(allResponse.status()).toBe(200);
    const allReports = (await allResponse.json()) as Array<{ title: string; branchId: string }>;
    const allSeededReports = allReports.filter((report) => report.title.startsWith(titlePrefix));

    expect(allSeededReports).toHaveLength(4);
    expect(new Set(allSeededReports.map((report) => report.branchId))).toEqual(
      new Set([selectedBranch.id, otherBranch.id]),
    );

    await page.goto("/core/fix");
    await page.getByTestId("select-branch").click();
    const selectedBranchRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/fix-reports"
        && url.searchParams.get("branchId") === selectedBranch.id;
    });
    await page.getByRole("option", { name: selectedBranch.name }).click();
    await selectedBranchRequest;

    await page.getByTestId("select-branch").click();
    const allBranchesRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/fix-reports"
        && !url.searchParams.has("branchId");
    });
    await page.getByRole("option", { name: "All Branches" }).click();
    await allBranchesRequest;
  } finally {
    await db
      .delete(fixReports)
      .where(and(
        eq(fixReports.tenantId, tenant.id),
        inArray(fixReports.id, seededReports.map((report) => report.id)),
      ));
  }
});
