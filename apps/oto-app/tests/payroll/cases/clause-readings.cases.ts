// SCRUM-1075 — the park's real incentive clauses and their readings, pinned.
//
// tests/fixtures/payroll/clause-readings/park-clauses.json holds the 14
// wordings found on the park group's HR profiles (no names: how many people
// carry each) and, for each, the reading decided on staging: approved, not an
// incentive, or still waiting (with why). A later change to the guards
// (`checkReading`), to the reading-to-rule conversion (`rulesFromReading`)
// or to the engine cannot alter what a decided reading pays without one of
// these failing:
//   1. each wording is the clause as written (its sha256 is pinned);
//   2. payroll's own checks leave each reading exactly as it was decided;
//   3. the owner's ruling holds: service charge, a salary rise and housing are
//      never bonus parts, and the 0,002% clause carries its 90-baht question;
//   4. every approved reading becomes exactly the pinned rules;
//   5. those rules, assigned to people of the prototype's fictional seed world
//      and run by the payroll engine on its October 2026 figures, pay exactly
//      the pinned amounts (the fixture's own counts and items typed in).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeSuite, test } from "../harness";
import { createSeedData } from "../seed-world";
import { calculateCompanyIncentives } from "../../../server/payroll/engine/company-awards";
import { revenuePeriods } from "../../../server/payroll/engine/clause-park";
import { rulesFromReading, type ClauseRulePlan } from "../../../server/payroll/clause-rules";
import { bonusParts, checkReading, parseReading, type ClauseReading } from "../../../shared/payroll-clause-reading";
import { parkFromWords, settleClause } from "../../../shared/payroll-clause-policy";
import type { CompanyIncentive, CompanyPayrollDocument } from "../../../server/payroll/engine/company-model";
describeSuite("clause-readings (SCRUM-1075)");

interface PinnedRule { kind: string; rate: number; inputKey: string; target: number | null; cap: number | null; streams: string[]; branches: string[]; team: string; name: string }
interface Wording {
  n: number; text: string; people: number; sha256: string;
  decision: "approved" | "not-incentive" | "waiting"; why?: string; source: "ai" | "person";
  reading: ClauseReading;
  /** Seed-world people the approved rules are assigned to in check 5, and what the engine pays each. */
  assignees?: string[];
  /** The first assignee's plans: a rule of its own, or a team pool joined. */
  rules?: (PinnedRule | { joined: true; name: string })[];
  amounts?: Record<string, number>;
}
interface Fixture {
  month: string;
  /** Staging's stream keys, as the seed world's streams, for checks 4 and 5. */
  streams: Record<string, string[]>;
  /** A team pool's rule id on staging (which a joining reading names), as the wording and part that made it. */
  pools: Record<string, { n: number; part: number }>;
  /** The month's sales on the seed world (staging's typed figures), replacing the seed's own. */
  revenue?: CompanyPayrollDocument["months"][string]["revenue"];
  counts: Record<string, number>;
  units: Record<string, Record<string, number>>;
  wordings: Wording[];
}
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "payroll", "clause-readings", "park-clauses.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
const sha = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
const seed = createSeedData();
const staff = Object.values(seed.branches).flatMap((b) => b.staff);
const branchOf = (id: string) => Object.values(seed.branches).find((b) => b.staff.some((s) => s.id === id))!.id;
const approved = () => fixture.wordings.filter((w) => w.decision === "approved")
  // A reading that joins a pool comes after the readings that make the pools.
  .sort((a, b) => Number(a.reading.parts.some((p) => p.bonus?.joinPool)) - Number(b.reading.parts.some((p) => p.bonus?.joinPool)));
const isPool = (plan: ClauseRulePlan) => (JSON.parse(plan.poolKey) as { owner: string | null }).owner === null;

/** A reading with staging's stream keys replaced by the seed world's. */
function onSeed(reading: ClauseReading): ClauseReading {
  const copy = structuredClone(reading);
  for (const part of bonusParts(copy)) if (part.bonus!.revenue) part.bonus!.revenue.streams = part.bonus!.revenue.streams.flatMap((k) => fixture.streams[k] ?? [k]);
  return copy;
}

