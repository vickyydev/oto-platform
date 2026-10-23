// Root runs this only against the disposable SCRUM-629 database on its isolated
// internal network. Refuse before importing any module that can connect.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

function requireIsolatedDatabase(): void {
  let target: URL;
  try { target = new URL(process.env.DATABASE_URL ?? ""); }
  catch { throw new Error("SCRUM-629 isolated database configuration is required"); }
  const name = decodeURIComponent(target.pathname.slice(1));
  if (process.env.SCRUM_629_ISOLATED_DB !== "1" || target.hostname !== "oto-admin629-pg" ||
    target.hostname !== process.env.SCRUM_629_EXPECT_DB_HOST || name !== process.env.SCRUM_629_EXPECT_DB_NAME ||
    !/^zz_test_629_[a-z0-9_]+$/.test(name)) throw new Error("SCRUM-629 disposable database guard refused");
}
requireIsolatedDatabase();
const { db, pool } = await import("../server/db");
const { storage } = await import("../server/storage");
const { tenants, operators, branches, users, people, employees, accessPolicies, userBranchAccess, insertOperatorSchema } = await import("../shared/schema");
const { loadPlatformUserWithBranchAccess } = await import("../server/lib/platformRoleMapping");
const { PlatformRoleMappingError } = await import("../shared/platformRoleMapping");
const { eq, inArray } = await import("drizzle-orm");

