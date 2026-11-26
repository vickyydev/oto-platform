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
import { rulesFromReading, type ClauseRulePlan } from "../../../server/payroll/clause-rules";
import { bonusParts, checkReading, parseReading, type ClauseReading } from "../../../shared/payroll-clause-reading";
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
test("the 0,002% clause keeps its rate and carries the 90-baht question", () => {
  const w = fixture.wordings.find((x) => x.n === 14)!;
  const part = bonusParts(w.reading)[0];
  assert.ok(part, "wording 14 has its bonus part");
  assert.equal(part.bonus!.percent, 0.002);
  assert.equal(part.bonus!.threshold, 4_500_000);
  assert.ok(w.reading.questions.some((q) => /\b90\b/.test(q)), "a question names the 90 baht");
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
