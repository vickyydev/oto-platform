// Execute the actual route branch guards, selected by the TypeScript AST.
// No server, database or external request. This tests guard behavior, not source wording.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const globals: ts.VariableDeclaration[] = [];
let leaveAllowed: ts.VariableDeclaration | undefined, emptyBranchGuard: ts.IfStatement | undefined;
function routeOf(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isCallExpression(current) && current.arguments[0] && ts.isStringLiteral(current.arguments[0])
      && current.arguments[0].text.startsWith("/api/")) return current.arguments[0].text;
  }
}
function walk(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.name.text === "isGlobalAdmin" && node.initializer?.getText(tree).includes("user")) globals.push(node);
    if (node.name.text === "leaveBranchAllowed") leaveAllowed = node;
  }
  if (ts.isIfStatement(node) && routeOf(node) === "/api/leave-types"
    && node.expression.getText(tree).includes("allowedBranchIds.length === 0")) emptyBranchGuard = node;
  ts.forEachChild(node, walk);
}
walk(tree);
assert.equal(globals.length, 5, "all five existing role-based branch shortcuts remain under review");
assert.ok(leaveAllowed?.initializer && emptyBranchGuard);

function javascript(value: string): string { return ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText; }
function followingGuard(declaration: ts.VariableDeclaration): ts.IfStatement {
  const statement = declaration.parent.parent, block = statement.parent;
  assert.ok(ts.isBlock(block));
  const remaining = block.statements.slice(block.statements.indexOf(statement as ts.Statement) + 1);
  let found: ts.IfStatement | undefined;
  const find = (node: ts.Node) => {
    if (!found && ts.isIfStatement(node) && node.expression.getText(tree).includes("!isGlobalAdmin")) found = node;
    if (!found) ts.forEachChild(node, find);
  };
  for (const candidate of remaining) { find(candidate); if (found) break; }
  assert.ok(found, "actual branch guard follows the local role shortcut"); return found;
}
function guardResult(code: string, user: object, branchId = "zz-test-629-b") {
  const res = { status: (statusCode: number) => ({ json: (_body: unknown) => ({ statusCode }) }) };
  return new Function("user", "branchId", "employee", "targetShiftRow", "res", javascript(code + "\nreturn { statusCode: 200 };"))
    (user, branchId, { branchId }, { branchId }, res).statusCode;
}
const base = { role: "admin", hasAllBranchesAccess: false, allowedBranchIds: ["zz-test-629-a"] };
const mapped = { ...base, platformRoleMapping: { platformRolesEnabled: true } };
let checks = 0;
for (const declaration of globals) {
  const guard = followingGuard(declaration);
  const code = "const isGlobalAdmin = " + declaration.initializer!.getText(tree) + ";\n" + guard.getText(tree);
  const route = routeOf(declaration)!;
  assert.equal(guardResult(code, mapped), 403, route + ": mapped admin must retain its real branch limit");
  assert.equal(guardResult(code, base), 200, route + ": flag-off legacy admin behavior stays unchanged");
  assert.equal(guardResult(code, { ...mapped, hasAllBranchesAccess: true, allowedBranchIds: [] }), 200, route + ": explicit all-branch reach remains");
  if (route !== "/api/leave-policies") assert.equal(guardResult(code, mapped, "zz-test-629-a"), 200, route + ": own branch remains reachable");
  checks++; console.log("PASS actual branch guard " + route);
}
const allowed = new Function(javascript("const allowed = " + leaveAllowed!.initializer!.getText(tree) + ";") + "\nreturn allowed;")();
assert.equal(allowed(mapped, "zz-test-629-b"), false);
assert.equal(allowed(mapped, "zz-test-629-a"), true);
assert.equal(allowed(base, "zz-test-629-b"), true);
checks++; console.log("PASS actual shared leave branch rule");
const emptyCode = emptyBranchGuard!.getText(tree);
assert.equal(guardResult(emptyCode, { ...mapped, allowedBranchIds: [] }), 403);
assert.equal(guardResult(emptyCode, { ...base, allowedBranchIds: [] }), 200);
checks++; console.log("PASS actual leave-type empty-reach guard");
console.log(JSON.stringify({ passed: true, checks, database: false, network: false }));
