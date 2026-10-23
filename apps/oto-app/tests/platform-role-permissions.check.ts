// Execute the registered current-user handler with the real permission engine.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { getEffectivePermissions } from "../shared/permissions";

const source = fs.readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
const handlers: ts.ArrowFunction[] = [];
const walk = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "app.get" &&
    node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "/api/permissions/me") {
    const handler = node.arguments.at(-1); assert.ok(handler && ts.isArrowFunction(handler)); handlers.push(handler);
  }
  ts.forEachChild(node, walk);
};
walk(tree); assert.equal(handlers.length, 1);
let legacyLoads = 0;
const storage = {
  getUserWithBranchAccess: async () => { legacyLoads++; return { id: "zz-test-629-user", role: "admin" }; },
  getModuleOverrides: async () => [
    { id: "zz-test-629-settings", userId: "zz-test-629-user", moduleKey: "settings", enabled: true, branchScopeType: "ALL", branchIds: [] },
    { id: "zz-test-629-tasks", userId: "zz-test-629-user", moduleKey: "tasks", enabled: false, branchScopeType: "ALL", branchIds: [] },
  ],
  getEmployees: async () => [],
};
const code = ts.transpileModule("const handler = " + handlers[0].getText(tree) + ";", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const handler = new Function("storage", "userManagementTenant", "getEffectivePermissions", code + "\nreturn handler;")(storage, async () => "zz-test-629-tenant-a", getEffectivePermissions);
async function request(mappedRole?: "admin" | "manager" | "staff") {
  const req = { user: { id: "zz-test-629-user" }, userWithAccess: mappedRole ? {
    id: "zz-test-629-user", role: mappedRole, platformRoleMapping: { platformRolesEnabled: true },
  } : undefined };
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  await handler(req, res, (error?: unknown) => { if (error) throw error; });
  assert.equal(res.statusCode, 200); return res.body;
}
for (const role of ["staff", "manager", "admin"] as const) {
  const result = await request(role);
  assert.equal(result.role, role, "frontend permissions use the validated mapped role");
  if (role !== "admin") {
    assert.equal(result.modules.find((module: any) => module.moduleKey === "settings").allowed, false,
      "a true override cannot open an admin-only module after downgrade");
    assert.equal(result.modules.find((module: any) => module.moduleKey === "tasks").allowed, false,
      "ordinary explicit module overrides remain effective");
  }
}
assert.equal(legacyLoads, 0, "mapped current user does not reload its legacy policy role");
assert.equal((await request()).role, "admin"); assert.equal(legacyLoads, 1, "flag-off legacy reload remains");
console.log(JSON.stringify({ passed: true, checks: 4, database: false, network: false }));
