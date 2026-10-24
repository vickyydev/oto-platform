// Execute the registered current-user handler with the real permission engine.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { getEffectivePermissions } from "../shared/permissions";
import { loadAdminManagement } from "../server/lib/adminManagement";

const source = fs.readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
const handlers: ts.ArrowFunction[] = [];
const managementHandlers: ts.ArrowFunction[] = [];
const walk = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
    node.name.text === "administrationManagement") {
    assert.ok(node.initializer && ts.isArrowFunction(node.initializer));
    managementHandlers.push(node.initializer);
  }
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "app.get" &&
    node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "/api/permissions/me") {
    const handler = node.arguments.at(-1); assert.ok(handler && ts.isArrowFunction(handler)); handlers.push(handler);
  }
  ts.forEachChild(node, walk);
};
walk(tree); assert.equal(handlers.length, 1);
assert.equal(managementHandlers.length, 1);
let legacyLoads = 0;
let managementLoads = 0;
const ownOperator = { id: "zz-test-632-operator-a", tenantId: "zz-test-629-tenant-a", platformRolesEnabled: true };
const storage = {
  getUserWithBranchAccess: async () => { legacyLoads++; return { id: "zz-test-629-user", role: "admin" }; },
  getModuleOverrides: async () => [
    { id: "zz-test-629-settings", userId: "zz-test-629-user", moduleKey: "settings", enabled: true, branchScopeType: "ALL", branchIds: [] },
    { id: "zz-test-629-tasks", userId: "zz-test-629-user", moduleKey: "tasks", enabled: false, branchScopeType: "ALL", branchIds: [] },
  ],
  getEmployees: async () => [],
  getOperators: async () => { managementLoads++; return [ownOperator,
    { id: "zz-test-632-operator-foreign", tenantId: "zz-test-632-tenant-foreign", platformRolesEnabled: true },
  ]; },
};
const code = ts.transpileModule("const administrationManagement = " + managementHandlers[0].getText(tree) +
  ";\nconst handler = " + handlers[0].getText(tree) + ";", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const handler = new Function("storage", "userManagementTenant", "getEffectivePermissions", "loadAdminManagement", code + "\nreturn handler;")(
  storage, async () => "zz-test-629-tenant-a", getEffectivePermissions, loadAdminManagement);
async function request(mappedRole?: "admin" | "manager" | "staff", operatorId: string | null = ownOperator.id) {
  const req = { user: { id: "zz-test-629-user" }, userWithAccess: {
    id: "zz-test-629-user", role: mappedRole ?? "admin", tenantId: "zz-test-629-tenant-a", operatorId,
    ...(mappedRole ? { platformRoleMapping: { platformRolesEnabled: true } } : {}),
  } };
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  await handler(req, res, (error?: unknown) => { if (error) throw error; });
  assert.equal(res.statusCode, 200); return res.body;
}
for (const role of ["staff", "manager", "admin"] as const) {
  const result = await request(role);
  assert.equal(result.role, role, "frontend permissions use the validated mapped role");
  assert.equal(result.managedInAdmin, true, "the actor's exact enabled entity supplies management metadata");
  if (role !== "admin") {
    assert.equal(result.modules.find((module: any) => module.moduleKey === "settings").allowed, false,
      "a true override cannot open an admin-only module after downgrade");
    assert.equal(result.modules.find((module: any) => module.moduleKey === "tasks").allowed, false,
      "ordinary explicit module overrides remain effective");
  }
}
assert.equal(legacyLoads, 0, "mapped current user does not reload its legacy policy role");
ownOperator.platformRolesEnabled = false;
const legacy = await request();
assert.equal(legacy.role, "admin"); assert.equal(legacyLoads, 1, "flag-off legacy reload remains");
assert.equal(legacy.managedInAdmin, false, "the original flag-off actor remains editable");
assert.equal((await request("staff", "zz-test-632-operator-foreign")).managedInAdmin, false,
  "an enabled entity from another tenant cannot manage this actor");
assert.equal((await request("staff", null)).managedInAdmin, false,
  "an unassigned actor does not inherit another entity's enabled flag");
ownOperator.platformRolesEnabled = true;
assert.equal((await request("staff")).managedInAdmin, true, "a fresh request observes enabling the exact actor entity");
ownOperator.platformRolesEnabled = false;
assert.equal((await request("staff")).managedInAdmin, false, "a fresh request observes withdrawing the exact actor entity flag");
assert.equal(legacyLoads, 1, "metadata checks do not reload mapped users' legacy roles");
assert.equal(managementLoads, 8, "every response resolves current management flags afresh");
console.log(JSON.stringify({ passed: true, checks: 8, database: false, network: false }));
