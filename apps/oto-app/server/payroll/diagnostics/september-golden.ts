// The September golden evaluation, ported verbatim from the payroll prototype
// (imports/oto-app/client/src/lib/payroll-prototype/september-golden.ts): the
// eleven checks, the prototype's tolerance (integer cents ±1 for THB, 1e-7 for
// days and rates, exact text and reconciliation), the bank-file byte check and
// the remove-mode comparison. Pure: in-memory inputs, no database. It is the
// acceptance test for the engine (plan §6, engine leg) and what the R1
// diagnostics page will run on the server.
import { calculateCompanyEngine } from "../engine/company-calculations";
import { generateCompanyOutputs } from "../engine/company-outputs";
import { money } from "../engine/company-math";
import { validateCompanyDocument } from "../engine/company-validation";
import { buildSeptemberGoldenFixture, GOLDEN_ENTITY, GOLDEN_MONTH } from "./september-golden-fixture";

export interface GoldenAssertion { label: string; expected: number | string; actual: number | string; pass: boolean; unit?: string }
export interface GoldenCheck { id: number; title: string; pass: boolean; assertions: GoldenAssertion[] }
export interface GoldenTestReport {
  pass: boolean; checks: GoldenCheck[]; notices: string[];
  comparison: { keepPool: number; keepDays: number; keepRate: number; keepPaid: number; keepRetained: number;
    removeDays: number; removeRate: number; removePaid: number; increase: number;
    people: { name: string; keep: number; remove: number; increase: number }[] };
}
export function evaluateSeptemberGoldenFixture(fixture: ReturnType<typeof buildSeptemberGoldenFixture>): GoldenTestReport {
  const { data, doc } = fixture;
  validateCompanyDocument(doc);
  const calc = calculateCompanyEngine(data, doc, GOLDEN_MONTH);
  const result = calc.entities.find(e => e.entityId === GOLDEN_ENTITY)!;
  const outputs = generateCompanyOutputs(data, calc, GOLDEN_ENTITY);
  const checks: GoldenCheck[] = [];
  const person = (id: string) => {
    const p = result.people.find(p => p.id === id);
    if (!p) throw new Error(`Golden fixture is missing ${id}.`);
    return p;
  };
  const component = (id: string, key: string) => person(id).components[key] ?? 0;
  const branchAmount = (id: string, key: string, branch: string) => money(person(id).lines.filter(l => l.component === key)
    .flatMap(l => l.allocations).filter(a => a.costCentre === branch).reduce((n, a) => n + a.amount, 0));
  const assertion = (label: string, expected: number | string, actual: number | string, unit = "THB"): GoldenAssertion => ({
    label, expected, actual, unit,
    // Compare integer cents, not binary floating-point <= .01 comparisons.
    pass: typeof expected === "number" && typeof actual === "number" && Number.isFinite(actual)
      ? unit === "THB" ? Math.abs(Math.round(actual * 100) - Math.round(expected * 100)) <= 1 : Math.abs(actual - expected) <= 1e-7
      : actual === expected,
  });
  const exact = (label: string, expected: number, actual: number) => assertion(label, expected.toFixed(2), actual.toFixed(2), "exact");
  const add = (id: number, title: string, assertions: GoldenAssertion[]) =>
    checks.push({ id, title, assertions, pass: assertions.every(a => a.pass) });
  const C = "hkt-central", H = "hkt-chalong";
  const central = calc.service.find(s => s.branchId === C)!;
  const chalong = calc.service.find(s => s.branchId === H)!;
  const gm = person("gold-gm");
  add(1, "GM: 70/30, statutory once, advance, transfers and one payslip", [
    assertion("Salary Central", 49000, branchAmount(gm.id, "salary", C)),
    assertion("Salary Chalong", 21000, branchAmount(gm.id, "salary", H)),
    assertion("Central SC pool", 97277.01, central.pool),
    assertion("Central denominator", 1274.1, central.denominator, "days"),
    assertion("Central SC rate", 76.34958794, central.dayRate, "THB/day"),
    assertion("Chalong SC pool", 40237.06, chalong.pool),
    assertion("Chalong denominator", 399.9, chalong.denominator, "days"),
    assertion("Chalong SC rate", 100.6178045, chalong.dayRate, "THB/day"),
    assertion("GM Central eligible SC days", 21.7, central.people.find(p => p.staffId === gm.id)!.units, "days"),
    assertion("GM Chalong eligible SC days", 9.3, chalong.people.find(p => p.staffId === gm.id)!.units, "days"),
    assertion("GM Central SC", 1656.79, branchAmount(gm.id, "sc", C)),
    assertion("GM Chalong SC", 935.75, branchAmount(gm.id, "sc", H)),
    assertion("GM combined SC", 2592.53, component(gm.id, "sc")),
    assertion("Combined revenue", 4717595.50, calc.incentives.find(a => a.ruleId === "gold-gm-share")!.base),
    assertion("GM incentive", 18870.38, component(gm.id, "incentive:gold-gm-share")),
    assertion("GM incentive Central", 13209.27, branchAmount(gm.id, "incentive:gold-gm-share", C)),
    assertion("GM incentive Chalong", 5661.11, branchAmount(gm.id, "incentive:gold-gm-share", H)),
    assertion("SSO once", 875, component(gm.id, "sso")),
    assertion("SSO Central", 875, branchAmount(gm.id, "sso", C)),
    exact("SSO Chalong", 0, branchAmount(gm.id, "sso", H)),
    exact("SSO line count", 1, gm.lines.filter(l => l.component === "sso").length),
    assertion("Manual PND.1", 3200, component(gm.id, "pnd1")),
    assertion("Advance repayment", 5000, component(gm.id, "advance")),
    exact("Food off", 0, component(gm.id, "food")),
    assertion("GM gross", 91462.91, gm.gross),
    assertion("GM deductions", 9075, gm.deductions),
    assertion("GM net", 82387.91, gm.net),
    exact("Transfer count", 2, gm.payments.length),
    assertion("Central-account payment", 54791.05, money(gm.payments.filter(p => p.payingAccountId === "tt-central-scb").reduce((n, p) => n + p.amount, 0))),
    assertion("Chalong-account payment", 27596.86, money(gm.payments.filter(p => p.payingAccountId === "tt-chalong-scb").reduce((n, p) => n + p.amount, 0))),
    exact("Combined GM payslip count", 1, Object.keys(outputs.payslips).filter(id => id === gm.id).length),
  ]);
  const chBonus = calc.incentives.find(a => a.ruleId === "gold-ops-h-share")!;
  add(2, "Operations bonuses and strict branch targets", [
    assertion("Central operations incentive", 7448.07, component("gold-ops-c", "incentive:gold-ops-c-share")),
    exact("Chalong operations incentive", 0, component("gold-ops-h", "incentive:gold-ops-h-share")),
    assertion("Chalong gate explanation", "target not met", !chBonus.targetMet && chBonus.formula.includes("Target not met") ? "target not met" : chBonus.formula, "text"),
  ]);
  add(3, "Event manager birthday incentive", [
    assertion("Birthday base", 441918.62, calc.incentives.find(a => a.ruleId === "gold-birthdays")!.base),
    assertion("Birthday incentive", 8838.37, component("gold-event", "incentive:gold-birthdays")),
    assertion("Central 70%", 6186.86, branchAmount("gold-event", "incentive:gold-birthdays", C)),
    assertion("Chalong 30%", 2651.51, branchAmount("gold-event", "incentive:gold-birthdays", H)),
  ]);
  const nannyExpected = [2858.34, 3334.74, 1905.56, 3017.14, 2858.34, 2858.34, 2858.34];
  add(4, "Nanny pool: 124 days, conserved cents, no service charge", [
    ...nannyExpected.flatMap((amount, i) => [assertion(`Nanny ${i + 1} pool share`, amount, component(`gold-nanny-${i + 1}`, "incentive:gold-nanny-pool")),
      exact(`Nanny ${i + 1} SC off`, 0, component(`gold-nanny-${i + 1}`, "sc"))]),
    assertion("Team days", 124, calc.incentives.filter(a => a.ruleId === "gold-nanny-pool").reduce((n, a) => n + a.units, 0), "days"),
    exact("Whole nanny pool allocated", 19690.82, money(nannyExpected.reduce((n, _, i) => n + component(`gold-nanny-${i + 1}`, "incentive:gold-nanny-pool"), 0))),
  ]);
  add(5, "Central regular employee", [
    assertion("Salary", 24000, component("gold-regular-c", "salary")), assertion("Food", 1140, component("gold-regular-c", "food")),
    assertion("SC", 2366.84, component("gold-regular-c", "sc")), assertion("Manual bonus", 2064.52, component("gold-regular-c", "manual")),
    assertion("SSO", 875, component("gold-regular-c", "sso")), assertion("Net", 28696.35, person("gold-regular-c").net),
  ]);
  add(6, "Chalong regular employee", [
    assertion("Salary", 22000, component("gold-regular-h", "salary")), assertion("Food", 900, component("gold-regular-h", "food")),
    assertion("SC", 3119.15, component("gold-regular-h", "sc")), assertion("Manual bonus", 2000, component("gold-regular-h", "manual")),
    assertion("SSO", 875, component("gold-regular-h", "sso")), assertion("Net", 27144.15, person("gold-regular-h").net),
  ]);
  add(7, "Low-earner SSO", [assertion("Salary", 14000, component("gold-low", "salary")), assertion("SSO", 700, component("gold-low", "sso"))]);
  add(8, "Contractor chef: fee-only PND.3 and eligible SC", [
    assertion("Fixed fee Central", 70000, branchAmount("gold-chef", "salary", C)), assertion("Fixed fee Chalong", 30000, branchAmount("gold-chef", "salary", H)),
    assertion("PND.3", 3000, component("gold-chef", "pnd3")), exact("SSO off", 0, component("gold-chef", "sso")),
    exact("Food off", 0, component("gold-chef", "food")), assertion("Combined SC", 2592.53, component("gold-chef", "sc")),
    assertion("Net", 99592.53, person("gold-chef").net),
  ]);
  add(9, "Student Loan Fund remittance deduction", [
    assertion("Salary", 22000, component("gold-loan", "salary")), assertion("SSO", 875, component("gold-loan", "sso")),
    assertion("Student loan", 886, component("gold-loan", "student-loan")), assertion("Deductions", 1761, person("gold-loan").deductions),
    assertion("Remittance list contains person", "yes", outputs.reports["student-loan-remittance.csv"]?.includes("gold-loan") ? "yes" : "no", "text"),
  ]);
  add(10, "Cash agency: 7% fee, no bank transfer", [
    assertion("Fee Central", 42000, branchAmount("gold-ads", "salary", C)), assertion("Fee Chalong", 18000, branchAmount("gold-ads", "salary", H)),
    assertion("Cash handling fee", 4200, component("gold-ads", "cash-fee")), assertion("Net", 55800, person("gold-ads").net),
    assertion("Cash list includes agency", "yes", outputs.cashHtml.includes(person("gold-ads").name) ? "yes" : "no", "text"),
    exact("Bank-file transfers for agency", 0, outputs.banks.flatMap(b => b.transfers).filter(p => p.staffId === "gold-ads").length),
  ]);
  add(11, "Bank files plus cash reconcile exactly", [
    exact("Files + cash = run net", result.totals.net, money(outputs.bankAmount + outputs.cashAmount)),
    exact("Reconciliation difference", 0, outputs.difference),
    exact("Cash-list total", 55800, outputs.cashAmount),
    exact("Bank file count / paying accounts", 2, outputs.banks.length),
    exact("No blocking fixture inputs", 0, result.exceptions.filter(e => e.severity === "blocking").length),
  ]);
  // Check generated file bytes too, not only the engine's payment metadata.
  let fileTotal = 0, correctReferences = true;
  for (const bank of outputs.banks) {
    const rows = bank.csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(row =>
      (row.match(/"(?:[^"]|"")*"|[^,]+|(?<=,)(?=,|$)/g) ?? []).map(field => field.replace(/^"|"$/g, "").replace(/""/g, '"')));
    const amountColumn = rows[0].indexOf("Amount"), referenceColumn = rows[0].indexOf("Reference");
    if (amountColumn < 0 || referenceColumn < 0) throw new Error("Golden bank file has no amount or reference column.");
    for (const row of rows.slice(1)) {
      const amount = Number(row[amountColumn]);
      if (!Number.isFinite(amount)) throw new Error("Golden bank file contains a non-numeric amount.");
      fileTotal += amount;
      correctReferences &&= row[referenceColumn] === "SALARY SEP26";
    }
  }
  checks[10].assertions.push(exact("CSV bytes + cash = run net", result.totals.net, money(fileTotal + outputs.cashAmount)),
    assertion("Bank-file salary references", "SALARY SEP26", correctReferences ? "SALARY SEP26" : "incorrect", "text"));
  const removedDoc = structuredClone(doc);
  removedDoc.servicePolicies[C]!.forEach(p => p.excluded = "remove");
  const removed = calculateCompanyEngine(data, removedDoc, GOLDEN_MONTH).service.find(s => s.branchId === C)!;
  const increase = money(removed.paid - central.paid);
  checks[10].assertions.push(exact("Remove mode distributes whole Central pool", central.pool, removed.paid),
    exact("Remove mode retained share", 0, removed.retained), exact("Extra SC equals released retained amount", central.retained, increase));
  checks[10].pass = checks[10].assertions.every(a => a.pass);
  return {
    pass: checks.every(c => c.pass), checks,
    notices: [
      "Expected values are unchanged. Money tolerates ±0.01 THB per amount; reconciliation and pool totals require exact cents.",
      "Supplied nanny shares sum to 19,690.80, two satang below the supplied 19,690.82 pool. Largest-remainder rounding distributes both satang; each share stays within tolerance.",
      "Supplied rounded GM branch SC sums to 2,592.54, while supplied combined SC is 2,592.53. Retain-mode pool rounding reconciles the combined pay and transfers without editing expected values.",
      "Central regular-staff listed earnings less SSO sum to 28,696.36, versus supplied net 28,696.35; this one-satang difference is reported within the requested tolerance.",
      "August SC and nanny pools are explicit pass-through fixture streams at 100%, not invented real August or nanny turnover. Birthday revenue is placed in one aggregate stream; both-branch totals are unchanged.",
      "GM PND.1 is a reasoned 3,200 manual input. Unspecified PND.1, transport, OT and leave extras are disabled in this isolated fixture. Chef PND.3 uses fixed-fee-only; agency PND.3 is explicitly 0%.",
      "The supplied denominators require an omitted August roster. Fictional prior-month leavers supply 27.3 Central and 10 Chalong eligible equivalents. Low-earner SC is off to isolate the supplied 700 SSO check. Remove-mode uplift is fixture-specific, not a claimed uplift for the complete real roster.",
    ],
    comparison: { keepPool: central.pool, keepDays: central.denominator, keepRate: central.dayRate, keepPaid: central.paid,
      keepRetained: central.retained, removeDays: removed.denominator, removeRate: removed.dayRate, removePaid: removed.paid, increase,
      people: central.people.filter(p => p.eligible).map(p => {
        const after = removed.people.find(a => a.staffId === p.staffId)!;
        return { name: p.name, keep: p.amount, remove: after.amount, increase: money(after.amount - p.amount) };
      }) },
  };
}
export function runSeptemberGoldenTest(): GoldenTestReport {
  return evaluateSeptemberGoldenFixture(buildSeptemberGoldenFixture());
}
