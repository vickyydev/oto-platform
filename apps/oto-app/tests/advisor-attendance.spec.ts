import { test, expect } from "@playwright/test";
import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  accessPolicies,
  advisorAttendanceSessions,
  branches,
  employees,
  kioskAuthAttempts,
  kioskDevices,
  people,
  tenants,
  DEFAULT_TENANT_SLUG,
} from "../shared/schema";
import { advisorSessionCorrectionValues, advisorSessionMetrics, canAdvisorUseKiosk, issueAdvisorIdentificationProof, verifyAdvisorIdentificationProof } from "../server/advisor-attendance";
import { replaceFaceEnrollment, type FaceRecognitionService } from "../server/face-recognition";
import { normalizeEnrollmentIdentity } from "../client/src/lib/kiosk-enrollment";

test("kiosk normalizes advisor and employee enrollment identities for confirmation", () => {
  expect(normalizeEnrollmentIdentity({
    sessionId: "advisor-session",
    identityType: "ADVISOR",
    advisor: { id: "advisor-1", fullName: "Advisor One" },
  }, "advisor-token")).toEqual({
    sessionId: "advisor-session",
    token: "advisor-token",
    identityType: "ADVISOR",
    person: { id: "advisor-1", fullName: "Advisor One" },
  });

  expect(normalizeEnrollmentIdentity({
    sessionId: "employee-session",
    identityType: "EMPLOYEE",
    employee: { id: "employee-1", fullName: "Employee One", branchId: "branch-1" },
  }, "employee-token")).toEqual({
    sessionId: "employee-session",
    token: "employee-token",
    identityType: "EMPLOYEE",
    person: { id: "employee-1", fullName: "Employee One" },
  });
});

test("kiosk rejects malformed enrollment identities before confirmation", () => {
  expect(() => normalizeEnrollmentIdentity({
    sessionId: "advisor-session",
    identityType: "ADVISOR",
  }, "advisor-token")).toThrow("enrollment response was invalid");
});

test("database enforces one open advisor attendance session per person", async () => {
  const result = await db.execute(sql`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'advisor_attendance_one_open_session'
  `);

  expect(result.rows).toHaveLength(1);
  expect(String(result.rows[0].indexdef)).toContain("UNIQUE INDEX");
  expect(String(result.rows[0].indexdef)).toContain("(check_out_at IS NULL)");
  expect(String(result.rows[0].indexdef)).toContain("(voided_at IS NULL)");
});

test("advisor attendance authorizes by policy tenant and branch before matching", () => {
  const policy = { tenantId: "tenant-a", branchScope: "SELECTED" as const, branchIds: ["branch-a"] };
  expect(canAdvisorUseKiosk(policy, { id: "branch-a", tenantId: "tenant-a" })).toBe(true);
  expect(canAdvisorUseKiosk(policy, { id: "branch-b", tenantId: "tenant-a" })).toBe(false);
  expect(canAdvisorUseKiosk(policy, { id: "branch-a", tenantId: "tenant-b" })).toBe(false);
});

test("advisor session duration remains continuous across midnight", () => {
  const normal = advisorSessionMetrics(new Date("2025-01-01T09:00:00Z"), new Date("2025-01-01T14:30:00Z"), "2025-01-01", "2025-01-01");
  expect(normal).toEqual({ totalMinutes: 330, isOvernight: false });
  const overnight = advisorSessionMetrics(new Date("2025-01-01T15:00:00Z"), new Date("2025-01-01T20:00:00Z"), "2025-01-01", "2025-01-02");
  expect(overnight).toEqual({ totalMinutes: 300, isOvernight: true });
});

test("advisor corrections recalculate local date, duration, and overnight status", () => {
  expect(advisorSessionCorrectionValues(
    new Date("2025-01-01T16:30:00Z"),
    new Date("2025-01-01T18:00:00Z"),
    "Asia/Bangkok",
  )).toEqual({ checkInDate: "2025-01-01", totalMinutes: 90, isOvernight: true });
});

test("face identification proof is short-lived and bound to its kiosk device and branch", () => {
  const proof = issueAdvisorIdentificationProof("advisor-1", "device-1", "branch-1");
  expect(verifyAdvisorIdentificationProof(proof, "device-1")).toEqual({ personId: "advisor-1", branchId: "branch-1" });
  expect(verifyAdvisorIdentificationProof(proof, "device-2")).toBeNull();
  expect(verifyAdvisorIdentificationProof("bad.signature", "device-1")).toBeNull();
});

test("advisor face replacement retires the old face before enrolling the new one", async () => {
  const calls: string[] = [];
  const service = {
    deleteFace: async (faceId: string) => {
      calls.push(`delete:${faceId}`);
      return true;
    },
    enrollFace: async (personId: string) => {
      calls.push(`enroll:${personId}`);
      return { success: true, faceId: "new-face", confidence: 99 };
    },
  } as unknown as FaceRecognitionService;

  const result = await replaceFaceEnrollment({
    service,
    identityId: "advisor-1",
    imageBase64: "image",
    previousFaceId: "old-face",
    onPreviousFaceDeleted: async () => {
      calls.push("clear-database-state");
    },
  });

  expect(result).toMatchObject({ success: true, faceId: "new-face", previousFaceDeleted: true });
  expect(calls).toEqual(["delete:old-face", "clear-database-state", "enroll:advisor-1"]);
});

