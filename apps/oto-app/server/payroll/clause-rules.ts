/**
 * SCRUM-1075: an approved clause reading as the payroll engine's own
 * incentive terms. Pure: no database, so the fixed test of the park's real
 * clauses pins exactly what each approved reading pays from.
 *
 * Each bonus part becomes one rule of the existing model
 * (engine/company-model.ts CompanyIncentive), read the way the engine
 * calculates (engine/company-awards.ts):
 *   - a percent of sales, the person's own   → kind "revenue": sales × rate %
 *     × eligible days / employed days; a threshold is the engine's `target`
 *     (the same sales must EXCEED it);
 *   - a percent of sales shared by a team    → kind "team-days": (sales ×
 *     rate %) shared by days worked;
 *   - baht per unit counted for the team     → kind "unit-pool": count × rate,
 *     shared by the days each person is employed in the month (equal for
 *     full months); the count is typed for the month as `count:<key>`;
 *   - baht per unit counted for one person   → kind "unit": items × rate; the
 *     items are typed per person as `units:<person>:<key>`.
 * A team pool is one rule shared by everyone whose approved clause joins it
 * (its `poolKey`); a person's own bonus is a rule of its own. What the engine
 * cannot do (a sales pool shared equally, a count shared by days worked, a
 * threshold on a count) is refused with the reason, never approximated.
 */
import type { CompanyIncentive, CompanyIncentiveKind } from "./engine/company-model";
import { bonusParts, type ClauseBonusTerms, type ClauseReading } from "@shared/payroll-clause-reading";
import { isBoothFlyer } from "@shared/booth-bonus";
import { isChildcareClause } from "@shared/payroll-clause-policy";

export const CLAUSE_RULE_PREFIX = "Contract · ";
export interface ClauseRuleContext {
  employeeId: string;
  /** The person's home branch at the start date (for "the person's own park"). */
  homeBranchId: string | null;
  assignedBranchIds?: string[];
  /** Every branch with payroll details (for "all parks"). */
  branchIds: string[];
  /** The park group's live sales streams. */
  streamKeys: string[];
  /** Approved team pools: their rule, the key of their terms, and their name. */
  pools: { ruleId: string; poolKey: string; name: string }[];
}
export interface ClauseRulePlan {
  part: number;
  poolKey: string;
  name: string;
  /** An existing rule this person is added to (a team pool), or the terms of a new rule. */
  join: { ruleId: string } | null;
  terms: Omit<CompanyIncentive, "id"> | null;
}
export const INPUT_KEY = /^[a-z][a-z0-9-]{0,39}$/;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const sorted = (list: string[]) => Array.from(new Set(list)).sort();

/** The kind of rule a bonus part is, or why the engine cannot pay it. */
export function kindOf(b: ClauseBonusTerms): { kind: CompanyIncentiveKind } | { problem: string } {
  if (b.basis === "percent-of-revenue") {
    if (b.sharing === "own") return { kind: "revenue" };
    if (b.split === "days-worked") return { kind: "team-days" };
    return { problem: b.split === "equal"
      ? "Payroll shares a team's sales pool by days worked only; it cannot split it equally. Choose days worked, or ask the owner."
      : "Say how the team shares the pool (payroll shares a sales pool by days worked)." };
  }
  if (b.threshold !== null) return { problem: "Payroll checks a threshold on sales only, not on a count. Remove the threshold or ask the owner." };
  if (b.unit?.counted === "per-person") {
    return b.sharing === "own" ? { kind: "unit" } : { problem: "A count typed for each person cannot also be shared by a team. Count it for the team, or make it the person's own." };
  }
  if (b.sharing === "team" && b.split === "days-worked") {
    return { problem: "Payroll shares a per-unit pool by the days each person is employed in the month (equal for a full month), not by days worked. Choose equal, or ask the owner." };
  }
  return { kind: "unit-pool" };
}

/**
 * The rules an approved reading pays from, one per bonus part, or the list of
 * what must be settled first. A part that joins an existing pool takes the
 * pool's rule as it is.
 */
