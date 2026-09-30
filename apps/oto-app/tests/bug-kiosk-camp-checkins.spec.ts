import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { tenants, branches, kioskDevices, kioskSessions, DEFAULT_TENANT_SLUG } from "../shared/schema";
import { coreEvents, campRegistrations, serviceCheckins } from "../server/db/coreSchema";
import { createHash } from "crypto";
import { deleteFromObjectStorage, uploadToObjectStorage } from "../server/file-storage";

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

test("checkout photo is readable only by its check-in branch", async ({ request }) => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);
  const [sourceBranch] = await db.select().from(branches).where(eq(branches.tenantId, tenant.id)).limit(1);
  const [otherBranch] = await db.insert(branches).values({
    tenantId: tenant.id,
    name: `Checkout photo other branch ${Date.now()}`,
    address: "Test only",
  }).returning();
  const [checkin] = await db.insert(serviceCheckins).values({
    tenantId: tenant.id,
    branchId: sourceBranch.id,
    parentFullName: "Checkout photo test parent",
    whatsappPhoneRaw: "0800000000",
    childFullName: "Checkout photo test child",
  }).returning();
  const [sourceDevice, otherDevice] = await db.insert(kioskDevices).values([
    { tenantId: tenant.id, branchId: sourceBranch.id, name: "Checkout source kiosk", kioskType: "reception" },
    { tenantId: tenant.id, branchId: otherBranch.id, name: "Checkout other kiosk", kioskType: "reception" },
  ]).returning();
  const sourceToken = `checkout-source-${Date.now()}`;
  const otherToken = `checkout-other-${Date.now()}`;
  const [sourceSession, otherSession] = await db.insert(kioskSessions).values([
    { tenantId: tenant.id, kioskDeviceId: sourceDevice.id, sessionTokenHash: hashSessionToken(sourceToken), expiresAt: new Date(Date.now() + 60_000) },
    { tenantId: tenant.id, kioskDeviceId: otherDevice.id, sessionTokenHash: hashSessionToken(otherToken), expiresAt: new Date(Date.now() + 60_000) },
  ]).returning();
  let photoFilename: string | undefined;
  let sharedPhotoFilename: string | undefined;
  try {
    const invalid = await request.post(`/api/core/checkins/${checkin.id}/checkout`, {
      headers: { Authorization: `Bearer ${sourceToken}` },
      data: { outPhotoData: "data:image/svg+xml;base64,PHN2Zz4=" },
    });
    expect(invalid.status()).toBe(400);
    const mismatched = await request.post(`/api/core/checkins/${checkin.id}/checkout`, {
      headers: { Authorization: `Bearer ${sourceToken}` },
      data: { outPhotoData: `data:image/png;base64,${Buffer.from("not a PNG").toString("base64")}` },
    });
    expect(mismatched.status()).toBe(400);

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const checkout = await request.post(`/api/core/checkins/${checkin.id}/checkout`, {
      headers: { Authorization: `Bearer ${sourceToken}` },
      data: { outPhotoData: `data:image/png;base64,${png.toString("base64")}` },
    });
    expect(checkout.status()).toBe(200);
    const saved = await checkout.json();
    expect(saved.outPhotoUrl).toMatch(/^\/api\/files\/checkin-photos\/checkout_[a-zA-Z0-9._-]+\.png$/);
    photoFilename = saved.outPhotoUrl.split("/").pop();

    const ownRead = await request.get(saved.outPhotoUrl, { headers: { Authorization: `Bearer ${sourceToken}` } });
    expect(ownRead.status()).toBe(200);
    expect(ownRead.headers()["cache-control"]).toBe("private, no-store");
    expect(await ownRead.body()).toEqual(png);
    const otherRead = await request.get(saved.outPhotoUrl, { headers: { Authorization: `Bearer ${otherToken}` } });
    expect(otherRead.status()).toBe(404);
    const anonymousRead = await request.get(saved.outPhotoUrl);
    expect(anonymousRead.status()).toBe(401);

    sharedPhotoFilename = `shared_${checkin.id}_${Date.now()}.png`;
    const privateUrl = await uploadToObjectStorage(png, "dropoff-photos-private", sharedPhotoFilename, "image/png");
    await db.update(serviceCheckins).set({ photoUrl: privateUrl }).where(eq(serviceCheckins.id, checkin.id));
    const list = await request.get(`/api/core/checkins?branchId=${sourceBranch.id}`, {
      headers: { Authorization: `Bearer ${sourceToken}` },
    });
    expect(list.status()).toBe(200);
    const listed = (await list.json()).find((row: any) => row.id === checkin.id);
    expect(listed.photoUrl).toMatch(new RegExp(`^/api/public/dropoff-photo/${checkin.id}\\?sig=`));
    expect(listed.photoUrl).not.toContain("expires=");
    const sharedRead = await request.get(listed.photoUrl);
    expect(sharedRead.status()).toBe(200);
    expect(await sharedRead.body()).toEqual(png);

  } finally {
    await db.delete(serviceCheckins).where(eq(serviceCheckins.id, checkin.id));
    await db.delete(kioskSessions).where(eq(kioskSessions.id, sourceSession.id));
    await db.delete(kioskSessions).where(eq(kioskSessions.id, otherSession.id));
    await db.delete(kioskDevices).where(eq(kioskDevices.id, sourceDevice.id));
    await db.delete(kioskDevices).where(eq(kioskDevices.id, otherDevice.id));
    await db.delete(branches).where(eq(branches.id, otherBranch.id));
    if (photoFilename) await deleteFromObjectStorage("checkin-photos", photoFilename);
    if (sharedPhotoFilename) await deleteFromObjectStorage("dropoff-photos-private", sharedPhotoFilename);
  }
});