test("advisor face replacement stops when the old face cannot be retired", async () => {
  let enrolled = false;
  let cleared = false;
  const service = {
    deleteFace: async () => false,
    enrollFace: async () => {
      enrolled = true;
      return { success: true, faceId: "new-face" };
    },
  } as unknown as FaceRecognitionService;

  const result = await replaceFaceEnrollment({
    service,
    identityId: "advisor-1",
    imageBase64: "image",
    previousFaceId: "old-face",
    onPreviousFaceDeleted: async () => {
      cleared = true;
    },
  });

  expect(result).toMatchObject({ success: false, errorCode: "PREVIOUS_FACE_DELETE_FAILED" });
  expect(enrolled).toBe(false);
  expect(cleared).toBe(false);
});

test("verified advisor phone records one unscheduled session across midnight without an employee", async ({ request }) => {
  const suffix = `${Date.now()}`.slice(-8);
  const phone = `08${suffix}`;
  const phoneE164 = `+668${suffix}`;
  const allowedSecret = `advisor-allowed-${Date.now()}`;
  const deniedSecret = `advisor-denied-${Date.now()}`;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);
  const [allowedBranch] = await db.select().from(branches).where(eq(branches.tenantId, tenant.id)).limit(1);
  const [deniedBranch] = await db.insert(branches).values({
    tenantId: tenant.id,
    name: `Advisor denied branch ${suffix}`,
    address: "Test only",
    timezone: allowedBranch.timezone,
  }).returning();
  const [advisor] = await db.insert(people).values({
    fullName: `Advisor Kiosk ${suffix}`,
    email: `advisor-kiosk-${suffix}@example.test`,
    personType: "ADVISOR",
    isActive: true,
    phoneNumber: phone,
    phoneE164,
    phoneVerified: true,
    phoneVerifiedAt: new Date(),
  }).returning();
  await db.insert(accessPolicies).values({
    tenantId: tenant.id,
    personId: advisor.id,
    accessLevel: "STAFF",
    modules: { core: true, hr: false, studio: false, events: false, ops: false, setup: false },
    branchScope: "SELECTED",
    branchIds: [allowedBranch.id],
  });
  const [allowedDevice] = await db.insert(kioskDevices).values({
    tenantId: tenant.id,
    branchId: allowedBranch.id,
    name: "Advisor allowed kiosk",
    deviceSecretHash: createHash("sha256").update(allowedSecret).digest("hex"),
  }).returning();
  const [deniedDevice] = await db.insert(kioskDevices).values({
    tenantId: tenant.id,
    branchId: deniedBranch.id,
    name: "Advisor denied kiosk",
    deviceSecretHash: createHash("sha256").update(deniedSecret).digest("hex"),
  }).returning();

  try {
    const denied = await request.post("/api/kiosk/clock-phone", {
      data: { phone, photoEvidenceUrl: "/test/advisor.jpg", deviceSecret: deniedSecret },
    });
    expect(denied.status()).toBe(401);

    const clockIn = await request.post("/api/kiosk/clock-phone", {
      data: { phone, photoEvidenceUrl: "/test/advisor.jpg", deviceSecret: allowedSecret },
    });
    expect(clockIn.status()).toBe(200);
    expect(await clockIn.json()).toMatchObject({ success: true, identityType: "ADVISOR", eventType: "IN" });

    const [open] = await db.select().from(advisorAttendanceSessions)
      .where(and(eq(advisorAttendanceSessions.personId, advisor.id), eq(advisorAttendanceSessions.branchId, allowedBranch.id)));
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await db.update(advisorAttendanceSessions).set({
      checkInAt: fiveHoursAgo,
      checkInDate: yesterday.toISOString().slice(0, 10),
    }).where(eq(advisorAttendanceSessions.id, open.id));

    const clockOut = await request.post("/api/kiosk/clock-phone", {
      data: { phone, photoEvidenceUrl: "/test/advisor.jpg", deviceSecret: allowedSecret },
    });
    expect(clockOut.status()).toBe(200);
    expect(await clockOut.json()).toMatchObject({ success: true, identityType: "ADVISOR", eventType: "OUT" });

    const sessions = await db.select().from(advisorAttendanceSessions)
      .where(eq(advisorAttendanceSessions.personId, advisor.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isOvernight).toBe(true);
    expect(sessions[0].durationMinutes).toBeGreaterThanOrEqual(299);
    expect(sessions[0].durationMinutes).toBeLessThanOrEqual(301);
    expect(await db.select().from(employees).where(eq(employees.personId, advisor.id))).toHaveLength(0);
    expect(await db.select().from(kioskAuthAttempts).where(eq(kioskAuthAttempts.personId, advisor.id))).toHaveLength(2);
  } finally {
    await db.delete(kioskAuthAttempts).where(eq(kioskAuthAttempts.personId, advisor.id));
    await db.delete(people).where(eq(people.id, advisor.id));
    await db.delete(kioskDevices).where(eq(kioskDevices.id, allowedDevice.id));
    await db.delete(kioskDevices).where(eq(kioskDevices.id, deniedDevice.id));
    await db.delete(branches).where(eq(branches.id, deniedBranch.id));
  }
});