export function rulesFromReading(reading: ClauseReading, ctx: ClauseRuleContext): { plans: ClauseRulePlan[]; problems: string[] } {
  const plans: ClauseRulePlan[] = [];
  const problems: string[] = [];
  const live = new Set(ctx.streamKeys);
  reading.parts.forEach((part, index) => {
    if (part.type === "needs-a-person") problems.push(`Part ${index + 1} ("${part.quote}") needs a person: ${part.needsPersonWhy ?? "settle it first."}`);
  });
  for (const part of bonusParts(reading)) {
    if (isBoothFlyer(part)) continue;
    const index = reading.parts.indexOf(part), b = part.bonus!;
    const where = `Part ${index + 1} ("${part.quote}")`;
    if (b.childcarePool && (!isChildcareClause(part.quote) || b.percent !== 20 || b.sharing !== "team" || b.split !== "days-worked"
      || b.joinPool || b.cap !== null || b.threshold !== null || b.revenue?.branches !== "all")) {
      problems.push(`${where}: the Childcare Team uses one 20% pool per park, shared by days worked.`); continue;
    }
    if (b.childcarePool && plans.some(p => p.terms?.childcarePool || p.poolKey === CHILDCARE_KEY)) continue;
    if (b.joinPool) {
      const pool = ctx.pools.find((p) => p.ruleId === b.joinPool);
      if (!pool) { problems.push(`${where} joins a team pool that is not approved any more. Correct the reading.`); continue; }
      plans.push({ part: index, poolKey: pool.poolKey, name: pool.name, join: { ruleId: pool.ruleId }, terms: null });
      continue;
    }
    const kind = kindOf(b);
    if ("problem" in kind) { problems.push(`${where}: ${kind.problem}`); continue; }
    const rate = b.basis === "percent-of-revenue" ? b.percent : b.bahtPerUnit;
    if (rate === null || !(rate > 0)) { problems.push(`${where}: the ${b.basis === "percent-of-revenue" ? "percent" : "baht per unit"} is missing.`); continue; }
    let branches: string[] = [], streams: string[] = [], inputKey = "";
    if (kind.kind === "revenue" || kind.kind === "team-days" || b.threshold !== null) {
      if (!b.revenue || !b.revenue.streams.length) { problems.push(`${where}: choose the sales streams it is based on.`); continue; }
      const unknown = b.revenue.streams.filter((s) => !live.has(s));
      if (unknown.length) { problems.push(`${where}: ${unknown.join(", ")} is not one of the park group's live sales streams.`); continue; }
      streams = sorted(b.revenue.streams);
      const scope = b.revenue.branches;
      if (scope === "assigned") branches = sorted((ctx.assignedBranchIds ?? []).filter(id => ctx.branchIds.includes(id)));
      else if (scope === "home") branches = ctx.homeBranchId && ctx.branchIds.includes(ctx.homeBranchId) ? [ctx.homeBranchId] : [];
      else if (scope === "all") branches = sorted(ctx.branchIds);
      else branches = ctx.branchIds.filter(id => scope === `branch:${id}`);
      if (!branches.length) { problems.push(`${where}: this selection has no trading park to take sales from. Choose a park or check the person's assignment.`); continue; }
    }
    if (kind.kind === "unit-pool" || kind.kind === "unit") {
      inputKey = b.unit?.inputKey.trim().toLowerCase() ?? "";
      if (!INPUT_KEY.test(inputKey)) { problems.push(`${where}: give the monthly count a short name (letters, digits and dashes).`); continue; }
    }
    const team = b.sharing === "team" ? (b.team ?? "").trim() : "";
    if (b.sharing === "team" && !team) { problems.push(`${where}: name the team that shares it.`); continue; }
    const described = (b.basis === "percent-of-revenue" ? b.revenue?.described : b.unit?.described)?.trim() || (b.basis === "percent-of-revenue" ? "sales" : "unit");
    const name = (CLAUSE_RULE_PREFIX + (kind.kind === "revenue"
      ? `${fmt(rate)}% of ${described}${b.threshold !== null ? `, when above ${fmt(b.threshold)}` : ""}`
      : kind.kind === "team-days" ? `${fmt(rate)}% of ${described}, shared by ${team} by days worked${b.threshold !== null ? `, when above ${fmt(b.threshold)}` : ""}`
      : kind.kind === "unit-pool" && b.sharing === "team" ? `${fmt(rate)} baht per ${described}, shared by ${team}`
      : `${fmt(rate)} baht per ${described}`) + (b.cap !== null ? `, at most ${fmt(b.cap)}` : "")).slice(0, 200);
    const owner = kind.kind === "revenue" || kind.kind === "unit" || (kind.kind === "unit-pool" && b.sharing === "own") ? ctx.employeeId : null;
    const poolKey = b.childcarePool ? CHILDCARE_KEY : JSON.stringify({ kind: kind.kind, rate, inputKey, streams, branches, target: b.threshold, cap: b.cap, team: team.toLowerCase().replace(/\s+/g, " "), owner });
    const existing = owner === null ? ctx.pools.find((p) => p.poolKey === poolKey) : undefined;
    if (existing) { plans.push({ part: index, poolKey, name: existing.name, join: { ruleId: existing.ruleId }, terms: null }); continue; }
    plans.push({ part: index, poolKey, name, join: null, terms: {
      name, kind: kind.kind, staffIds: [], base: { branches, streams, addBack: [] }, rate, inputKey,
      ...(b.childcarePool ? { childcarePool: true as const } : {}),
      ...(kind.kind === "revenue" && b.revenue?.branches === "assigned" ? { assignedRevenue: { employeeId: ctx.employeeId, parks: sorted(ctx.branchIds) } } : {}),
      target: b.threshold, cap: b.cap, effectiveFrom: "", effectiveTo: null, kpiOperator: "lt", kpiTarget: 0, enabled: true,
    } });
  }
  return { plans, problems };
}

const CHILDCARE_KEY = JSON.stringify({ kind: "team-days", team: "childcare team", owner: null, policy: "per-park-childcare" });

/** What a person must type each month for a reading's rules, in plain words. */
export function monthlyInputsOf(plans: ClauseRulePlan[]): string[] {
  return plans.flatMap((p) => !p.terms ? [] : p.terms.kind === "unit-pool" ? [`the month's count "${p.terms.inputKey}" (Run Payroll → 2. Inputs → Enter a number → Count)`]
    : p.terms.kind === "unit" ? [`this person's items "${p.terms.inputKey}" (Run Payroll → 2. Inputs → Enter a number → Items)`]
    : [`the month's sales of ${p.terms.base.streams.join(", ")} (Run Payroll → 2. Inputs → Sales)`]);
}
