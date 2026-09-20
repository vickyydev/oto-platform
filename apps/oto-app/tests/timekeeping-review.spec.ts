// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";
import { and, eq } from "drizzle-orm";
import { randomBytes, scrypt } from "crypto";
import { promisify } from "util";
import { db } from "../server/db";
import {
  accessPolicies,
  advisorAttendanceCorrections,
  advisorAttendanceSessions,
  branches,
  people,
  tenants,
  userBranchAccess,
  users as appUsers,
  DEFAULT_TENANT_SLUG,
} from "../shared/schema";

const scryptAsync = promisify(scrypt);
async function hashTestPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buffer = await scryptAsync(password, salt, 64) as Buffer;
  return `${buffer.toString("hex")}.${salt}`;
}

test("timekeeping review returns seeded advisor attendance", async ({ page }) => {
  await login(page);

  const date = new Date().toISOString().slice(0, 10);
  const response = await page.request.get(`/api/timekeeping/review?date=${date}`);

  expect(response.status()).toBe(200);
  const body = await response.json();
  const advisorRows = body.summaries.filter(
    (summary: { employeeName: string }) => summary.employeeName === "Seed Advisor Attendance",
  );
  expect(advisorRows).toHaveLength(1);
  expect(advisorRows[0]).toMatchObject({
    identityType: "ADVISOR",
    totalMinutes: 420,
    sessionCount: 2,
    hasPinUsed: true,
    faceEventsCount: 1,
  });
  expect(new Date(advisorRows[0].firstInTime).toISOString()).toBe(`${date}T02:00:00.000Z`);
  expect(new Date(advisorRows[0].lastOutTime).toISOString()).toBe(`${date}T11:00:00.000Z`);
});

