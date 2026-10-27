// seed: none — this file talks to nothing. Run it with `npx tsx
// tests/platform-impersonation.test.ts`; the assertions are at module level,
// so a broken one fails the run.
//
// SCRUM-648 (S2-23 Support tools): a support administrator's "view as"
// window arrives as a marked platform exchange, and the OTO App refuses that
// window its payroll and contract routes — read or write, however it was
// approved — while every other route stays exactly as the subject sees it.
import assert from "node:assert/strict";
import {
  IMPERSONATION_READ_ONLY_MESSAGE,
  IMPERSONATION_REFUSED_MESSAGE,
  impersonationRefusal,
  readImpersonationMark,
} from "../server/lib/platformSession";

const MARK = {
  id: "01a17f7c-2843-75d7-aac6-0500359ba32f",
  actorAccountId: "01a17f7c-01f1-776d-a206-2aa65ab350ef",
  subjectAccountId: "01a17f7c-01f1-776d-a206-2aa850c3a972",
  mode: "read_only" as const,
  expiresAt: "2026-10-28T10:15:00.000Z",
};

// ─── Reading the mark off the exchange ─────────────────────────────────────────

assert.equal(readImpersonationMark(undefined), null, "an ordinary sign-on carries no mark");
assert.equal(readImpersonationMark(null), null, "an explicit null is no mark either");
assert.deepEqual(readImpersonationMark({ ...MARK }), { ...MARK, actorName: null, subjectName: null },
  "a well-formed mark is kept field for field; names the platform did not send read as null");
assert.deepEqual(readImpersonationMark({ ...MARK, actorName: "ZZ Admin", subjectName: null }),
  { ...MARK, actorName: "ZZ Admin", subjectName: null }, "the banner's names are kept as sent");
assert.deepEqual(readImpersonationMark({ ...MARK, mode: "write_allowed" })?.mode, "write_allowed");
for (const broken of [
  { ...MARK, id: "not-a-uuid" },
  { ...MARK, actorAccountId: 7 },
  { ...MARK, mode: "admin" },
  { ...MARK, expiresAt: "soon" },
  { ...MARK, actorName: 7 },
  "a string",
]) {
  assert.throws(() => readImpersonationMark(broken), /malformed/, `a malformed mark is unreadable: ${JSON.stringify(broken)}`);
}

// ─── The refusal ────────────────────────────────────────────────────────────────

for (const path of [
  "/api/payroll",
  "/api/payroll/month-status",
  "/api/payroll/runs/42/payslips",
  "/api/contracts",
  "/api/contracts/9/pdf",
  "/api/signing/abc",
  "/api/letters/unsigned/count",
  "/api/letter-sign/tok",
  "/API/Payroll/runs",
]) {
  const refused = impersonationRefusal(path, MARK);
  assert.ok(refused, `${path} is refused inside a view-as window`);
  assert.equal(refused.status, 403);
  assert.equal(refused.reason, "impersonation_refused");
  assert.equal(refused.message, IMPERSONATION_REFUSED_MESSAGE);
}
// A write-allowed window is refused the same: the approval never reaches pay or contracts.
assert.ok(impersonationRefusal("/api/payroll/runs", { ...MARK, mode: "write_allowed" }));

for (const path of ["/api/user", "/api/branches", "/api/timekeeping/live", "/api/payrolls-report", "/api/contracts-help"]) {
  assert.equal(impersonationRefusal(path, MARK), null, `${path} stays open to the window: whole segments only`);
}
// A read-only window writes nothing anywhere in this app; a write window may write outside pay and contracts.
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  const refused = impersonationRefusal("/api/tasks/7", MARK, method);
  assert.ok(refused, `${method} is refused in a read-only window`);
  assert.equal(refused.reason, "impersonation_read_only");
  assert.equal(refused.message, IMPERSONATION_READ_ONLY_MESSAGE);
  assert.equal(impersonationRefusal("/api/tasks/7", { ...MARK, mode: "write_allowed" }, method), null, `${method} passes a write window`);
  assert.equal(impersonationRefusal("/api/payroll/runs", { ...MARK, mode: "write_allowed" }, method)?.reason, "impersonation_refused");
}
assert.equal(impersonationRefusal("/api/tasks/7", MARK, "GET"), null, "reads pass a read-only window");
assert.equal(impersonationRefusal("/api/logout", MARK, "POST"), null, "the window can always be ended from inside it");

for (const path of ["/api/payroll", "/api/contracts/1"]) {
  assert.equal(impersonationRefusal(path, null), null, `${path} is untouched for an ordinary sign-on`);
  assert.equal(impersonationRefusal(path, undefined), null);
}

console.log("platform-impersonation: all assertions passed");
