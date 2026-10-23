// SCRUM-629 identity, scope and enabled-contract pins. No database or external service.
import assert from "node:assert/strict";
import type { User, UserWithBranchAccess } from "../shared/schema";
import { readOtoAppRoleContext, PlatformRoleMappingError, type MappedOtoAppRole } from "../shared/platformRoleMapping";
import { loadPlatformUserWithBranchAccess } from "../server/lib/platformRoleMapping";

const accountId = "01900000-0000-7000-8000-000000000001";
const operatorId = "01900000-0000-7000-8000-000000000002";
const tenantId = "01900000-0000-7000-8000-000000000003";
const foreignId = "01900000-0000-7000-8000-000000000004";
const userId = "zz-test-629-legacy-user-id";
const branchId = "zz-test-629-a";
const foreignBranch = "zz-test-629-b";
const copy = <T>(value: T): T => structuredClone(value);
function claim(role: MappedOtoAppRole = "manager") {
  return { platformRolesEnabled: true as const, userId, operatorId, tenantId, role, permissions: { "hr:salary:view": false } };
}
function fixture(rawRole: User["role"] = "advisor") {
  const raw = { id: userId, platformUserId: accountId, role: rawRole, operatorId, isActive: true } as User;
  const base = { ...raw, role: rawRole === "advisor" ? "staff" : rawRole, tenantId,
    branchAccess: [{ id: "zz-test-629-access", userId, branchId, tenantId, accessScope: "selected_branches", createdAt: new Date(0) }],
    hasAllBranchesAccess: rawRole === "admin", allowedBranchIds: rawRole === "admin" ? [] : [branchId],
  } as UserWithBranchAccess;
  const operator = { id: operatorId, tenantId, status: "active", platformRolesEnabled: true };
  const branches = new Map([[branchId, { id: branchId, tenantId }], [foreignBranch, { id: foreignBranch, tenantId: foreignId }]]);
  const reader = {
    getUser: async (id: string) => id === userId ? copy(raw) : undefined,
    getUserWithBranchAccess: async (id: string) => id === userId ? copy(base) : undefined,
    getOperator: async (id: string) => id === operatorId ? copy(operator) : undefined,
    getBranch: async (id: string) => copy(branches.get(id)),
  };
  return { raw, base, operator, branches, reader };
}
const resolve = (f: ReturnType<typeof fixture>, role: MappedOtoAppRole = "manager") => loadPlatformUserWithBranchAccess(userId, { accountId, otoApp: claim(role) }, f.reader);
let checks = 0;
async function check(name: string, action: () => unknown | Promise<unknown>) { await action(); checks++; console.log("PASS " + name); }