test("manager can edit and void an advisor session with an audit trail", async ({ request }) => {
  const suffix = `${Date.now()}`.slice(-8);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);
  const tenantBranches = await db.select().from(branches).where(eq(branches.tenantId, tenant.id));
  const [branch, otherBranch] = tenantBranches;
  expect(otherBranch).toBeTruthy();
  const password = `Correction-${suffix}!`;
  const [manager] = await db.insert(appUsers).values({
    email: `attendance-manager-${suffix}@example.test`,
    password: await hashTestPassword(password),
    fullName: `Attendance Manager ${suffix}`,
    role: "manager",
    isActive: true,
    mustChangePassword: false,
  }).returning();
  await db.insert(userBranchAccess).values({
    tenantId: tenant.id,
    userId: manager.id,
    branchId: branch.id,
    accessScope: "selected_branches",
  });
  const [admin] = await db.insert(appUsers).values({
    email: `attendance-admin-${suffix}@example.test`,
    password: await hashTestPassword(password),
    fullName: `Attendance Admin ${suffix}`,
    role: "admin",
    isActive: true,
    mustChangePassword: false,
  }).returning();
  const loginResponse = await request.post("/api/login", {
    headers: { "x-forwarded-proto": "https" },
    data: { identifier: manager.email, password },
  });
  expect(loginResponse.status()).toBe(200);
  const setCookie = loginResponse.headersArray().find((header) => header.name.toLowerCase() === "set-cookie")?.value;
  const sessionCookie = setCookie?.split(";")[0];
  expect(sessionCookie).toBeTruthy();
  const authenticatedHeaders = { Cookie: sessionCookie! };
  const [advisor] = await db.insert(people).values({
    fullName: `Advisor correction ${suffix}`,
    email: `advisor-correction-${suffix}@example.test`,
    personType: "ADVISOR",
    isActive: true,
  }).returning();
  await db.insert(accessPolicies).values({
    tenantId: tenant.id,
    personId: advisor.id,
    accessLevel: "STAFF",
    modules: { core: true, hr: false, studio: false, events: false, ops: false, setup: false },
    branchScope: "SELECTED",
    branchIds: [branch.id, otherBranch.id],
  });
  const originalIn = new Date("2026-01-10T16:00:00.000Z");
  const [session] = await db.insert(advisorAttendanceSessions).values({
    tenantId: tenant.id,
    personId: advisor.id,
    branchId: branch.id,
    checkInAt: originalIn,
    checkOutAt: null,
    checkInDate: "2026-01-10",
    authMethod: "FACE",
  }).returning();

  try {
    const editedIn = "2026-01-10T15:30:00.000Z";
    const editedOut = "2026-01-10T18:00:00.000Z";
    const editResponse = await request.patch(`/api/timekeeping/advisor-sessions/${session.id}`, {
      headers: authenticatedHeaders,
      data: { action: "EDIT", reason: "Correcting a missed checkout", checkInAt: editedIn, checkOutAt: editedOut },
    });
    expect(editResponse.status()).toBe(200);
    expect((await editResponse.json()).session).toMatchObject({
      durationMinutes: 150,
      isOvernight: true,
    });

    const reviewResponse = await request.get("/api/timekeeping/review?date=2026-01-10", { headers: authenticatedHeaders });
    expect(reviewResponse.status()).toBe(200);
    const advisorSummary = (await reviewResponse.json()).summaries.find(
      (summary: { employeeId: string }) => summary.employeeId === advisor.id,
    );
    expect(advisorSummary.advisorSessions[0].corrections[0]).toMatchObject({
      action: "EDIT",
      reason: "Correcting a missed checkout",
    });

    const adminLoginResponse = await request.post("/api/login", {
      headers: { "x-forwarded-proto": "https" },
      data: { identifier: admin.email, password },
    });
    expect(adminLoginResponse.status()).toBe(200);
    const adminSetCookie = adminLoginResponse.headersArray().find((header) => header.name.toLowerCase() === "set-cookie")?.value;
    const adminCookie = adminSetCookie?.split(";")[0];
    expect(adminCookie).toBeTruthy();
    const adminHeaders = { Cookie: adminCookie! };
    const adminEditResponse = await request.patch(`/api/timekeeping/advisor-sessions/${session.id}`, {
      headers: adminHeaders,
      data: { action: "EDIT", reason: "Admin verified the final checkout", checkInAt: editedIn, checkOutAt: editedOut },
    });
    expect(adminEditResponse.status()).toBe(200);

    const voidResponse = await request.patch(`/api/timekeeping/advisor-sessions/${session.id}`, {
      headers: adminHeaders,
      data: { action: "VOID", reason: "This scan belonged to another person" },
    });
    expect(voidResponse.status()).toBe(200);
    expect((await voidResponse.json()).session.voidedAt).toBeTruthy();

    const [savedSession] = await db.select().from(advisorAttendanceSessions)
      .where(eq(advisorAttendanceSessions.id, session.id));
    expect(savedSession.voidedAt).toBeTruthy();
    const auditRows = await db.select().from(advisorAttendanceCorrections)
      .where(eq(advisorAttendanceCorrections.sessionId, session.id));
    expect(auditRows).toHaveLength(3);
    expect(auditRows.map((row) => row.action).sort()).toEqual(["EDIT", "EDIT", "VOID"]);

    const postVoidReview = await request.get("/api/timekeeping/review?date=2026-01-10", { headers: adminHeaders });
    expect(postVoidReview.status()).toBe(200);
    const postVoidRows = (await postVoidReview.json()).summaries.filter(
      (summary: { employeeId: string }) => summary.employeeId === advisor.id,
    );
    expect(postVoidRows).toHaveLength(0);

    const advisorOptionsResponse = await request.get("/api/timekeeping/override-advisors", { headers: adminHeaders });
    expect(advisorOptionsResponse.status()).toBe(200);
    const advisorOption = (await advisorOptionsResponse.json()).find((item: { id: string }) => item.id === advisor.id);
    expect(advisorOption).toEqual({
      id: advisor.id,
      fullName: advisor.fullName,
      preferredName: advisor.preferredName,
      isActive: true,
      accessPolicy: { branchScope: "SELECTED", branchIds: [branch.id, otherBranch.id] },
    });

    const manualInResponse = await request.post("/api/time-events/override", {
      headers: adminHeaders,
      data: {
        identityType: "ADVISOR",
        personId: advisor.id,
        branchId: branch.id,
        eventType: "IN",
        eventTime: "2026-01-11T01:00:00.000Z",
        notes: "Missed kiosk clock in",
      },
    });
    expect(manualInResponse.status()).toBe(201);
    const manualSessionId = (await manualInResponse.json()).session.id;

    const manualInEventsResponse = await request.get(
      "/api/time-events?dateFrom=2026-01-11T00:00:00.000Z&dateTo=2026-01-11T23:59:59.999Z",
      { headers: adminHeaders },
    );
    expect(manualInEventsResponse.status()).toBe(200);
    expect((await manualInEventsResponse.json()).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `advisor-${manualSessionId}-IN`,
        identityType: "ADVISOR",
        displayName: advisor.fullName,
        eventType: "IN",
        authMethod: "ADMIN_OVERRIDE",
      }),
    ]));

    const crossBranchInResponse = await request.post("/api/time-events/override", {
      headers: adminHeaders,
      data: {
        identityType: "ADVISOR",
        personId: advisor.id,
        branchId: otherBranch.id,
        eventType: "IN",
        eventTime: "2026-01-11T02:00:00.000Z",
      },
    });
    expect(crossBranchInResponse.status()).toBe(409);
    expect((await crossBranchInResponse.json()).message).toBe("Advisor already has an open attendance session");

    const manualOutResponse = await request.post("/api/time-events/override", {
      headers: adminHeaders,
      data: {
        identityType: "ADVISOR",
        personId: advisor.id,
        branchId: branch.id,
        eventType: "OUT",
        eventTime: "2026-01-11T03:30:00.000Z",
        reasonCode: "OTHER",
        reasonNotes: "Missed kiosk clock out",
      },
    });
    expect(manualOutResponse.status()).toBe(201);
    expect((await manualOutResponse.json()).session).toMatchObject({
      id: manualSessionId,
      durationMinutes: 150,
      authMethod: "ADMIN_OVERRIDE",
    });
    const manualOutEventsResponse = await request.get(
      "/api/time-events?dateFrom=2026-01-11T00:00:00.000Z&dateTo=2026-01-11T23:59:59.999Z",
      { headers: adminHeaders },
    );
    expect((await manualOutEventsResponse.json()).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `advisor-${manualSessionId}-OUT`,
        identityType: "ADVISOR",
        eventType: "OUT",
      }),
    ]));
    const manualAudit = await db.select().from(advisorAttendanceCorrections)
      .where(eq(advisorAttendanceCorrections.sessionId, manualSessionId));
    expect(manualAudit.map(row => row.action).sort()).toEqual(["CREATE", "EDIT"]);
  } finally {
    await db.delete(advisorAttendanceCorrections).where(eq(advisorAttendanceCorrections.sessionId, session.id));
    await db.delete(advisorAttendanceSessions).where(and(
      eq(advisorAttendanceSessions.personId, advisor.id),
      eq(advisorAttendanceSessions.branchId, branch.id),
    ));
    await db.delete(accessPolicies).where(eq(accessPolicies.personId, advisor.id));
    await db.delete(people).where(eq(people.id, advisor.id));
    await db.delete(userBranchAccess).where(eq(userBranchAccess.userId, manager.id));
    await db.delete(appUsers).where(eq(appUsers.id, manager.id));
    await db.delete(appUsers).where(eq(appUsers.id, admin.id));
  }
});

