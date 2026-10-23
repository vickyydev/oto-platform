// SCRUM-630: actual shared decisions and client closures, without a server or database.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { canViewHrSalary, canEditHrSalary, hrPayResponse, redactHrPay, type HrSalarySubject } from "../shared/hr-salary-permission";
import { canManagePayroll, canConfirmPayroll, canLockPayroll, canDraftPayrollProfiles } from "../shared/payroll-config";
import { payrollMenuFor, redirectTarget, OLD_PAYROLL_REDIRECTS, PAYROLL_PATHS } from "../client/src/lib/payroll/nav";

const subject = (role: "admin" | "manager" | "staff", salary: boolean): HrSalarySubject => ({
  role, platformRoleMapping: { platformRolesEnabled: true,
    userId: "zz-test-630-user", operatorId: "01900000-0000-7000-8000-000000000002",
    tenantId: "01900000-0000-7000-8000-000000000003", role,
    permissions: { "hr:salary:view": salary } },
});
let passed = 0, failed = 0;
async function check(name: string, action: () => unknown | Promise<unknown>) {
  try { await action(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + (error instanceof Error ? error.message : "ASSERTION")); }
}
function tree(file: string) {
  const source = fs.readFileSync(new URL("../client/src/" + file, import.meta.url), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function declaration(root: ts.SourceFile, name: string) {
  const found: ts.VariableDeclaration[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(root); assert.equal(found.length, 1, "the actual client declaration is unique: " + name);
  assert.ok(found[0].initializer); return found[0].initializer;
}
function expression(root: ts.SourceFile, node: ts.Node, bindings: Record<string, unknown>) {
  const code = ts.transpileModule("const actual = " + node.getText(root) + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(bindings), code + "\nreturn actual;")(...Object.values(bindings));
}

await check("flag-off role strings and user objects retain the exact original role matrix", () => {
  for (const role of ["admin", "global_admin", "operator_admin", "manager", "staff", "advisor", "owner", "payroll_admin", "unknown"]) {
    const allowed = ["admin", "global_admin", "operator_admin"].includes(role);
    assert.equal(canViewHrSalary(role), allowed); assert.equal(canViewHrSalary({ role }), allowed);
    assert.equal(canEditHrSalary(role), allowed); assert.equal(canEditHrSalary({ role }), allowed);
  }
  for (const value of [undefined, null, ""]) assert.equal(canViewHrSalary(value), false);
});
await check("enabled claim grants salary view independently from manager/staff role and denies admin without view", () => {
  for (const role of ["admin", "manager", "staff"] as const) {
    assert.equal(canViewHrSalary(subject(role, true)), true, role + " with the explicit view grant");
    assert.equal(canViewHrSalary(subject(role, false)), false, role + " without the view grant");
  }
});
await check("present malformed or mismatched mapping never falls back to an admin role", () => {
  const valid = (subject("admin", true) as { platformRoleMapping: Record<string, unknown> }).platformRoleMapping;
  for (const mapping of [null, false, {}, { ...valid, platformRolesEnabled: false }, { ...valid, role: "manager" },
    { ...valid, permissions: undefined }, { ...valid, permissions: { "hr:salary:view": "true" } },
    { ...valid, permissions: { "hr:salary:view": true, "hr:salary:edit": true } }]) {
    assert.equal(canViewHrSalary({ role: "admin", platformRoleMapping: mapping }), false);
    assert.equal(canEditHrSalary({ role: "admin", platformRoleMapping: mapping }), false);
  }
  assert.equal(canViewHrSalary({ role: "advisor", platformRoleMapping: valid }), false);
});
await check("view-only manager/staff gain no salary-edit or payroll write action", () => {
  for (const role of ["manager", "staff"] as const) for (const allowed of [true, false]) {
    const user = subject(role, allowed);
    for (const decide of [canEditHrSalary, canManagePayroll, canConfirmPayroll, canLockPayroll, canDraftPayrollProfiles]) assert.equal(decide(user), false);
  }
  for (const decide of [canEditHrSalary, canManagePayroll, canConfirmPayroll, canLockPayroll, canDraftPayrollProfiles]) assert.equal(decide(subject("admin", false)), false);
  for (const decide of [canEditHrSalary, canManagePayroll, canConfirmPayroll]) assert.equal(decide(subject("admin", true)), true);
  assert.equal(canLockPayroll(subject("admin", true)), false); assert.equal(canDraftPayrollProfiles(subject("admin", true)), false);
  assert.equal(canLockPayroll({ role: "operator_admin" }), true); assert.equal(canDraftPayrollProfiles({ role: "global_admin" }), true);
});
await check("actual HR response redaction follows the claim without mutating employee data", () => {
  const value = { id: "zz-test-630-employee", dailyRate: 123, defaultMergeData: { salaryThb: 456, positionTitle: "ZZ TEST role" },
    changes: [{ changeType: "salary_adjustment", newSalary: 456, note: "ZZ TEST pay" }] };
  const before = structuredClone(value);
  assert.deepEqual(hrPayResponse(value, subject("manager", true)), value);
  assert.deepEqual(hrPayResponse(value, subject("admin", false)), redactHrPay(value));
  assert.deepEqual(value, before);
});
await check("actual payroll menu and old redirects use context and keep own payslips", () => {
  for (const user of [subject("manager", true), subject("staff", true)]) {
    assert.ok(payrollMenuFor(user).some(entry => entry.id === "hub"));
    for (const route of OLD_PAYROLL_REDIRECTS) assert.equal(redirectTarget(route, { employeeId: "zz-test-630-employee" }, user), route.to({ employeeId: "zz-test-630-employee" }));
  }
  assert.deepEqual(payrollMenuFor(subject("admin", false)).map(entry => entry.id), ["myPayslips"]);
  for (const route of OLD_PAYROLL_REDIRECTS) assert.equal(redirectTarget(route, {}, subject("admin", false)), PAYROLL_PATHS.myPayslips);
});
await check("actual payroll page wrapper admits a view-only user and redirects admin without view", () => {
  const root = tree("App.tsx"), found = root.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "PayrollProtectedLayout");
  assert.equal(found.length, 1, "the actual company-payroll read guard exists once");
  const code = ts.transpileModule(found[0].getText(root), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const Redirect = Symbol("redirect"), HRProtectedLayout = Symbol("hr"), Component = Symbol("page");
  for (const [user, allowed] of [[subject("manager", true), true], [subject("admin", false), false], [{ role: "admin" }, true], [{ role: "manager" }, false]] as const) {
    const guard = new Function("React", "useAuth", "canViewHrSalary", "Redirect", "PAYROLL_PATHS", "HRProtectedLayout", code + "\nreturn PayrollProtectedLayout;")(
      { createElement: (type: unknown, props: unknown) => ({ type, props }) }, () => ({ user }), canViewHrSalary, Redirect, PAYROLL_PATHS, HRProtectedLayout);
    const result = guard({ component: Component }); assert.equal(result.type, allowed ? HRProtectedLayout : Redirect);
    if (!allowed) assert.equal(result.props.to, PAYROLL_PATHS.myPayslips);
  }
});
await check("actual editor payload closure strips pay for view-only users but preserves ordinary fields", () => {
  const root = tree("pages/employee-editor-page.tsx");
  const protect = expression(root, declaration(root, "withoutPayUnlessPayroll"), { canViewSalary: true, canEditSalary: false, redactHrPay });
  const value = { fullName: "ZZ TEST editor", defaultMergeData: { salaryThb: 456, positionTitle: "ZZ TEST title" }, dailyRate: 123 };
  assert.deepEqual(protect(value), redactHrPay(value));
  assert.equal(value.dailyRate, 123);
});
await check("actual terms choices withhold pay mutations from a view-only user", () => {
  const root = tree("components/update-terms-modal.tsx");
  const bindings = { DollarSign: 1, Briefcase: 2, FileText: 3, Building2: 4 };
  const changeTypes = expression(root, declaration(root, "changeTypes"), bindings);
  const PAY_CHANGE_TYPES = expression(root, declaration(root, "PAY_CHANGE_TYPES"), {});
  const offered = expression(root, declaration(root, "offeredChangeTypes"), { canViewSalary: true, canEditSalary: false, changeTypes, PAY_CHANGE_TYPES });
  assert.deepEqual(offered.map((entry: { value: string }) => entry.value), ["title_change", "branch_transfer"]);
});
console.log(JSON.stringify({ suite: "platform-salary-permission", passed, failed, database: false, network: false, clientFunctionsExecuted: true }));
if (failed) process.exitCode = 1;
