import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { tenants, branches, kioskDevices, kioskSessions, DEFAULT_TENANT_SLUG } from "../shared/schema";
import { coreEvents, campRegistrations } from "../server/db/coreSchema";
import { createHash } from "crypto";

const SESSION_PEPPER = process.env.SESSION_PEPPER || "default-session-pepper-change-in-production";
function hashSessionToken(token: string): string {
  return createHash("sha256").update(token + SESSION_PEPPER).digest("hex");
}

function bangkokToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
}

test("reception kiosk can load today's camp registrations with its kiosk token", async ({ request }) => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);
  expect(tenant).toBeTruthy();

  const [branch] = await db.select().from(branches).where(eq(branches.tenantId, tenant.id)).limit(1);
  expect(branch).toBeTruthy();

  const token = `test-kiosk-camp-${Date.now()}`;
  const [device] = await db.insert(kioskDevices).values({
    tenantId: tenant.id,
    branchId: branch.id,
    name: "Playwright Camp Kiosk",
    kioskType: "reception",
    isActive: true,
  }).returning();

  await db.insert(kioskSessions).values({
    tenantId: tenant.id,
    kioskDeviceId: device.id,
    sessionTokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const today = bangkokToday();
  const [camp] = await db.insert(coreEvents).values({
    tenantId: tenant.id,
    branchId: branch.id,
    eventType: "camp",
    title: "Playwright Active Camp",
    eventDate: today,
    campEndDate: today,
    startTime: "09:00",
    endTime: "15:00",
    status: "confirmed",
    isArchived: false,
  } as any).returning();

  await db.insert(campRegistrations).values({
    tenantId: tenant.id,
    eventId: camp.id,
    childFullName: "Playwright Camp Child",
    dateOfBirth: "2018-01-01",
    parentGuardianName: "Playwright Parent",
    emergencyContactNumber: "+66812345678",
    attendanceDays: [today],
    agreedCampRules: true,
    agreedChildHealthy: true,
    parentSignature: "Playwright Parent",
    signatureDate: today,
  });

  const response = await request.get(`/api/core/camp-checkins/today?branchId=${branch.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.registrations.map((r: any) => r.childFullName)).toContain("Playwright Camp Child");
});
