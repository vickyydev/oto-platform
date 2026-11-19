// seed: none — no database, no server, no browser. Not a Playwright file.
//
// SCRUM-1034 — the deposit typed by hand in the BEO is a manager's to type or
// change (a deposit taken in cash). "Manager" is the app's own check for it:
// the roles requireManager lets through (server/auth-middleware.ts). Pinned:
//
//   1. the roles that may change it, and the words said to anyone else;
//   2. the Save's rule (depositChangeRefused, server/lib/depositSaveGuard.ts):
//      anyone else's Save that would change the stored deposit, through Party
//      Details or the billing's own deposit columns, is refused; one that
//      leaves it as stored, or says nobody changed it, goes through; a
//      manager's never is;
//   3. the BEO's Save route holds the rule before it writes anything, answers
//      403 in those words, and stays a manager's route; the editor shows the
//      field only to the same roles (the screen's half is
//      tests/beo-four-sections-ui.check.ts).
//
// Run from apps/oto-app:
//   npx tsx tests/beo-deposit-manager.check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.APP_ENV ??= "dev";

const { BEO_DEPOSIT_MANAGERS_ONLY, BEO_DEPOSIT_ROLES, mayChangeBeoDeposit } = await import("../shared/beoDepositManager");
const { depositChangeRefused } = await import("../server/lib/depositSaveGuard");

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

await check("the roles requireManager lets through may change the deposit; nobody else", () => {
  const middleware = readFileSync(new URL("../server/auth-middleware.ts", import.meta.url), "utf8");
  assert.match(middleware, /export function requireManager\([^)]*\) \{\s*return requireRole\("global_admin", "operator_admin", "admin", "manager"\)/);
  assert.deepEqual([...BEO_DEPOSIT_ROLES], ["global_admin", "operator_admin", "admin", "manager"], "the same list");
  for (const role of BEO_DEPOSIT_ROLES) assert.equal(mayChangeBeoDeposit(role), true, role);
  for (const role of ["staff", "advisor", "", null, undefined]) assert.equal(mayChangeBeoDeposit(role), false, String(role));
  assert.equal(BEO_DEPOSIT_MANAGERS_ONLY, "Only a manager can type or change the deposit.");
});

const STORED = { amountThb: 3000, date: "2099-05-01" };
const STORED_BILLING = { depositPaid: true, depositPaidAmount: 3000, depositPaidAt: "2099-05-01" };
const refused = (o: Partial<Parameters<typeof depositChangeRefused>[0]>) =>
  depositChangeRefused({ mayChange: false, depositChanged: true, partyDetails: undefined, billing: {}, stored: STORED, storedBilling: STORED_BILLING, ...o });

await check("anyone else's Save that changes the deposit through Party Details is refused", () => {
  assert.equal(refused({ partyDetails: { prepaymentReceived: 4000, depositDate: "2099-05-01" } }), true, "another amount");
  assert.equal(refused({ partyDetails: { prepaymentReceived: 3000, depositDate: "2099-05-02" } }), true, "another day");
  assert.equal(refused({ partyDetails: { prepaymentReceived: 0 } }), true, "cleared");
  assert.equal(refused({ depositChanged: undefined, partyDetails: { prepaymentReceived: 4000 } }), true, "a form that does not say: it names the deposit");
});

await check("anyone else's Save that leaves the deposit alone goes through", () => {
  assert.equal(refused({ partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 3000, depositDate: "2099-05-01" } }), false, "the stored deposit sent back");
  assert.equal(refused({ partyDetails: { packageName: "ZZ TEST" } }), false, "Party Details naming no deposit");
  assert.equal(refused({ depositChanged: false, partyDetails: { prepaymentReceived: 9000 } }), false, "the form says nobody changed it: the stored one is kept by the Save's own rule");
  assert.equal(refused({ partyDetails: undefined, billing: undefined }), false);
  assert.equal(
    depositChangeRefused({ mayChange: false, depositChanged: true, partyDetails: { prepaymentReceived: 0, depositDate: "" }, billing: {}, stored: { amountThb: 0, date: null }, storedBilling: null }),
    false,
    "no deposit stays no deposit",
  );
});

await check("anyone else's Save that changes the billing's own deposit columns is refused; other billing keys are not the deposit", () => {
  assert.equal(refused({ billing: { depositPaidAmount: 5000 } }), true);
  assert.equal(refused({ billing: { depositPaid: false } }), true, "unpaid");
  assert.equal(refused({ billing: { depositPaidAmount: 3000 } }), false, "the stored figure");
  assert.equal(refused({ billing: { notes: "ZZ TEST" } }), false);
});

await check("a manager's Save is never refused here", () => {
  assert.equal(depositChangeRefused({ mayChange: true, depositChanged: true, partyDetails: { prepaymentReceived: 9000 }, billing: { depositPaidAmount: 9000 }, stored: STORED, storedBilling: STORED_BILLING }), false);
});

await check("the BEO's Save holds the rule before it writes anything, in those words; the route stays a manager's; the editor asks the same roles", () => {
  const routes = readFileSync(new URL("../server/beo-routes.ts", import.meta.url), "utf8");
  const start = routes.indexOf('app.put("/api/events/:eventId/beo", requireAuth, requireManager,');
  assert.ok(start > 0, "the Save route is still behind requireManager");
  const handler = routes.slice(start, routes.indexOf("\n  });\n", start));
  const guard = handler.indexOf("if (!mayChangeBeoDeposit(req.userWithAccess?.role)) {");
  assert.ok(guard > 0, "the rule is held in the Save");
  assert.match(handler.slice(guard), /return res\.status\(403\)\.json\(\{ error: BEO_DEPOSIT_MANAGERS_ONLY \}\);/);
  for (const write of ["await db.update(coreEvents)", "await db.update(beoPartyHostAssignments)", "await db.insert(beoSetupPlans)", "writeKitchenPlanRow(", "writeBarPlanRow(", "await tx.update(beoEventBilling)"]) {
    const at = handler.indexOf(write);
    assert.ok(at > guard, `before ${write}`);
  }
  const editor = readFileSync(new URL("../client/src/components/beo/beo-event-editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /const canChangeDeposit = !readOnly && mayChangeBeoDeposit\(user\?\.role\);/);
  assert.match(editor, /canChangeDeposit \? \(/);
});

console.log(`beo-deposit-manager.check: ${checks} checks passed`);
process.exit(checks === 6 ? 0 : 1);