/**
 * Every approved reading on the seed world, as approval makes it: a person's own rules, team pools made once
 * (with staging's rule id, so a reading that joins one finds it) and joined after. `own` is the rules each
 * wording pays each assignee from.
 */
function build() {
  const pools: { ruleId: string; poolKey: string; name: string }[] = [];
  const doc: CompanyPayrollDocument = structuredClone(seed.companyPayroll!);
  const from = `${fixture.month}-01`;
  doc.incentives = []; doc.incentiveVersions = []; doc.incentiveAssignments = [];
  const firstPlans = new Map<number, ClauseRulePlan[]>();
  const own = new Map<string, Set<string>>();
  for (const w of approved()) {
    for (const assignee of w.assignees!) {
      const { plans, problems } = rulesFromReading(onSeed(w.reading), {
        employeeId: assignee, homeBranchId: branchOf(assignee), branchIds: Object.keys(seed.branches),
        streamKeys: Array.from(new Set(Object.values(fixture.streams).flat())), pools,
      });
      assert.deepEqual(problems, [], `wording ${w.n} converts without problems`);
      if (!firstPlans.has(w.n)) firstPlans.set(w.n, plans);
      const mine = own.get(`${w.n}|${assignee}`) ?? new Set<string>();
      plans.forEach((plan) => {
        let ruleId = plan.join?.ruleId;
        if (!ruleId) {
          const staging = Object.entries(fixture.pools).find(([, at]) => at.n === w.n && at.part === plan.part)?.[0];
          ruleId = isPool(plan) && staging ? staging : `w${w.n}-${assignee}-${plan.part}`;
          const terms: CompanyIncentive = { ...plan.terms!, id: ruleId, effectiveFrom: from, effectiveTo: null };
          doc.incentives.push(terms);
          doc.incentiveVersions!.push({ ruleId, version: 1, terms, effectiveFrom: from, effectiveTo: null, who: "fixture", reason: "fixture", at: "" });
          if (isPool(plan)) pools.push({ ruleId, poolKey: plan.poolKey, name: plan.name });
        }
        doc.incentiveAssignments!.push({ id: `${ruleId}:${assignee}`, ruleId, staffId: assignee, effectiveFrom: from, effectiveTo: null, who: "fixture", reason: "fixture", at: "" });
        mine.add(ruleId);
      });
      own.set(`${w.n}|${assignee}`, mine);
    }
  }
  return { doc, firstPlans, own };
}

