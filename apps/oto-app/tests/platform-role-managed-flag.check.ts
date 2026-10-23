// Execute the actual generic writer guard. Hidden form metadata is not a write fence.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../server/data-admin/admin.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("admin.ts", source, ts.ScriptTarget.Latest, true);
const methods: ts.MethodDeclaration[] = [];
const walk = (node: ts.Node) => {
  if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "scopedWrite" && node.body) methods.push(node);
  ts.forEachChild(node, walk);
};
walk(tree); assert.equal(methods.length, 1);
class ScopeError extends Error { constructor(public status: number, message: string) { super(message); } }
const code = ts.transpileModule("class WriterProbe { " + methods[0].getText(tree) + " }", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const WriterProbe = new Function("currentTenant", "getTableColumns", "getTableConfig", "DataAdminScopeError", "users", "modelTables",
  code + "\nreturn WriterProbe;")(() => "zz-test-629-tenant-a", () => ({ tenantId: {} }),
  () => ({ name: "operators", foreignKeys: [] }), ScopeError, {}, {});
const probe = new WriterProbe(); probe.table = {}; probe.formFields = [];
const denied = (error: unknown) => error instanceof ScopeError && error.status === 409;
for (const enabled of [true, false]) await assert.rejects(probe.scopedWrite({ name: "ZZ TEST entity", platformRolesEnabled: enabled }), denied,
  "ordinary generic create cannot supply the internal flag");
await assert.rejects(probe.scopedWrite({ platformRolesEnabled: true }, { platformRolesEnabled: false }), denied);
await assert.rejects(probe.scopedWrite({ platformRolesEnabled: false }, { platformRolesEnabled: true }), denied);
const unchanged = await probe.scopedWrite({ name: "ZZ TEST renamed", platformRolesEnabled: true }, { platformRolesEnabled: true });
assert.equal("platformRolesEnabled" in unchanged, false, "generic writer never persists the flag even when echoed unchanged");
assert.equal(unchanged.name, "ZZ TEST renamed");
assert.equal(unchanged.tenantId, "zz-test-629-tenant-a");
console.log(JSON.stringify({ passed: true, checks: 5, database: false, network: false }));