await check("only absent mapping is legacy and app user identifiers remain legacy strings", () => {
  assert.equal(readOtoAppRoleContext(undefined), undefined);
  assert.equal(readOtoAppRoleContext(claim())?.userId, userId);
  const longLegacyId = "zz-test-629-" + "x".repeat(300);
  assert.equal(readOtoAppRoleContext({ ...claim(), userId: longLegacyId })?.userId, longLegacyId);
  assert.equal(readOtoAppRoleContext(claim())?.permissions["hr:salary:view"], false);
});
await check("enabled shape, role values, booleans and exact fields are strict", () => {
  for (const value of [null, false, {}, { ...claim(), platformRolesEnabled: false }, { ...claim(), role: "operator_admin" },
    { ...claim(), role: "global_admin" }, { ...claim(), userId: "" }, { ...claim(), operatorId: "legacy-string" },
    { ...claim(), permissions: { "hr:salary:view": "false" } }, { ...claim(), extra: true },
    { ...claim(), permissions: { "hr:salary:view": false, "hr:salary:edit": true } }]) {
    assert.throws(() => readOtoAppRoleContext(value), PlatformRoleMappingError);
  }
});
await check("each approved role is applied without an app-side ordinary-role write", async () => {
  for (const role of ["admin", "manager", "staff"] as const) {
    const f = fixture(role), before = copy(f.raw), result = await resolve(f, role);
    assert.equal(result?.role, role); assert.deepEqual(f.raw, before);
  }
});
await check("ordinary raw admin role cannot synthesize all-branch reach", async () => {
  const f = fixture("admin"), result = await resolve(f, "admin");
  assert.equal(f.base.hasAllBranchesAccess, true); assert.equal(result?.hasAllBranchesAccess, false);
  assert.deepEqual(result?.allowedBranchIds, [branchId]);
});
await check("absent mapping preserves the original loaded user and scope", async () => {
  const f = fixture("admin"), result = await loadPlatformUserWithBranchAccess(userId, { accountId }, f.reader);
  assert.deepEqual(result, f.base); assert.equal(result?.hasAllBranchesAccess, true);
  assert.equal(result?.platformRoleMapping, undefined);
});
await check("advisor marker and selected policy reach survive each mapped effective role", async () => {
  for (const role of ["admin", "manager", "staff"] as const) {
    const f = fixture(), before = copy(f.raw), result = await resolve(f, role);
    assert.equal(result?.role, role); assert.equal(result?.hasAllBranchesAccess, false);
    assert.deepEqual(result?.allowedBranchIds, [branchId]); assert.deepEqual(f.raw, before); assert.equal(f.raw.role, "advisor");
  }
});
await check("advisor genuine all-branch policy is retained even with no access rows", async () => {
  const f = fixture(); f.base.branchAccess = []; f.base.hasAllBranchesAccess = true; f.base.allowedBranchIds = [];
  const result = await resolve(f, "staff"); assert.equal(result?.hasAllBranchesAccess, true); assert.deepEqual(result?.allowedBranchIds, []);
});
await check("ordinary no-row identity stays empty rather than defaulting to a branch", async () => {
  const f = fixture("manager"); f.base.branchAccess = []; f.base.allowedBranchIds = [];
  const result = await resolve(f); assert.equal(result?.hasAllBranchesAccess, false); assert.deepEqual(result?.allowedBranchIds, []);
});
await check("only explicit all-branch access can give ordinary users all-branch reach", async () => {
  const f = fixture("manager"); f.base.branchAccess[0].accessScope = "all_branches"; f.base.branchAccess[0].branchId = null;
  const result = await resolve(f); assert.equal(result?.hasAllBranchesAccess, true); assert.deepEqual(result?.allowedBranchIds, []);
});
await check("account, app user, legal entity and active flag bindings all refuse mismatches", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.raw.platformUserId = foreignId; },
    (f: ReturnType<typeof fixture>) => { f.raw.operatorId = foreignId; },
    (f: ReturnType<typeof fixture>) => { f.raw.isActive = false; },
    (f: ReturnType<typeof fixture>) => { f.operator.tenantId = foreignId; },
    (f: ReturnType<typeof fixture>) => { f.operator.platformRolesEnabled = false; }]) {
    const f = fixture(); change(f); await assert.rejects(resolve(f), PlatformRoleMappingError);
  }
  await assert.rejects(loadPlatformUserWithBranchAccess(userId, { accountId, otoApp: { ...claim(), userId: "zz-test-other" } }, fixture().reader), PlatformRoleMappingError);
});
await check("an inactive legal entity does not invent a new sign-in refusal", async () => {
  const f = fixture(); f.operator.status = "archived";
  const result = await resolve(f); assert.equal(result?.role, "manager");
});
await check("mixed tenant access rows and wrong-tenant policy branches refuse", async () => {
  const f = fixture(); f.base.branchAccess.push({ ...f.base.branchAccess[0], id: "zz-test-other", tenantId: foreignId });
  await assert.rejects(resolve(f), PlatformRoleMappingError);
  const g = fixture(); g.base.allowedBranchIds.push(foreignBranch); await assert.rejects(resolve(g), PlatformRoleMappingError);
  const h = fixture(); h.branches.get(branchId)!.tenantId = foreignId; await assert.rejects(resolve(h), PlatformRoleMappingError);
});
await check("same-tenant explicit branches do not choose another legal entity's flag", async () => {
  const f = fixture("manager"); f.branches.get(foreignBranch)!.tenantId = tenantId;
  f.base.branchAccess.push({ ...f.base.branchAccess[0], id: "zz-test-extra", branchId: foreignBranch });
  const result = await resolve(f); assert.deepEqual(result?.allowedBranchIds, [branchId, foreignBranch]);
  f.operator.platformRolesEnabled = false; await assert.rejects(resolve(f), PlatformRoleMappingError);
});
await check("ordinary role mismatch refuses rather than writing a new role", async () => {
  const f = fixture("staff"); await assert.rejects(resolve(f, "admin"), PlatformRoleMappingError); assert.equal(f.raw.role, "staff");
});
console.log(JSON.stringify({ passed: true, checks, database: false, network: false }));
