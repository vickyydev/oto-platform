import type { CompanyPayLine, CompanyPerson, ServiceDistribution } from "./company-model";
const money = (v: number, currency = "THB") => `${v < 0 ? "−" : ""}${currency === "MYR" ? "RM" : "฿"}${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const days = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
/** The one cost centre that is not a branch keeps its constant label. */
export const OWNER_NON_OPERATIONAL_LABEL = "Owner – non-operational";
/**
 * Cost-centre display names. The prototype hard-coded its fictional branch
 * ids and names here (prototype :4-6); the names now come from the world's
 * `costCentreNames` (our `branches.name`). An unnamed id reads "the branch",
 * the prototype's own fallback.
 */
const place = (id: string, names?: Record<string, string>) =>
  id === "owner-non-operational" ? OWNER_NON_OPERATIONAL_LABEL : names?.[id] ?? "the branch";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const placeIds = (names?: Record<string, string>) => new RegExp(
  [...Object.keys(names ?? {}).sort((a, b) => b.length - a.length).map(escapeRegExp), "owner-non-operational"].join("|"), "g");
export function sanitizeFormula(text: string, names?: Record<string, string>): string {
  return text.replace(/\bInput:\s*/gi, "").replace(placeIds(names), id => place(id, names))
    .replace(/\b(?:staff|emp|rule|asg|acct|acc|pa|run|manual)[-_:][\w:-]+/gi, "")
    .replace(/\b(?:hkc|hch|pok)-\d+/g, "the person")
    .replace(/\bdenominator\s*/gi, "eligible days ").replace(/\bretained\s+0(?:\.0+)?\b/gi, "")
    .replace(/\d+\.\d{3,}/g, m => Number(m).toFixed(2)).replace(/\s{2,}/g, " ").trim();
}
export function payLineExplanation(line: CompanyPayLine, person: CompanyPerson, service?: ServiceDistribution[], names?: Record<string, string>): string {
  const m = (n: number) => money(n, person.currency);
  const signed = line.category === "deduction" ? -Math.abs(line.amount) : line.amount;
  if (line.overridden) return `Set by hand to ${m(signed)} (override with a reason).`;
  if (line.component === "salary") return `${person.workerType === "day-rate" ? `Day-rate pay for ${days(person.daysWorked)} days worked` : `Monthly pay for ${days(person.employedDays)} of ${person.prorationDivisor ?? 30} calendar days`} = ${m(line.amount)}.`;
  if (line.component === "sc") {
    const s = service?.find(s => line.id === `sc:${s.branchId}`) ?? service?.find(s => line.allocations.some(a => a.costCentre === s.branchId));
    const me = s?.people.find(p => p.staffId === person.id);
    if (s && me) {
      const first = `${s.earningMonth}-01`, last = `${s.earningMonth}-${new Date(Number(s.earningMonth.slice(0, 4)), Number(s.earningMonth.slice(5)), 0).getDate()}`;
      const start = person.joinedOn > first ? person.joinedOn : first, end = person.lastWorkingDay && person.lastWorkingDay < last ? person.lastWorkingDay : last;
      const employed = Math.max(0, (Date.parse(end) - Date.parse(start)) / 86400000 + 1);
      const share = s.basis === "calendar" && employed > 0 ? ` (${days(me.units / employed * 100)}% of ${days(employed)})` : "";
      const rate = `${person.currency === "MYR" ? "RM" : "฿"}${s.dayRate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      return `${new Date(`${s.earningMonth}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${place(s.branchId, names)} pool ${m(s.pool)} over ${days(s.denominator)} total ${s.basis === "equal" || s.basis === "role-weight" ? "shares" : "days"} = ${rate}/day × ${days(me.units)} days${share} = ${m(line.amount)}. ${retainedServiceText(s.retained, person.currency)}`;
    }
    return `Service charge earned last month = ${m(line.amount)}.`;
  }
  if (line.component === "sso") {
    const terms = line.formula.match(/min\(([\d.]+),\s*([\d.]+)\)\s*×\s*([\d.]+)%/);
    const wage = terms ? Math.min(+terms[1], +terms[2]) : person.lines.filter(l => l.ssoWage && l.category === "earning").reduce((n, l) => n + l.amount, 0);
    return `Deducted from pay: SSO ${terms?.[3] ?? "5"}% of ${m(wage)} = ${m(signed)}${terms ? " (rounded to whole baht)" : ""}.`;
  }
  if (line.category === "employer") return `Paid by the company on top of pay: ${line.label} = ${m(line.amount)}.`;
  if (line.category === "deduction") return `Deducted from pay: ${line.label} = ${m(signed)}. ${sanitizeFormula(line.formula, names)}`;
  return `${line.label}: ${sanitizeFormula(line.formula, names)} = ${m(line.amount)}.`;
}
export function derivedExplanation(p: CompanyPerson, key: "gross" | "net" | "total-cost"): string {
  const m = (v: number) => money(v, p.currency);
  return key === "gross" ? `All earnings added up = ${m(p.gross)}.` : key === "net" ? `Gross ${m(p.gross)} minus deductions ${m(-p.deductions)} = take-home ${m(p.net)}.` : `Gross ${m(p.gross)} plus company contributions ${m(p.employer)} = ${m(p.totalCost)}.`;
}

/** Ported from the prototype's demo-policy-migration.ts, the one part the outputs use (plan §2). */
export function retainedServiceText(amount: number, currency: "THB" | "MYR" = "THB"): string {
  return `Kept by the company: ${currency === "THB" ? "฿" : "RM"}${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} — share of staff who don't receive service charge`;
}
