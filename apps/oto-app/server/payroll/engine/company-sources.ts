import type { BranchId, PayrollWorld, StaffMember } from "./model";
import type { CompanyPayrollDocument, CompanySourceKind, CompanySourceEvidence, CompanyPayLine, CompanyInputSource } from "./company-model";
import { apportion, datesIn, employed, money } from "./company-math";
import { nextMonth, versionsForMonth } from "./company-rewards";
import { systemClock, type PayrollClock } from "./clock";

export const sourceKey = {
  sales: (branch: BranchId, stream = "total") => `sales:${branch}:${stream}`,
  days: (id: string) => `days:${id}`,
  count: (key: string) => `count:${key}`,
  units: (id: string, key: string) => `units:${id}:${key}`,
  kpi: (id: string, key: string) => `kpi:${id}:${key}`,
};
export function defaultCountSource(key: string): Exclude<CompanySourceKind, "Overridden"> {
  return /flyer|voucher/i.test(key) ? "Vouchers" : /package|setup/i.test(key) ? "POS" : /reply|message/i.test(key) ? "CRM" : "Manual";
}
export function salesValue(doc: CompanyPayrollDocument, month: string, branch: BranchId, stream?: string) {
  const revenue = doc.months[month]?.revenue[branch];
  const cells = stream ? [revenue?.streams[stream]].filter(Boolean) : Object.values(revenue?.streams ?? {});
  return money(cells.reduce((n, cell) => n + (cell!.amount - cell!.vat - cell!.serviceCharge), 0));
}
export function getInputSource(doc: CompanyPayrollDocument, month: string, key: string, value: number,
  kind: Exclude<CompanySourceKind, "Overridden">): CompanyInputSource {
  if (key.startsWith("sales:") && key.endsWith(":total")) {
    const branch = key.split(":")[1] as BranchId;
    const recorded = doc.months[month]?.sources?.[key];
    const streams = Object.entries(doc.months[month]?.revenue[branch]?.streams ?? {});
    const changed = streams.map(([stream]) => doc.months[month]?.sources?.[sourceKey.sales(branch, stream)]).filter(s => s?.reason);
    if (recorded || changed.length) {
      const last = changed.sort((a, b) => (b!.at ?? "").localeCompare(a!.at ?? ""))[0] ?? recorded;
      return { ...(recorded ?? last!), kind: "POS", current: value,
        original: recorded?.original ?? money(streams.reduce((n, [stream, cell]) => n + (doc.months[month]?.sources?.[sourceKey.sales(branch, stream)]?.original ?? cell.amount - cell.vat - cell.serviceCharge), 0)) };
    }
  }
  return doc.months[month]?.sources?.[key] ?? { kind, original: value, current: value, syncedAt: `${nextMonth(month)}-01` };
}
function writeSource(doc: CompanyPayrollDocument, month: string, key: string, prior: number, value: number,
  kind: Exclude<CompanySourceKind, "Overridden">, reason: string, who: string, entryOnly = false, clock: PayrollClock = systemClock) {
  const inputs = doc.months[month];
  const old = getInputSource(doc, month, key, prior, kind);
  inputs.sources ??= {};
  inputs.sources[key] = { ...old, original: entryOnly ? value : old.original, current: value, reason, who, overridden: !entryOnly, at: clock.now().toISOString() };
}
export function overrideCompanyInput(data: PayrollWorld, document: CompanyPayrollDocument, month: string, key: string,
  value: number, reason: string, who: string, clock: PayrollClock = systemClock): CompanyPayrollDocument {
  if (!reason.trim() || !who.trim()) throw new Error("Enter a reason and editor.");
  if (!Number.isFinite(value) || value < 0) throw new Error("Use a number of zero or more.");
  const doc = structuredClone(document), inputs = doc.months[month];
  if (!inputs) throw new Error("No inputs exist for this month.");
  const parts = key.split(":"), [type, subject, inputKey] = parts;
  const present = type === "count" ? Object.hasOwn(inputs.counts, subject) : type === "units" ? Object.hasOwn(inputs.staff[subject]?.units ?? {}, inputKey)
    : type === "kpi" ? Object.hasOwn(inputs.staff[subject]?.kpis ?? {}, inputKey) : true;
  let prior: number, kind: Exclude<CompanySourceKind, "Overridden">;
  if (type === "sales") {
    const branch = subject as BranchId, revenue = inputs.revenue[branch];
    if (!revenue) throw new Error("No branch sales are available.");
    kind = "POS"; prior = salesValue(doc, month, branch, inputKey === "total" ? undefined : inputKey);
    const totalSource = getInputSource(doc, month, sourceKey.sales(branch), salesValue(doc, month, branch), "POS");
    if (inputKey === "total") {
      const entries = Object.entries(revenue.streams);
      const total = salesValue(doc, month, branch);
      const amounts = apportion(money(value), entries.map(([, c]) => total ? c.amount - c.vat - c.serviceCharge : 1));
      if (!entries.length) throw new Error("Add at least one sales stream first.");
      entries.forEach(([stream, cell], i) => {
        const old = money(cell.amount - cell.vat - cell.serviceCharge);
        cell.amount = money(amounts[i] + cell.vat + cell.serviceCharge);
        writeSource(doc, month, sourceKey.sales(branch, stream), old, amounts[i], "POS", reason, who, false, clock);
      });
    } else {
      const cell = revenue.streams[inputKey];
      if (!cell) throw new Error("This sales stream does not exist.");
      cell.amount = money(value + cell.vat + cell.serviceCharge);
      inputs.sources ??= {};
      inputs.sources[sourceKey.sales(branch)] = { ...totalSource, current: salesValue(doc, month, branch), reason, who, at: clock.now().toISOString() };
    }
  } else if (type === "count") {
    prior = inputs.counts[subject] ?? 0; kind = defaultCountSource(subject); inputs.counts[subject] = value;
  } else if (type === "days" || type === "units" || type === "kpi") {
    const staff = Object.values(data.branches).flatMap(b => b.staff).find(s => s.id === subject);
    if (!staff) throw new Error("Person not found.");
    const row = inputs.staff[subject] ??= { units: {}, kpis: {}, bonuses: {} };
    if (type === "days") {
      const employedDays = datesIn(month).filter(d => employed(staff.payrollProfile!, d)).length;
      if (value > employedDays) throw new Error(`Days worked cannot exceed the ${employedDays} days this person was employed.`);
      prior = row.daysWorked ?? 0; kind = "Attendance"; row.daysWorked = value;
    } else {
      if (!inputKey) throw new Error("Choose an input.");
      const target = type === "units" ? row.units : row.kpis;
      prior = target[inputKey] ?? 0; kind = type === "kpi" ? defaultCountSource(inputKey) : "POS"; target[inputKey] = value;
    }
  } else throw new Error("Unknown input.");
  writeSource(doc, month, key, prior!, value, kind!, reason, who, kind! === "Manual" && !present, clock);
  doc.audit.push({ at: clock.now().toISOString(), who, reason, action: `Input reviewed and overridden: ${key}, ${prior!} → ${value} (${month})` });
  return doc;
}
function evidence(doc: CompanyPayrollDocument, month: string, key: string, value: number,
  kind: Exclude<CompanySourceKind, "Overridden">): CompanySourceEvidence {
  const input = getInputSource(doc, month, key, value, kind), changed = !!input.reason && input.overridden !== false;
  return { tag: changed ? "Overridden" : kind, key, original: input.original, current: input.current, reason: input.reason,
    explanation: changed ? `${kind} (demo): ${input.original} → ${input.current}. ${input.reason}` :
      `${kind}${kind === "Manual" ? "" : " (demo)"}, reviewed from ${month}; sample sync ${input.syncedAt}` };
}
export function companyLineSources(doc: CompanyPayrollDocument, staff: StaffMember, line: CompanyPayLine): CompanySourceEvidence[] {
  const month = line.sourceMonth;
  if (line.overridden) return [{ tag: "Overridden", explanation: `${line.formula}. ${line.inputs.filter(i => i.startsWith("Override:")).join("; ")}` }];
  if (line.component === "salary" && staff.payrollProfile?.workerType === "day-rate") return [
    evidence(doc, month, sourceKey.days(staff.id), doc.months[month]?.staff[staff.id]?.daysWorked ?? 0, "Attendance"),
    { tag: "Manual", explanation: "Day rate saved on this person's payroll profile." }];
  if (line.component === "food") {
    const value = doc.months[month]?.staff[staff.id]?.daysWorked ?? 0;
    return [evidence(doc, month, sourceKey.days(staff.id), value, "Attendance")];
  }
  if (line.component === "sc" || line.component.startsWith("incentive:")) {
    const rule = line.rewardTrace?.rule;
    if (rule?.kind === "manual") return [{ tag: "Manual", explanation: "One-off amount entered with a reason." }];
    if (rule?.kind === "unit-pool") return [evidence(doc, month, sourceKey.count(rule.inputKey),
      doc.months[month]?.counts[rule.inputKey] ?? 0, defaultCountSource(rule.inputKey))];
    if (rule?.kind === "unit" || rule?.kind === "kpi") return [evidence(doc, month, rule.kind === "unit" ? sourceKey.units(staff.id, rule.inputKey) : sourceKey.kpi(staff.id, rule.inputKey),
      (rule.kind === "unit" ? doc.months[month]?.staff[staff.id]?.units : doc.months[month]?.staff[staff.id]?.kpis)?.[rule.inputKey] ?? 0, defaultCountSource(rule.inputKey))];
    if (rule?.kind === "guarantee") return [{ tag: "Manual", explanation: "Minimum from the saved rule, less salary and calculated incentives." }];
    const branches = rule?.base.branches ?? line.allocations.map(a => a.costCentre).filter(b => b !== "owner-non-operational") as BranchId[];
    const result = Array.from(new Set(branches)).map(branch => {
      const changed = Object.entries(doc.months[month]?.sources ?? {}).find(([key, source]) => key.startsWith(`sales:${branch}:`) && source.reason);
      return changed ? evidence(doc, month, changed[0], changed[1].current, "POS") :
        evidence(doc, month, sourceKey.sales(branch), salesValue(doc, month, branch), "POS");
    });
    if (rule?.kind === "team-days") result.push(evidence(doc, month, sourceKey.days(staff.id), doc.months[month]?.staff[staff.id]?.daysWorked ?? 0, "Attendance"));
    return result;
  }
  if (line.component === "overtime" || line.component.startsWith("attendance-rule:")) return [{ tag: "Attendance", explanation: "Reviewed attendance and the saved pay policy." }];
  return [{ tag: "Manual", explanation: "Saved payroll profile or statutory settings; calculated using the formula shown." }];
}
export function dependenciesForInput(doc: CompanyPayrollDocument, month: string, key: string) {
  const [type, subject, input] = key.split(":");
  return versionsForMonth(doc, month).filter(v => {
    const r = v.terms;
    if (type === "sales") return ["revenue", "team-days"].includes(r.kind) && r.base.branches.includes(subject as BranchId) && (input === "total" || r.base.streams.includes(input));
    return r.inputKey === (type === "count" ? subject : input);
  }).map(v => v.terms.name);
}