const suffix = randomUUID();
const tenantA = randomUUID(), tenantB = randomUUID(), operatorA = randomUUID(), operatorA2 = randomUUID(), operatorB = randomUUID();
const accountA = randomUUID(), accountAdmin = randomUUID();
const advisorId = "ZZ TEST 629 advisor " + suffix, adminId = "ZZ TEST 629 admin " + suffix;
const branchA = "ZZ TEST 629 branch A " + suffix, branchB = "ZZ TEST 629 branch B " + suffix;
const personA = "ZZ TEST 629 person A " + suffix, personB = "ZZ TEST 629 person B " + suffix;
const policyA = "ZZ TEST 629 policy A " + suffix, policyB = "ZZ TEST 629 policy B " + suffix;
const foreignEmployeeId = "ZZ TEST 629 foreign employee " + suffix;
const ownEmployeeId = "ZZ TEST 629 own employee " + suffix;
const claim = (userId = advisorId, role: "admin" | "manager" | "staff" = "manager") => ({
  platformRolesEnabled: true as const, userId, operatorId: operatorA, tenantId: tenantA, role,
  permissions: { "hr:salary:view": false },
});
let checks = 0, fixturesStarted = false;
try {
  for (const table of ["tenants", "operators", "branches", "users", "people", "employees", "access_policies", "user_branch_access"]) {
    const result = await pool.query("SELECT count(*)::int AS count FROM " + table);
    assert.equal(result.rows[0].count, 0, "disposable OTO fixture tables must start empty: " + table);
  }
  fixturesStarted = true;
  await db.insert(tenants).values([
    { id: tenantB, name: "ZZ TEST 629 park B", slug: "zz-test-629-b-" + suffix },
    { id: tenantA, name: "ZZ TEST 629 park A", slug: "zz-test-629-a-" + suffix },
  ]);
  await db.insert(operators).values([
    { id: operatorA, tenantId: tenantA, name: "ZZ TEST 629 entity A", status: "archived", platformRolesEnabled: true },
    { id: operatorA2, tenantId: tenantA, name: "ZZ TEST 629 entity A2" },
    { id: operatorB, tenantId: tenantB, name: "ZZ TEST 629 entity B", platformRolesEnabled: true },
  ]);
  // The first legacy fallback points at B; the mapped identity is anchored to A.
  await db.insert(branches).values({ id: branchB, tenantId: tenantB, operatorId: operatorB, name: "ZZ TEST 629 B", address: "ZZ TEST" });
  await db.insert(branches).values({ id: branchA, tenantId: tenantA, operatorId: operatorA, name: "ZZ TEST 629 A", address: "ZZ TEST" });
  await db.insert(users).values([
    { id: advisorId, email: "zz-test-629-advisor-" + suffix + "@example.invalid", password: "!", fullName: "ZZ TEST 629 advisor", role: "advisor", operatorId: operatorA, platformUserId: accountA },
    { id: adminId, email: "zz-test-629-admin-" + suffix + "@example.invalid", password: "!", fullName: "ZZ TEST 629 admin", role: "admin", operatorId: operatorA, platformUserId: accountAdmin },
  ]);
  await db.insert(people).values([
    { id: personA, tenantId: tenantA, fullName: "ZZ TEST 629 policy A", email: "zz-test-629-person-a-" + suffix + "@example.invalid", personType: "ADVISOR" },
    { id: personB, tenantId: tenantB, fullName: "ZZ TEST 629 policy B", email: "zz-test-629-person-b-" + suffix + "@example.invalid", personType: "ADVISOR" },
  ]);
  await db.insert(accessPolicies).values([
    { id: policyA, tenantId: tenantA, personId: personA, coreUserId: advisorId, accessLevel: "STAFF", modules: { core: true, hr: false, studio: false }, branchScope: "SELECTED", branchIds: [branchA] },
    { id: policyB, tenantId: tenantB, personId: personB, coreUserId: advisorId, accessLevel: "ADMIN", modules: { core: false, hr: true, studio: true }, branchScope: "ALL", branchIds: [] },
  ]);
  await db.insert(userBranchAccess).values({ userId: adminId, tenantId: tenantA, branchId: branchA, accessScope: "selected_branches" });

  const defaultOff = await storage.getOperator(operatorA2);
  assert.equal(defaultOff?.platformRolesEnabled, false);
  const ordinaryInput = insertOperatorSchema.parse({ tenantId: tenantA, name: "ZZ TEST 629 input", status: "active", platformRolesEnabled: true });
  assert.equal("platformRolesEnabled" in ordinaryInput, false); checks++;

  const legacy = await storage.getUserWithBranchAccess(advisorId);
  assert.equal(legacy?.tenantId, tenantB); assert.equal(legacy?.role, "admin");
  assert.equal(legacy?.hasAllBranchesAccess, true); checks++;
  for (const role of ["admin", "manager", "staff"] as const) {
    const mapped = await loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: claim(advisorId, role) }, storage);
    assert.equal(mapped?.tenantId, tenantA); assert.equal(mapped?.role, role);
    assert.equal(mapped?.hasAllBranchesAccess, false); assert.deepEqual(mapped?.allowedBranchIds, [branchA]);
    assert.deepEqual(mapped?.modules, { core: true, hr: false, studio: false });
    assert.equal(mapped?.platformRoleMapping?.permissions["hr:salary:view"], false);
    assert.equal((await storage.getUser(advisorId))?.role, "advisor"); checks++;
  }
  assert.equal((await storage.getUserWithBranchAccess(adminId))?.hasAllBranchesAccess, true);
  const admin = await loadPlatformUserWithBranchAccess(adminId, { accountId: accountAdmin, otoApp: claim(adminId, "admin") }, storage);
  assert.equal(admin?.hasAllBranchesAccess, false); assert.deepEqual(admin?.allowedBranchIds, [branchA]); checks++;

  await db.insert(employees).values({ id: foreignEmployeeId, tenantId: tenantB, personId: personB,
    fullName: "ZZ TEST 629 foreign employee", nickname: "ZZ TEST", email: "zz-test-629-advisor-" + suffix + "@example.invalid",
    userId: advisorId, branchId: branchB, profilePhotoPath: "ZZ TEST 629 foreign photo" });
  const withForeignMetadata = await loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: claim() }, storage);
  assert.equal(withForeignMetadata?.linkedEmployeeId, undefined, "mapped trusted tenant ignores a foreign employee linkage");
  assert.equal(withForeignMetadata?.linkedEmployeeProfilePhoto, null);
  assert.equal((await storage.getUserWithBranchAccess(advisorId))?.linkedEmployeeId, foreignEmployeeId,
    "the legacy unflagged storage path is unchanged"); checks++;
  await db.insert(employees).values({ id: ownEmployeeId, tenantId: tenantA, personId: personA,
    fullName: "ZZ TEST 629 own employee", nickname: "ZZ TEST", email: "zz-test-629-advisor-" + suffix + "@example.invalid",
    userId: advisorId, branchId: branchA, profilePhotoPath: "ZZ TEST 629 own photo" });
  const withOwnLink = await loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: claim() }, storage);
  assert.equal(withOwnLink?.linkedEmployeeId, ownEmployeeId, "foreign first row cannot hide a valid own employee linkage");
  assert.equal(withOwnLink?.linkedEmployeeProfilePhoto, "ZZ TEST 629 own photo"); checks++;
  await db.update(employees).set({ userId: null }).where(eq(employees.id, ownEmployeeId));
  const withOwnEmail = await loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: claim() }, storage);
  assert.equal(withOwnEmail?.linkedEmployeeId, ownEmployeeId, "mapped email fallback selects the own tenant's row");
  assert.equal(withOwnEmail?.linkedEmployeeProfilePhoto, "ZZ TEST 629 own photo"); checks++;

  await assert.rejects(loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: { ...claim(), operatorId: operatorA2 } }, storage), PlatformRoleMappingError);
  await assert.rejects(loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: { ...claim(), tenantId: tenantB } }, storage), PlatformRoleMappingError); checks++;
  await db.update(operators).set({ platformRolesEnabled: false }).where(eq(operators.id, operatorA));
  await assert.rejects(loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: claim() }, storage), PlatformRoleMappingError);
  await db.update(operators).set({ platformRolesEnabled: true }).where(eq(operators.id, operatorA)); checks++;
  await db.insert(userBranchAccess).values({ userId: advisorId, tenantId: tenantB, branchId: branchB, accessScope: "selected_branches" });
  await assert.rejects(loadPlatformUserWithBranchAccess(advisorId, { accountId: accountA, otoApp: claim() }, storage), PlatformRoleMappingError); checks++;
} finally {
  try {
    if (fixturesStarted) {
      await db.delete(accessPolicies).where(inArray(accessPolicies.id, [policyA, policyB]));
      await db.delete(userBranchAccess).where(inArray(userBranchAccess.userId, [advisorId, adminId]));
      await db.delete(employees).where(inArray(employees.id, [foreignEmployeeId, ownEmployeeId]));
      await db.delete(users).where(inArray(users.id, [advisorId, adminId]));
      await db.delete(people).where(inArray(people.id, [personA, personB]));
      await db.delete(branches).where(inArray(branches.id, [branchA, branchB]));
      await db.delete(operators).where(inArray(operators.id, [operatorA, operatorA2, operatorB]));
      await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
      for (const table of ["tenants", "operators", "branches", "users", "people", "employees", "access_policies", "user_branch_access"]) {
        const result = await pool.query("SELECT count(*)::int AS count FROM " + table);
        assert.equal(result.rows[0].count, 0, "fixture cleanup readback: " + table);
      }
    }
  } finally {
    (storage.sessionStore as unknown as { close?: () => void }).close?.();
    await pool.end();
  }
}
console.log(JSON.stringify({ passed: true, checks, database: "disposable-isolated", network: "internal-only", fixturesCleaned: true }));