test("scheduled employee with no clock-in shows as absent in timekeeping review", async ({ page }) => {
  // Set light mode before navigating
  await page.addInitScript(() => localStorage.setItem("theme", "light"));

  await login(page);

  // Navigate to HR mode
  await page.getByTestId("button-mode-hr").click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });

  // Ensure Bangkok branch is selected (other tests may have switched it)
  await page.getByTestId("branch-selector-trigger").click();
  await page.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await page.waitForTimeout(500);

  // Expand the HR Operations section in the sidebar, then click Timekeeping Review
  await page.getByText("HR Operations").click();
  await page.getByRole("link", { name: "Timekeeping Review" }).click();
  await expect(page.getByText("Timekeeping Review").first()).toBeVisible({ timeout: 10000 });

  // Wait for the page to load fully
  await page.waitForTimeout(1000);

  // The full seed includes scheduled-no-show scenarios for the current review date.
  await expect(page.getByText("Absent").first()).toBeVisible({ timeout: 10000 });

  // The full seed can contain multiple scheduled no-shows; require at least one issue.
  await expect(page.getByTestId("text-issues-count")).toHaveText(/[1-9]\d*/);
  await expect(page.getByText("Issues to review")).toBeVisible();
});

test("employee detail page shows SCHEDULED_NO_SHOW anomaly for absent day", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "light"));

  await login(page);

  // Navigate to HR → Timekeeping Review
  await page.getByTestId("button-mode-hr").click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });

  await page.getByTestId("branch-selector-trigger").click();
  await page.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await page.waitForTimeout(500);

  await page.getByText("HR Operations").click();
  await page.getByRole("link", { name: "Timekeeping Review" }).click();
  await expect(page.getByText("Timekeeping Review").first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1000);

  const absentRow = page.locator("tr", { hasText: "Absent" }).first();
  await expect(absentRow).toBeVisible({ timeout: 10000 });
  await absentRow.getByRole("link", { name: "View Details" }).click();

  await expect(page.getByTestId("text-employee-name")).toBeVisible({ timeout: 10000 });

  // The Anomalies tab should show at least 1 anomaly
  const anomaliesTab = page.getByTestId("tab-anomalies");
  await expect(anomaliesTab).toBeVisible();
  // The count in the tab should not be (0)
  await expect(anomaliesTab).not.toHaveText(/Anomalies \(0\)/);

  // Click the anomalies tab and verify at least one SCHEDULED_NO_SHOW anomaly is shown.
  // A valid employee can have no-shows on multiple dates, so target the anomaly row
  // rather than a singular "Absent" badge.
  await anomaliesTab.click();
  await expect(page.locator('[data-testid^="row-anomaly-noshow-"]').first()).toBeVisible({ timeout: 5000 });
});