test("the fixture holds the 14 wordings on the park's HR profiles, 17 people", () => {
  assert.equal(fixture.wordings.length, 14);
  assert.deepEqual(fixture.wordings.map((w) => w.n), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.equal(fixture.wordings.reduce((n, w) => n + w.people, 0), 17);
});
test("each wording is the clause as written (sha256 pinned)", () => {
  for (const w of fixture.wordings) assert.equal(sha(w.text), w.sha256, `wording ${w.n}`);
});
test("each decided reading is a valid reading, and payroll's own checks leave it exactly as it was decided", () => {
  for (const w of fixture.wordings) {
    const parsed = parseReading(w.reading);
    assert.ok("reading" in parsed, `wording ${w.n}: ${JSON.stringify((parsed as { errors?: string[] }).errors)}`);
    const checked = checkReading(w.text, w.reading, w.source);
    assert.deepEqual(checked.notes, [], `wording ${w.n} raises no new check`);
    assert.deepEqual(checked.reading, w.reading, `wording ${w.n} is unchanged by the checks`);
  }
});
test("service charge, a salary rise and housing are never bonus parts; a reading not approved has no rule", () => {
  const byN = new Map(fixture.wordings.map((w) => [w.n, w]));
  for (const n of [3, 8, 10]) {
    assert.ok(byN.get(n)!.reading.parts.some((p) => p.type === "not-a-bonus" && p.notBonusKind === "service-charge"), `wording ${n} flags service charge`);
    assert.ok(!bonusParts(byN.get(n)!.reading).some((p) => /service\s*charge/i.test(p.quote) && !/nanny|drop/i.test(p.quote)), `wording ${n} pays no service charge as a bonus`);
  }
  for (const n of [3, 8]) assert.equal(bonusParts(byN.get(n)!.reading).length, 0, `wording ${n} pays no bonus`);
  assert.ok(byN.get(3)!.reading.parts.some((p) => p.type === "not-a-bonus" && p.notBonusKind === "salary-change"), "wording 3 flags the salary rise");
  const six = byN.get(6)!;
  assert.ok(six.reading.parts.some((p) => p.type === "not-a-bonus" && p.notBonusKind === "benefit" && /housing/i.test(p.quote)), "wording 6 flags the housing");
  assert.ok(!bonusParts(six.reading).some((p) => /housing|28/i.test(p.quote)), "the housing is not a bonus part");
  for (const w of fixture.wordings.filter((x) => x.decision !== "approved")) {
    assert.equal(w.rules, undefined, `wording ${w.n} is not approved, so it has no rule`);
    assert.ok(w.why, `wording ${w.n} says why it is not approved`);
  }
});
test("the earlier 0,002% reading records the question the owner later settled", () => {
  const w = fixture.wordings.find((x) => x.n === 14)!;
  const part = bonusParts(w.reading)[0];
  assert.ok(part, "wording 14 has its bonus part");
  assert.equal(part.bonus!.percent, 0.002);
  assert.equal(part.bonus!.threshold, 4_500_000);
  assert.ok(w.reading.questions.some((q) => /\b90\b/.test(q)), "a question names the 90 baht");
});

test("the 28 November decisions cover the park's 14 wordings", () => {
  const parks = Object.keys(seed.branches).map((id, i) => ({ id, name: i === 0 ? "Test North" : "Test South" }));
  const streams = Object.keys(fixture.streams).map(key => ({ key, label: key }));
  const settled = fixture.wordings.map(w => settleClause(w.text, w.reading, parks, streams, true));
  for (const [i, reading] of settled.entries()) {
    const w = fixture.wordings[i];
    assert.ok("reading" in parseReading(reading), `wording ${w.n} is valid`);
    assert.deepEqual(checkReading(w.text, reading, w.source).notes, [], `wording ${w.n} passes its numeric guards`);
    if ([4, 9, 10].includes(w.n)) {
      const [b] = bonusParts(reading).map(p => p.bonus!);
      assert.ok(b.childcarePool);
      assert.deepEqual([b.percent, b.team, b.split, b.joinPool], [20, "Childcare Team", "days-worked", null]);
      assert.deepEqual(b.revenue?.streams.slice().sort(), ["zz-test-drop-off", "zz-test-nanny"]);
    } else if ([5, 6, 7, 13, 14].includes(w.n)) {
      const scope = [13, 14].includes(w.n) ? "all" : "assigned";
      for (const part of bonusParts(reading)) assert.equal(part.bonus?.revenue?.branches, scope);
    } else if (w.n === 12) {
      assert.equal(bonusParts(reading)[0].bonus?.unit?.counted, "per-person");
      assert.match(bonusParts(reading)[0].plainWords, /this person hosted/);
    } else if ([3, 8].includes(w.n)) assert.equal(bonusParts(reading).length, 0);
    else assert.equal(bonusParts(reading)[0].bonus?.basis, "baht-per-unit");
  }
  const corrected = bonusParts(settled[13])[0];
  assert.equal(corrected.bonus?.percent, 0.2);
  assert.match(corrected.plainWords, /HR should correct/);
  assert.equal(settled[13].questions.length, 0);
  assert.equal(parkFromWords("Test South ticket sales", parks), `branch:${parks[1].id}`);
  assert.equal(parkFromWords("South ticket sales", parks), `branch:${parks[1].id}`);
  assert.equal(parkFromWords("combined park sales", parks), "all");
});

test("October childcare uses each park's own net sales, counts distinct days and pays the pool once", () => {
  const world = createSeedData();
  const doc = structuredClone(world.companyPayroll!);
  const [north, south] = Object.keys(world.branches);
  const members = Object.values(world.branches).flatMap(b => b.staff)
    .filter(s => s.payrollProfile && s.payrollProfile.joinedOn <= "2026-10-01" && !s.payrollProfile.lastWorkingDay).slice(0, 3);
  assert.equal(members.length, 3);
  const [one, two] = members;
  const baseDay = world.attendance[0];
  const day = (id: string, date: string, park: string, department: string | null) => ({
    ...baseDay, id: `${id}:${date}`, staffId: id, date, branchId: north, clockBranches: [park], actualClockIn: "09:00", effectiveClockIn: "09:00",
    shiftDepartments: department ? [{ branchId: park, name: department }] : [],
  });
  world.attendance = [
    day(one.id, "2026-10-06", north, "Childcare"), day(one.id, "2026-10-06", north, "Childcare"),
    day(one.id, "2026-10-07", north, null), day(two.id, "2026-10-08", north, "Childcare"),
    day(one.id, "2026-10-09", south, "Childcare"), day(two.id, "2026-10-10", south, "Reception"),
  ];
  const terms: CompanyIncentive = { id: "childcare", name: "Childcare Team", kind: "team-days", childcarePool: true,
    staffIds: members.map(s => s.id), base: { branches: [north, south], streams: ["childcare"], addBack: [] },
    rate: 20, inputKey: "", target: null, cap: null, effectiveFrom: "2026-10-01", effectiveTo: null, kpiOperator: "lt", kpiTarget: 0 };
  doc.incentives = [terms]; doc.incentiveVersions = undefined; doc.incentiveAssignments = undefined;
  doc.months["2026-10"].revenue = {
    [north]: { streams: { childcare: { amount: 300, vat: 20, serviceCharge: 10 } }, discounts: {} },
    [south]: { streams: { childcare: { amount: 1100, vat: 100, serviceCharge: 0 } }, discounts: {} },
  };
  const awards = calculateCompanyIncentives(world, doc, "2026-10", members, new Map(), []);
  assert.equal(awards.length, 3);
  const share = (id: string, park: string) => awards.find(a => a.staffId === id && a.childcare?.branchId === park);
  assert.equal(share(one.id, north)?.amount, 36);
  assert.equal(share(two.id, north)?.amount, 18);
  assert.equal(share(one.id, south)?.amount, 200);
  assert.equal(share(one.id, north)?.childcare?.clockDays, 1);
  assert.equal(awards.reduce((total, a) => total + a.amount, 0), 254);
  doc.months["2026-10"].revenue[north].streams.childcare = { amount: 0.03, vat: 0, serviceCharge: 0 };
  const fractional = calculateCompanyIncentives(world, doc, "2026-10", members, new Map(), []);
  assert.equal(fractional.filter(a => a.childcare?.branchId === north).reduce((sum, a) => sum + a.amount, 0), 0);
});
test("park selection resolves the employee's assignment, respects the approver's park and rejects an unavailable park", () => {
  const parks = [{ id: "north", name: "Test North" }, { id: "south", name: "Test South" }];
  const w = fixture.wordings.find(w => w.n === 5)!;
  const streams = Object.keys(fixture.streams).map(key => ({ key, label: key }));
  const reading = settleClause(w.text, w.reading, parks, streams, true);
  const ctx = { employeeId: "fictional", homeBranchId: "north", branchIds: ["north", "south"], streamKeys: streams.map(s => s.key), pools: [] };
  const withParks = (assignedBranchIds: string[]) => rulesFromReading(reading, { ...ctx, assignedBranchIds });
  assert.deepEqual(withParks(["south"]).plans[0]?.terms?.base.branches, ["south"]);
  assert.deepEqual(withParks(["south", "north"]).plans[0]?.terms?.base.branches, ["north", "south"]);
  assert.equal(withParks([]).plans.length, 0);
  const person = structuredClone(staff[0]);
  person.id = ctx.employeeId;
  const allocation = (date: string, centres: string[]) => ({ effectiveFrom: date, homeBranchId: "north",
    lines: centres.map(costCentre => ({ costCentre, percent: 100 / centres.length, entityId: "entity", payingAccountId: null })) });
  person.payrollProfile!.allocations = [allocation("2026-10-01", ["north"]), allocation("2026-10-10", ["south"]), allocation("2026-10-22", ["head-office"])];
  const rule = { ...withParks(["north"]).plans[0].terms!, id: "test" };
  const version = { ruleId: "test", version: 1, terms: rule, effectiveFrom: "2026-10-01", effectiveTo: null, who: "test", at: "", reason: "test" };
  const periods = revenuePeriods(version, "2026-10", [person]).map(v => [v.effectiveFrom, v.effectiveTo, v.terms.base.branches]);
  assert.deepEqual(periods, [["2026-10-01", "2026-10-09", ["north"]], ["2026-10-10", "2026-10-21", ["south"]], ["2026-10-22", "2026-10-31", ["north", "south"]]]);
  const part = bonusParts(reading)[0].bonus!;
  part.revenue!.branches = "branch:north";
  const manual = settleClause(w.text, reading, parks, streams, false);
  assert.match(manual.summary, /Test North/);
  assert.deepEqual(rulesFromReading(manual, { ...ctx, assignedBranchIds: ["south"] }).plans[0]?.terms?.base.branches, ["north"]);
  part.revenue!.branches = "branch:missing";
  assert.equal(withParks(["north"]).plans.length, 0);
});
test("a host's missing birthday count cannot use the team's total", () => {
  const w = fixture.wordings.find(w => w.n === 12)!;
  const person = staff.find(s => s.payrollProfile && s.payrollProfile.joinedOn <= "2026-10-01" && !s.payrollProfile.lastWorkingDay)!;
  const reading = settleClause(w.text, w.reading, [], [], true);
  const converted = rulesFromReading(reading, { employeeId: person.id, homeBranchId: null, branchIds: [], streamKeys: [], pools: [] });
  const terms = converted.plans[0]?.terms;
  assert.ok(terms && terms.kind === "unit");
  const doc = structuredClone(seed.companyPayroll!);
  doc.incentives = [{ ...terms, id: "host", staffIds: [person.id], effectiveFrom: "2026-10-01" }];
  doc.incentiveVersions = undefined;
  doc.incentiveAssignments = undefined;
  doc.months["2026-10"].counts = { [terms.inputKey]: 8 };
  doc.months["2026-10"].staff = {};
  const errors: import("../../../server/payroll/engine/company-model").PayrollException[] = [];
  const missing = calculateCompanyIncentives(seed, doc, "2026-10", [person], new Map(), errors);
  assert.equal(missing[0].amount, 0);
  assert.ok(errors.some(e => e.staffId === person.id && e.kind === "missing-input"));
  doc.months["2026-10"].staff[person.id] = { units: { [terms.inputKey]: 2 }, kpis: {}, bonuses: {} };
  assert.equal(calculateCompanyIncentives(seed, doc, "2026-10", [person], new Map(), [])[0].amount, 2 * terms.rate);
});
test("every approved reading becomes exactly the pinned rules", () => {
  const { firstPlans } = build();
  for (const w of approved()) {
    assert.deepEqual(firstPlans.get(w.n)!.map((p) => p.join ? { joined: true, name: p.name } : {
      kind: p.terms!.kind, rate: p.terms!.rate, inputKey: p.terms!.inputKey, target: p.terms!.target, cap: p.terms!.cap,
      streams: p.terms!.base.streams, branches: p.terms!.base.branches, team: (JSON.parse(p.poolKey) as { team: string }).team, name: p.name,
    }), w.rules, `wording ${w.n}`);
  }
});
test("the payroll engine pays every approved reading exactly the pinned amounts on October's figures", () => {
  const { doc, own } = build();
  const month = doc.months[fixture.month];
  if (fixture.revenue) month.revenue = structuredClone(fixture.revenue);
  month.counts = { ...month.counts, ...fixture.counts };
  for (const [person, units] of Object.entries(fixture.units)) {
    const input = month.staff[person] ??= { units: {}, kpis: {}, bonuses: {} };
    input.units = { ...input.units, ...units };
  }
  const awards = calculateCompanyIncentives(seed, doc, fixture.month, staff, new Map(), []);
  for (const w of approved()) {
    const got: Record<string, number> = {};
    for (const assignee of w.assignees!) {
      const rules = own.get(`${w.n}|${assignee}`)!;
      got[assignee] = Math.round(awards.filter((a) => a.staffId === assignee && rules.has(a.ruleId)).reduce((n, a) => n + a.amount, 0) * 100) / 100;
    }
    assert.deepEqual(got, w.amounts, `wording ${w.n}`);
  }
});
