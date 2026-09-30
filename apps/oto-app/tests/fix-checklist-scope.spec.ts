// seed: full
import { test, expect, type Page } from "@playwright/test";
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
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
import { deleteFromObjectStorage, uploadToObjectStorage } from "../server/file-storage";

const testId = () => Math.random().toString(36).slice(2, 8);
const scryptAsync = promisify(scrypt);
async function hashTestPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64) as Buffer;
  return `${hash.toString("hex")}.${salt}`;
}
async function login(page: Page, email: string, password: string) {
  await page.goto("/");
  const toggle = page.getByTestId("button-toggle-login-mode");
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.innerText()).includes("email")) await toggle.click();
  await page.getByTestId("input-login-email").fill(email);
  await page.getByTestId("input-login-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/today**");
}

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("checklist-linked Fix reports use the user's tenant and effective branch access", async ({ browser }) => {
  const suffix = testId();
  const password = "Password123!";
  const passwordHash = await hashTestPassword(password);
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
  let uploadedFilename: string | undefined;
  let otherRunId: string | undefined;
  let staleRunId: string | undefined;
  const checklistFiles: Array<{ folder: string; filename: string }> = [];

  try {
    await login(managerPage, managerEmail, password);
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

    const evidenceUpload = await managerPage.request.post("/api/checklist-evidence/upload", {
      multipart: { itemId: runItem.id, photo: { name: "evidence.png", mimeType: "image/png", buffer: PNG_BYTES } },
    });
    expect(evidenceUpload.status()).toBe(200);
    const evidence = await evidenceUpload.json();
    checklistFiles.push({ folder: "checkin-photos", filename: evidence.canonicalUrl.split("/").pop()! });
    expect((await managerPage.request.patch(`/api/checklist-run-items/${runItem.id}`, {
      data: { photoEvidenceUrls: [evidence.canonicalUrl] },
    })).status()).toBe(400);

    const [otherRun] = await db.insert(checklistRuns).values({
      tenantId: tenant.id, templateId, branchId: sourceBranch.id,
    }).returning();
    otherRunId = otherRun.id;
    const [otherItem] = await db.insert(checklistRunItems).values({
      tenantId: tenant.id, runId: otherRun.id, templateItemId: runItem.templateItemId,
    }).returning();
    expect((await managerPage.request.patch(`/api/checklist-run-items/${otherItem.id}`, {
      data: { photoEvidenceUrls: [evidence.url] },
    })).status()).toBe(400);
    expect((await managerPage.request.patch(`/api/checklist-run-items/${runItem.id}`, {
      data: { photoEvidenceUrls: [evidence.url] },
    })).status()).toBe(200);
    const evidenceRead = await managerPage.request.get(evidence.canonicalUrl);
    expect(evidenceRead.status()).toBe(200);
    expect(evidenceRead.headers()["cache-control"]).toBe("private, no-store");
    expect((await advisorPage.request.get(evidence.canonicalUrl)).status()).toBe(401);
    expect((await managerPage.request.get(evidence.canonicalUrl.replace("/api/files/", "/uploads/"))).status()).toBe(200);

    const checkerUpload = await managerPage.request.post("/api/checker-photos/upload", {
      multipart: { itemId: runItem.id, photo: { name: "checker.png", mimeType: "image/png", buffer: PNG_BYTES } },
    });
    expect(checkerUpload.status()).toBe(200);
    const checker = await checkerUpload.json();
    checklistFiles.push({ folder: "checker-photos", filename: checker.canonicalUrl.split("/").pop()! });
    expect((await managerPage.request.patch(`/api/checklist-run-items/${runItem.id}`, {
      data: { failPhotoUrl: checker.url },
    })).status()).toBe(200);
    expect((await managerPage.request.get(checker.canonicalUrl)).status()).toBe(200);
    expect((await managerPage.request.get(checker.canonicalUrl.replace("/api/files/", "/uploads/"))).status()).toBe(200);
    expect((await managerPage.request.post("/api/checker-photos/upload", {
      multipart: { itemId: runItem.id, photo: { name: "unsafe.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") } },
    })).status()).toBe(400);

    const [staleRun] = await db.insert(checklistRuns).values({
      tenantId: tenant.id, templateId, branchId: staleBranch.id,
    }).returning();
    staleRunId = staleRun.id;
    const staleUrl = await uploadToObjectStorage(PNG_BYTES, "checkin-photos", `stale-${suffix}.png`, "image/png");
    checklistFiles.push({ folder: "checkin-photos", filename: `stale-${suffix}.png` });
    await db.insert(checklistRunItems).values({
      tenantId: tenant.id, runId: staleRun.id, templateItemId: runItem.templateItemId, photoEvidenceUrls: [staleUrl],
    });
    expect((await managerPage.request.get(staleUrl)).status()).toBe(404);

    await login(advisorPage, advisorEmail, password);
    const sourceResponse = await advisorPage.request.get(`/api/fix-reports/checklist-source/${runItem.id}`);
    expect(sourceResponse.status()).toBe(200);

    const uploadResponse = await advisorPage.request.post("/api/fix-reports/upload", {
      multipart: { media: { name: `test-${suffix}.png`, mimeType: "image/png", buffer: PNG_BYTES } },
    });
    expect(uploadResponse.status()).toBe(200);
    const { urls } = await uploadResponse.json();
    uploadedFilename = /^\/api\/files\/fix-media\/([a-zA-Z0-9._-]+)\?claim=/.exec(urls[0])?.[1];
    expect(uploadedFilename).toBeTruthy();

    const reportResponse = await advisorPage.request.post("/api/fix-reports", {
      data: {
        media: urls,
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
    await managerContext.close().catch(() => undefined);
    await advisorContext.close().catch(() => undefined);
    if (reportId) await db.delete(fixReports).where(eq(fixReports.id, reportId));
    if (uploadedFilename) await deleteFromObjectStorage("fix-media", uploadedFilename);
    for (const file of checklistFiles) await deleteFromObjectStorage(file.folder, file.filename);
    for (const extraRunId of [otherRunId, staleRunId]) {
      if (!extraRunId) continue;
      await db.delete(checklistRunItems).where(eq(checklistRunItems.runId, extraRunId));
      await db.delete(checklistRuns).where(eq(checklistRuns.id, extraRunId));
    }
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
