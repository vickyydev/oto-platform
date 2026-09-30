import { test, expect } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { tenants, branches, kioskDevices, kioskSessions, users, userBranchAccess, activityLog, DEFAULT_TENANT_SLUG } from "../shared/schema";
import { coreEvents, campRegistrations, campAttendance, serviceCheckins } from "../server/db/coreSchema";
import { createHash, randomBytes, scryptSync } from "crypto";
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

  const [session] = await db.insert(kioskSessions).values({
    tenantId: tenant.id,
    kioskDeviceId: device.id,
    sessionTokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning();

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

  const [registration] = await db.insert(campRegistrations).values({
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
  }).returning();

  try {
    const response = await request.get(`/api/core/camp-checkins/today?branchId=${branch.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.registrations.map((r: any) => r.childFullName)).toContain("Playwright Camp Child");
  } finally {
    await db.delete(campAttendance).where(eq(campAttendance.campRegistrationId, registration.id));
    await db.delete(campRegistrations).where(eq(campRegistrations.id, registration.id));
    await db.delete(kioskSessions).where(eq(kioskSessions.id, session.id));
    await db.delete(kioskDevices).where(eq(kioskDevices.id, device.id));
    await db.delete(coreEvents).where(eq(coreEvents.id, camp.id));
  }
});

test("camp photos attach only to their event and open through scoped or signed reads", async ({ request }) => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);
  const [sourceBranch] = await db.select().from(branches).where(eq(branches.tenantId, tenant.id)).limit(1);
  const [otherBranch] = await db.insert(branches).values({ tenantId: tenant.id, name: `Camp photo other ${Date.now()}`, address: "Test only" }).returning();
  const today = bangkokToday();
  const [sourceCamp, otherCamp] = await db.insert(coreEvents).values([sourceBranch, otherBranch].map((branch, index) => ({
    tenantId: tenant.id, branchId: branch.id, eventType: "camp", title: `Photo test camp ${index}`,
    eventDate: today, campEndDate: today, startTime: "09:00", endTime: "15:00", status: "confirmed", isArchived: false,
  })) as any).returning();
  const [sourceDevice, otherDevice] = await db.insert(kioskDevices).values([sourceBranch, otherBranch].map((branch, index) => ({
    tenantId: tenant.id, branchId: branch.id, name: `Camp photo kiosk ${index}`, kioskType: "reception",
  }))).returning();
  const sourceToken = `camp-source-${Date.now()}`;
  const otherToken = `camp-other-${Date.now()}`;
  const [sourceSession, otherSession] = await db.insert(kioskSessions).values([
    { tenantId: tenant.id, kioskDeviceId: sourceDevice.id, sessionTokenHash: hashSessionToken(sourceToken), expiresAt: new Date(Date.now() + 60_000) },
    { tenantId: tenant.id, kioskDeviceId: otherDevice.id, sessionTokenHash: hashSessionToken(otherToken), expiresAt: new Date(Date.now() + 60_000) },
  ]).returning();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const uploadedFiles: Array<{ folder: string; filename: string }> = [];
  let registrationId: string | undefined;
  try {
    const unsafe = await request.post("/api/public/camp-photos", {
      multipart: { eventId: sourceCamp.id, photo: { name: "photo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") } },
    });
    expect(unsafe.status()).toBe(400);
    const upload = await request.post("/api/public/camp-photos", {
      multipart: { eventId: sourceCamp.id, photo: { name: "child.png", mimeType: "image/png", buffer: png } },
    });
    expect(upload.status()).toBe(200);
    const { url, canonicalUrl } = await upload.json();
    uploadedFiles.push({ folder: "camp-photos-private", filename: canonicalUrl.split("/").pop()! });
    expect((await request.get(canonicalUrl)).status()).toBe(401);
    expect((await request.get(url)).status()).toBe(200);

    const payload = {
      childFullName: "Camp Photo Test Child", dateOfBirth: "2018-01-01", parentGuardianName: "Camp Test Parent",
      emergencyContactNumber: "+66800001111", attendanceDays: [today], agreedCampRules: true,
      agreedChildHealthy: true, parentSignature: "Camp Test Parent", signatureDate: today, childPhotoUrl: url,
    };
    expect((await request.post("/api/public/camp-registrations", { data: { ...payload, eventId: otherCamp.id } })).status()).toBe(400);
    const submitted = await request.post("/api/public/camp-registrations", { data: { ...payload, eventId: sourceCamp.id } });
    expect(submitted.status()).toBe(201);
    const registration = await submitted.json();
    registrationId = registration.id;
    expect(registration.childPhotoUrl).toBe(canonicalUrl);
    expect((await request.get(canonicalUrl, { headers: { Authorization: `Bearer ${sourceToken}` } })).status()).toBe(200);
    expect((await request.get(canonicalUrl, { headers: { Authorization: `Bearer ${otherToken}` } })).status()).toBe(404);
    expect((await request.get(canonicalUrl)).status()).toBe(401);

    const lookup = await request.get(`/api/public/camp-registrations/lookup?eventId=${sourceCamp.id}&phone=${encodeURIComponent(payload.emergencyContactNumber)}`);
    expect(lookup.status()).toBe(200);
    const found = await lookup.json();
    expect(found.children[0].childPhotoUrl).toBe(canonicalUrl);
    const preview = found.children[0].childPhotoPreviewUrl;
    expect(preview).toContain(`/api/public/camp-photo/${registrationId}/childPhotoUrl?`);
    const previewRead = await request.get(preview);
    expect(previewRead.status()).toBe(200);
    expect(previewRead.headers()["cache-control"]).toBe("private, no-store");
    expect(previewRead.headers()["referrer-policy"]).toBe("no-referrer");
    expect(await previewRead.body()).toEqual(png);
    expect((await request.get(`${preview}x`)).status()).toBe(404);

    const roster = await request.get(`/api/core/camp-checkins/today?branchId=${sourceBranch.id}`, {
      headers: { Authorization: `Bearer ${sourceToken}` },
    });
    expect(roster.status()).toBe(200);
    const row = (await roster.json()).registrations.find((item: any) => item.id === registrationId);
    expect(row.childPhotoUrl).toContain(`/api/public/camp-photo/${registrationId}/childPhotoUrl?`);
    expect((await request.get(row.childPhotoUrl)).status()).toBe(200);
  } finally {
    if (registrationId) {
      await db.delete(campAttendance).where(eq(campAttendance.campRegistrationId, registrationId));
      await db.delete(campRegistrations).where(eq(campRegistrations.id, registrationId));
    }
    for (const file of uploadedFiles) await deleteFromObjectStorage(file.folder, file.filename);
    await db.delete(kioskSessions).where(eq(kioskSessions.id, sourceSession.id));
    await db.delete(kioskSessions).where(eq(kioskSessions.id, otherSession.id));
    await db.delete(kioskDevices).where(eq(kioskDevices.id, sourceDevice.id));
    await db.delete(kioskDevices).where(eq(kioskDevices.id, otherDevice.id));
    await db.delete(coreEvents).where(eq(coreEvents.id, sourceCamp.id));
    await db.delete(coreEvents).where(eq(coreEvents.id, otherCamp.id));
    await db.delete(branches).where(eq(branches.id, otherBranch.id));
  }
});

test("camp child photos and profile sync stay within manager tenant and branches", async ({ request }) => {
  const suffix = randomBytes(5).toString("hex");
  const password = randomBytes(18).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
  const today = bangkokToday();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);
  const [sourceBranch] = await db.select().from(branches).where(eq(branches.tenantId, tenant.id)).limit(1);
  const [otherBranch] = await db.insert(branches).values({ tenantId: tenant.id, name: `Camp scope other ${suffix}`, address: "Test only" }).returning();
  const [foreignTenant] = await db.insert(tenants).values({ name: `Camp scope tenant ${suffix}`, slug: `camp-scope-${suffix}` }).returning();
  const [foreignBranch] = await db.insert(branches).values({ tenantId: foreignTenant.id, name: `Camp scope foreign ${suffix}`, address: "Test only" }).returning();
  const [sourceCamp, otherCamp, foreignCamp] = await db.insert(coreEvents).values([
    { tenantId: tenant.id, branchId: sourceBranch.id, eventType: "camp", title: `Scope source ${suffix}` },
    { tenantId: tenant.id, branchId: otherBranch.id, eventType: "camp", title: `Scope other ${suffix}` },
    { tenantId: foreignTenant.id, branchId: foreignBranch.id, eventType: "camp", title: `Scope foreign ${suffix}` },
  ].map(event => ({ ...event, eventDate: today, campEndDate: today, startTime: "09:00", endTime: "15:00", status: "confirmed", isArchived: false })) as any).returning();
  const photoA = `/api/files/camp-photos-private/scope-a-${suffix}.png`;
  const photoB = `/api/files/camp-photos-private/scope-b-${suffix}.png`;
  const sameChild = { childFullName: `Scope Child ${suffix}`, emergencyContactNumber: `scope-phone-${suffix}` };
  const [sourceChild, siblingChild, otherChild, foreignChild] = await db.insert(campRegistrations).values([
    { tenantId: tenant.id, eventId: sourceCamp.id, ...sameChild, childPhotoUrl: photoA },
    { tenantId: tenant.id, eventId: otherCamp.id, ...sameChild, childPhotoUrl: photoB },
    { tenantId: tenant.id, eventId: otherCamp.id, childFullName: `Other Child ${suffix}`, emergencyContactNumber: `other-phone-${suffix}`, childPhotoUrl: photoB },
    { tenantId: foreignTenant.id, eventId: foreignCamp.id, childFullName: `Foreign Child ${suffix}`, emergencyContactNumber: `foreign-phone-${suffix}`, childPhotoUrl: photoB },
  ].map(row => ({ ...row, dateOfBirth: "2018-01-01", parentGuardianName: "Scope Parent", attendanceDays: [today], agreedCampRules: true, agreedChildHealthy: true, parentSignature: "Scope Parent", signatureDate: today })) as any).returning();
  const [branchManager, allBranchManager, foreignManager] = await db.insert(users).values([
    { email: `camp-branch-${suffix}@example.test`, password: passwordHash, fullName: "Camp Branch Manager", role: "manager", mustChangePassword: false },
    { email: `camp-all-${suffix}@example.test`, password: passwordHash, fullName: "Camp All Branch Manager", role: "manager", mustChangePassword: false },
    { email: `camp-foreign-${suffix}@example.test`, password: passwordHash, fullName: "Camp Foreign Manager", role: "manager", mustChangePassword: false },
  ]).returning();
  await db.insert(userBranchAccess).values([
    { tenantId: tenant.id, userId: branchManager.id, branchId: sourceBranch.id, accessScope: "selected_branches" },
    { tenantId: tenant.id, userId: allBranchManager.id, branchId: null, accessScope: "all_branches" },
    { tenantId: foreignTenant.id, userId: foreignManager.id, branchId: foreignBranch.id, accessScope: "selected_branches" },
  ]);
  const login = async (email: string) => {
    const response = await request.post("/api/login", {
      headers: { "x-forwarded-proto": "https" }, data: { identifier: email, password },
    });
    expect(response.status()).toBe(200);
    const cookie = response.headersArray().find(header => header.name.toLowerCase() === "set-cookie")?.value?.split(";")[0];
    expect(cookie).toBeTruthy();
    expect(cookie?.split("=")[0]).toBe("connect.sid");
    expect((await request.get("/api/user", { headers: { Cookie: cookie! } })).status()).toBe(200);
    return { Cookie: cookie! };
  };
  try {
    const branchHeaders = await login(branchManager.email);
    const branchList = await request.get(`/api/admin/children?search=${suffix}`, { headers: branchHeaders });
    expect(branchList.status()).toBe(200);
    expect((await branchList.json()).children.map((row: any) => row.id)).toEqual([sourceChild.id]);
    const hiddenSearch = await request.get(`/api/admin/camp-children/search?q=${suffix}`, { headers: branchHeaders });
    expect(hiddenSearch.status()).toBe(200);
    expect((await hiddenSearch.json()).map((row: any) => row.id)).not.toContain(otherChild.id);
    const history = await request.get(`/api/admin/children/${sourceChild.id}/history`, { headers: branchHeaders });
    expect(history.status()).toBe(200);
    expect((await history.json()).history.map((row: any) => row.id)).toEqual([sourceChild.id]);

    const eventEdit = await request.patch(`/api/events/${sourceCamp.id}/camp-registrations/${sourceChild.id}`, {
      headers: branchHeaders, data: { childPhotoUrl: null },
    });
    expect(eventEdit.status()).toBe(200);
    expect((await db.select({ childPhotoUrl: campRegistrations.childPhotoUrl }).from(campRegistrations).where(eq(campRegistrations.id, siblingChild.id)))[0].childPhotoUrl).toBe(photoB);
    await db.update(campRegistrations).set({ childPhotoUrl: photoA }).where(eq(campRegistrations.id, sourceChild.id));
    const globalEdit = await request.patch(`/api/admin/children/${sourceChild.id}`, {
      headers: branchHeaders, data: { childPhotoUrl: null },
    });
    expect(globalEdit.status()).toBe(200);
    expect((await db.select({ childPhotoUrl: campRegistrations.childPhotoUrl }).from(campRegistrations).where(eq(campRegistrations.id, siblingChild.id)))[0].childPhotoUrl).toBe(photoB);
    expect((await request.post("/api/admin/children/merge", {
      headers: branchHeaders, data: { primaryId: sourceChild.id, secondaryId: otherChild.id },
    })).status()).toBe(404);
    const foreignHeaders = await login(foreignManager.email);
    const foreignList = await request.get(`/api/admin/children?search=${suffix}`, { headers: foreignHeaders });
    expect(foreignList.status()).toBe(200);
    expect((await foreignList.json()).children.map((row: any) => row.id)).toEqual([foreignChild.id]);
    expect((await request.post("/api/admin/children/merge", {
      headers: foreignHeaders, data: { primaryId: sourceChild.id, secondaryId: otherChild.id },
    })).status()).toBe(404);
    const allHeaders = await login(allBranchManager.email);
    const allList = await request.get(`/api/admin/children?search=${suffix}`, { headers: allHeaders });
    expect(allList.status()).toBe(200);
    expect((await allList.json()).children.map((row: any) => row.id)).toContain(otherChild.id);
    await db.update(campRegistrations).set({ childPhotoUrl: photoA }).where(eq(campRegistrations.id, sourceChild.id));
    const permittedMerge = await request.post("/api/admin/children/merge", {
      headers: allHeaders, data: { primaryId: sourceChild.id, secondaryId: otherChild.id },
    });
    expect(permittedMerge.status()).toBe(200);
    const [merged] = await db.select({ childPhotoUrl: campRegistrations.childPhotoUrl })
      .from(campRegistrations).where(eq(campRegistrations.id, otherChild.id));
    expect(merged.childPhotoUrl).toBe(photoA);
  } finally {
    await db.delete(activityLog).where(inArray(activityLog.createdBy, [branchManager.id, allBranchManager.id, foreignManager.id]));
    await db.delete(userBranchAccess).where(inArray(userBranchAccess.userId, [branchManager.id, allBranchManager.id, foreignManager.id]));
    await db.delete(users).where(inArray(users.id, [branchManager.id, allBranchManager.id, foreignManager.id]));
    await db.delete(campAttendance).where(inArray(campAttendance.campRegistrationId, [sourceChild.id, siblingChild.id, otherChild.id, foreignChild.id]));
    await db.delete(campRegistrations).where(inArray(campRegistrations.id, [sourceChild.id, siblingChild.id, otherChild.id, foreignChild.id]));
    await db.delete(coreEvents).where(inArray(coreEvents.id, [sourceCamp.id, otherCamp.id, foreignCamp.id]));
    await db.delete(branches).where(inArray(branches.id, [otherBranch.id, foreignBranch.id]));
    await db.delete(tenants).where(eq(tenants.id, foreignTenant.id));
  }
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
