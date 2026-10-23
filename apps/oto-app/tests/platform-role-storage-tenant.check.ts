// Execute the actual storage method with local query doubles. The root gate also
// exercises this path against an isolated database; this check never opens one.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
const methods: ts.MethodDeclaration[] = [];
const walk = (node: ts.Node) => {
  if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "getUserWithBranchAccess" && node.body) methods.push(node);
  ts.forEachChild(node, walk);
};
walk(tree); assert.equal(methods.length, 1, "one actual storage method is executed");
const table = (name: string, names: string[]) => ({ table: name, ...Object.fromEntries(names.map(column => [column, column])) });
const branches = table("branches", ["id", "tenantId", "operatorId"]);
const tenants = table("tenants", ["id", "slug"]);
const employees = table("employees", ["id", "userId", "personId", "profilePhotoPath", "email", "phoneE164", "fullName"]);
const policies = table("accessPolicies", ["personId", "tenantId", "coreUserId"]);
const people = table("people", ["id", "email"]);
const tenantA = "zz-test-629-tenant-a", tenantB = "zz-test-629-tenant-b", userId = "zz-test-629-advisor";
const branchA = "zz-test-629-branch-a";
const rows: Record<string, any[]> = {
  branches: [{ id: "zz-test-629-branch-b", tenantId: tenantB }, { id: branchA, tenantId: tenantA }],
  tenants: [{ id: tenantB, slug: "default" }], employees: [], people: [],
  accessPolicies: [
    { tenantId: tenantA, coreUserId: userId, modules: { core: true, hr: false, studio: false }, accessLevel: "STAFF", branchScope: "SELECTED", branchIds: [branchA] },
    { tenantId: tenantB, coreUserId: userId, modules: { core: false, hr: true, studio: true }, accessLevel: "ADMIN", branchScope: "ALL", branchIds: [] },
  ],
};
type Predicate = (row: any) => boolean;
const eq = (column: string, value: unknown): Predicate => row => row[column] === value;
const and = (...predicates: Predicate[]): Predicate => row => predicates.every(predicate => predicate(row));
const db = { select(selection?: Record<string, string>) {
  return { from(target: { table: string }) {
    let filtered = [...rows[target.table]];
    const query: any = {
      where(predicate: Predicate) { filtered = filtered.filter(predicate); return query; },
      limit(limit: number) { filtered = filtered.slice(0, limit); return query; },
      then(resolve: (value: any[]) => unknown, reject: (error: unknown) => unknown) {
        const result = selection ? filtered.map(row => Object.fromEntries(Object.entries(selection).map(([key, column]) => [key, row[column]]))) : filtered;
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return query;
  } };
} };
const code = ts.transpileModule("class StorageProbe { " + methods[0].getText(tree) + " }", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const StorageProbe = new Function("db", "branches", "tenants", "employees", "accessPolicies", "people", "eq", "and", "sql", "DEFAULT_TENANT_SLUG",
  code + "\nreturn StorageProbe;")(db, branches, tenants, employees, policies, people, eq, and, () => { throw new Error("UNEXPECTED_SQL_LOOKUP"); }, "default");
const probe = new StorageProbe();
probe.getUser = async () => ({ id: userId, role: "advisor", operatorId: "zz-test-629-entity-a", isActive: true });
probe.getUserBranchAccess = async () => [];

const legacy = await probe.getUserWithBranchAccess(userId);
assert.equal(legacy.tenantId, tenantB, "legacy fallback stays unchanged");
assert.equal(legacy.role, "admin"); assert.equal(legacy.hasAllBranchesAccess, true);
const mapped = await probe.getUserWithBranchAccess(userId, { tenantId: tenantA });
assert.equal(mapped.tenantId, tenantA, "verified mapped tenant must precede first-branch fallback");
assert.equal(mapped.role, "staff", "advisor policy comes from the verified tenant");
assert.equal(mapped.hasAllBranchesAccess, false); assert.deepEqual(mapped.allowedBranchIds, [branchA]);
assert.deepEqual(mapped.modules, { core: true, hr: false, studio: false });
console.log(JSON.stringify({ passed: true, checks: 2, database: false, network: false }));
