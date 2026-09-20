// seed: full
import { test, expect } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import {
  accessPolicies,
  branches,
  people,
  tenants,
  userBranchAccess,
  users,
} from "../shared/schema";
import {
  checklistRunItems,
  checklistRuns,
  checklistTemplateItems,
  checklistTemplates,
  fixReports,
} from "../server/db/coreSchema";
import { login, testId } from "./helpers";

test("checklist-linked Fix reports use the user's tenant and effective branch access", async ({ browser }) => {
  const suffix = testId();
  const password = "Password123!";
  const [seedAdmin] = await db.select({ password: users.password })
    .from(users)
    .where(eq(users.email, "admin@example.com"))
    .limit(1);
  const passwordHash = seedAdmin.password;
  const managerEmail = `fix-manager-${suffix}@example.test`;
  const advisorEmail = `fix-advisor-${suffix}@example.test`;

  const [tenant] = await db.insert(tenants).values({
    name: `Fix tenant ${suffix}`,
    slug: `fix-tenant-${suffix}`,
  }).returning();
  const [sourceBranch, staleBranch] = await db.insert(branches).values([
    {
      tenantId: tenant.id,
      name: `Fix source branch ${suffix}`,
      address: "Test source branch",
      timezone: "Asia/Bangkok",
    },
    {
      tenantId: tenant.id,
      name: `Fix stale branch ${suffix}`,
      address: "Test stale branch",
      timezone: "Asia/Bangkok",
    },
  ]).returning();
  const [manager, advisorUser] = await db.insert(users).values([
    {
      email: managerEmail,
      password: passwordHash,
      fullName: `Fix Manager ${suffix}`,
      role: "manager",
      mustChangePassword: false,
    },
    {
      email: advisorEmail,
      password: passwordHash,
      fullName: `Fix Advisor ${suffix}`,
      role: "advisor",
      mustChangePassword: false,
    },
  ]).returning();
  await db.insert(userBranchAccess).values([
    {
      tenantId: tenant.id,
      userId: manager.id,
      branchId: sourceBranch.id,
      accessScope: "selected_branches",
    },
    {
      // Deliberately stale: the advisor's effective access policy now points at
      // sourceBranch, while this legacy row still points at staleBranch.
      tenantId: tenant.id,
      userId: advisorUser.id,
      branchId: staleBranch.id,
      accessScope: "selected_branches",
    },
  ]);
  const [advisorPerson] = await db.insert(people).values({
    fullName: `Fix Advisor ${suffix}`,
    email: advisorEmail,
    personType: "ADVISOR",
    isActive: true,
  }).returning();
  await db.insert(accessPolicies).values({
    tenantId: tenant.id,
    personId: advisorPerson.id,
    accessLevel: "STAFF",
    modules: { core: true, hr: false, studio: false, events: false, ops: false, setup: false },
    branchScope: "SELECTED",
    branchIds: [sourceBranch.id],
    coreAccountEnabled: true,
    coreUserId: advisorUser.id,
    provisioningStatus: "SUCCESS",
  });

  const managerContext = await browser.newContext();
  const advisorContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  const advisorPage = await advisorContext.newPage();
  let templateId: string | undefined;
  let runId: string | undefined;
  let reportId: string | undefined;

  try {
    await login(managerPage, { email: managerEmail, password } as any);
    const templateResponse = await managerPage.request.post("/api/checklists/templates", {
      data: {
        name: `Fix-linked tenant checklist ${suffix}`,
        branchIds: [sourceBranch.id],
        recurrence: "once",
        checklistType: "operational",
        items: [{ title: `Tenant issue ${suffix}`, linkedToFix: true }],
      },
    });
    expect(templateResponse.status()).toBe(201);
    const template = await templateResponse.json();
    templateId = template.id;
    expect(template.tenantId).toBe(tenant.id);

    const runResponse = await managerPage.request.post("/api/checklist-runs/start", {
      data: { templateId, branchId: sourceBranch.id },
    });
    expect(runResponse.ok()).toBeTruthy();
    const run = await runResponse.json();
    runId = run.id;

    const managerRunResponse = await managerPage.request.get(`/api/checklist-runs/${runId}`);
    expect(managerRunResponse.ok()).toBeTruthy();
    const managerRun = await managerRunResponse.json();
    const runItem = managerRun.items[0];

    await login(advisorPage, { email: advisorEmail, password } as any);
    const sourceResponse = await advisorPage.request.get(`/api/fix-reports/checklist-source/${runItem.id}`);
    expect(sourceResponse.status()).toBe(200);

    const reportResponse = await advisorPage.request.post("/api/fix-reports", {
      data: {
        media: [`/api/files/fix-media/test-${suffix}.jpg`],
        title: "Server replaces this title",
        branchId: staleBranch.id,
        sourceChecklistRunItemId: runItem.id,
      },
    });
    expect(reportResponse.status()).toBe(201);
    const report = await reportResponse.json();
    reportId = report.id;
    expect(report.tenantId).toBe(tenant.id);
    expect(report.branchId).toBe(sourceBranch.id);

    const myReportsResponse = await advisorPage.request.get("/api/fix-reports?myReports=true");
    expect(myReportsResponse.ok()).toBeTruthy();
    expect(await myReportsResponse.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reportId })]),
    );

    const linkedRunResponse = await advisorPage.request.get(`/api/checklist-runs/${runId}`);
    expect(linkedRunResponse.ok()).toBeTruthy();
    const linkedRun = await linkedRunResponse.json();
    expect(linkedRun.items[0].linkedFixReports).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reportId })]),
    );

    const detailsResponse = await advisorPage.request.get(`/api/fix-reports/${reportId}/details`);
    expect(detailsResponse.status()).toBe(200);
  } finally {
    await managerContext.close();
    await advisorContext.close();
    if (reportId) await db.delete(fixReports).where(eq(fixReports.id, reportId));
    if (runId) {
      await db.delete(checklistRunItems).where(eq(checklistRunItems.runId, runId));
      await db.delete(checklistRuns).where(eq(checklistRuns.id, runId));
    }
    if (templateId) {
      await db.delete(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, templateId));
      await db.delete(checklistTemplates).where(eq(checklistTemplates.id, templateId));
    }
    await db.delete(accessPolicies).where(eq(accessPolicies.personId, advisorPerson.id));
    await db.delete(people).where(eq(people.id, advisorPerson.id));
    await db.delete(userBranchAccess).where(inArray(userBranchAccess.userId, [manager.id, advisorUser.id]));
    await db.delete(users).where(inArray(users.id, [manager.id, advisorUser.id]));
    await db.delete(branches).where(inArray(branches.id, [sourceBranch.id, staleBranch.id]));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }
});
