// Execute the actual training helper and list all-branch condition selected by AST.
// No server, database or external request.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
let helper: ts.VariableDeclaration | undefined, allBranches: ts.VariableDeclaration | undefined;
function routeOf(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isCallExpression(current) && current.arguments[0] && ts.isStringLiteral(current.arguments[0])
      && current.arguments[0].text.startsWith("/api/")) return current.arguments[0].text;
  }
}
const walk = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.name.text === "canReadTrainingModule") helper = node;
    if (node.name.text === "canSeeAllBranches" && routeOf(node) === "/api/training/modules") allBranches = node;
  }
  ts.forEachChild(node, walk);
};
walk(tree); assert.ok(helper?.initializer && allBranches?.initializer);
const javascript = (value: string) => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const canRead = new Function(javascript("const helper = " + helper.initializer.getText(tree) + ";") + "\nreturn helper;")();
const canListAll = new Function("user", javascript("return " + allBranches.initializer.getText(tree) + ";"));
const tenantId = "zz-test-629-tenant-a", ownBranch = "zz-test-629-a", otherBranch = "zz-test-629-b";
const legacy = { role: "admin", hasAllBranchesAccess: false, allowedBranchIds: [ownBranch] };
const mapped = { ...legacy, platformRoleMapping: { platformRolesEnabled: true } };
const module = { tenantId, isActive: true, scope: "BRANCH", branchIds: [otherBranch] };

assert.equal(canRead(mapped, module, tenantId), false, "mapped admin cannot read another branch's training");
assert.equal(canRead(legacy, module, tenantId), true, "flag-off admin rule stays unchanged");
assert.equal(canRead(mapped, { ...module, branchIds: [ownBranch] }, tenantId), true);
assert.equal(canRead(mapped, { ...module, branchIds: [ownBranch], isActive: false }, tenantId), true,
  "mapped admin retains the original inactive-module admin rule within its own branch");
assert.equal(canRead(mapped, { ...module, scope: "GLOBAL", branchIds: [] }, tenantId), true);
assert.equal(canRead(mapped, { ...module, tenantId: "zz-test-629-other-tenant" }, tenantId), false);
assert.equal(canRead({ ...mapped, hasAllBranchesAccess: true }, module, tenantId), true);
assert.equal(canListAll(mapped), false, "mapped admin cannot request the all-branch list");
assert.equal(canListAll(legacy), true);
assert.equal(canListAll({ ...mapped, hasAllBranchesAccess: true }), true);
console.log(JSON.stringify({ passed: true, checks: 2, database: false, network: false }));
