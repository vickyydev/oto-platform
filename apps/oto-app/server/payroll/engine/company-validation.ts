import type { CompanyPayrollDocument } from "./company-model";
export function validateCompanyDocument(doc: CompanyPayrollDocument): void {
  if (doc.version !== 1 || !Array.isArray(doc.incentives) || !Array.isArray(doc.snapshots) || !doc.months || !doc.runs) throw new Error("Invalid company payroll document.");
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  if (new Set(doc.incentives.map(r => r.id)).size !== doc.incentives.length) throw new Error("Incentive IDs must be unique.");
  for (const rule of doc.incentives) {
    if (!rule.id.trim() || !rule.name.trim() || !["revenue", "team-days", "unit-pool", "unit", "kpi", "guarantee", "manual"].includes(rule.kind) ||
      !finite(rule.rate) || (rule.target !== null && !finite(rule.target)) || (rule.cap !== null && !finite(rule.cap)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveFrom) || (rule.effectiveTo && rule.effectiveTo < rule.effectiveFrom)) throw new Error(`Invalid incentive ${rule.name}.`);
  }
  const ruleIds = new Set(doc.incentives.map(r => r.id));
  if (doc.rewardsVersion === 1 && (!Array.isArray(doc.incentiveAssignments) || !Array.isArray(doc.incentiveVersions))) throw new Error("Dated incentive assignments and versions are required.");
  for (const a of doc.incentiveAssignments ?? []) {
    if (!a.id || !ruleIds.has(a.ruleId) || (!a.staffId && !a.jobTitle?.trim()) || !/^\d{4}-\d{2}-\d{2}$/.test(a.effectiveFrom) ||
      (!a.superseded && a.effectiveTo && a.effectiveTo < a.effectiveFrom) || (a.personalRate !== undefined && !finite(a.personalRate))) throw new Error("Invalid dated incentive assignment.");
  }
  for (const v of doc.incentiveVersions ?? []) {
    if (!ruleIds.has(v.ruleId) || v.terms.id !== v.ruleId || !Number.isInteger(v.version) || v.version < 1 || !finite(v.terms.rate) ||
      (!v.superseded && v.effectiveTo && v.effectiveTo < v.effectiveFrom)) throw new Error("Invalid incentive version.");
  }
  for (const policies of Object.values(doc.servicePolicies)) for (const policy of policies ?? []) {
    if (!finite(policy.percent) || policy.percent > 100 || !policy.streams.length || !["calendar", "worked", "equal", "role-weight"].includes(policy.basis) ||
      !["remove", "retain"].includes(policy.excluded) || Object.values(policy.roleWeights).some(n => !finite(n))) throw new Error("Invalid service-charge policy.");
    if (policy.groups) {
      if (!policy.groups.length || new Set(policy.groups.map(g => g.id)).size !== policy.groups.length) throw new Error("Give each service-charge group a unique name.");
      const ordinary = policy.groups.filter(g => !g.streams?.length);
      if (ordinary.length && Math.abs(ordinary.reduce((n, g) => n + g.percent, 0) - 100) > 0.00001) throw new Error("Shares of the remaining service-charge pool must total 100%.");
      const reservations: Record<string, number> = {};
      for (const g of policy.groups) {
        if (!g.id || !g.name.trim() || !finite(g.percent) || g.percent > 100 || !["everyone", "department", "job-title", "people"].includes(g.selection) ||
          !["calendar", "worked", "equal", "role-weight"].includes(g.basis) || (g.selection !== "everyone" && !g.values.length)) throw new Error("Complete the group name, people, share and sharing method.");
        for (const stream of g.streams ?? []) {
          if (!policy.streams.includes(stream)) throw new Error("A group's sales must be included in the branch pool.");
          reservations[stream] = (reservations[stream] ?? 0) + g.percent;
          if (reservations[stream] > 100.00001) throw new Error("A sales stream cannot be reserved more than once beyond 100%.");
        }
      }
    }
    const exceptions = policy.exceptions ?? [];
    if (new Set(exceptions.map(e => e.staffId)).size !== exceptions.length ||
      exceptions.some(e => !e.staffId || !["exclude", "fixed", "weight"].includes(e.kind) || !finite(e.value))) throw new Error("Check service-charge exceptions; use one entry per person.");
  }
  for (const input of Object.values(doc.months)) {
    for (const [key, source] of Object.entries(input.sources ?? {})) {
      if (!key.trim() || !["POS", "Attendance", "Vouchers", "CRM", "Manual"].includes(source.kind) || !finite(source.original) || !finite(source.current) ||
        !source.syncedAt || (source.reason !== undefined && (!source.reason.trim() || !source.who?.trim() || !source.at))) throw new Error("Source overrides need an original value, new value, editor and reason.");
    }
    if (Object.values(input.counts).some(n => !finite(n))) throw new Error("Counts must be non-negative.");
    for (const r of Object.values(input.revenue)) if (r) {
      if (Object.values(r.streams).some(c => ![c.amount, c.vat, c.serviceCharge].every(finite) || c.vat + c.serviceCharge > c.amount) ||
        Object.values(r.discounts).some(n => !finite(n!))) throw new Error("Invalid revenue/VAT/SC/discount input.");
    }
    for (const s of Object.values(input.staff)) {
      if (s.pnd3Basis !== undefined && !["all-earnings", "fee-only"].includes(s.pnd3Basis)) throw new Error("Invalid contractor PND.3 basis.");
      if ((s.daysWorked !== undefined && !finite(s.daysWorked)) || Object.values(s.units).some(n => !finite(n)) ||
        Object.values(s.kpis).some(n => !finite(n)) || Object.values(s.bonuses).some(b => !finite(b.amount) || (b.amount > 0 && !b.reason.trim()))) throw new Error("Invalid personal inputs or missing bonus reason.");
    }
  }
  for (const run of Object.values(doc.runs)) {
    if (Object.values(run.thirdPartyApprovals ?? {}).some(a => !a.signature || !a.reason.trim() || !a.who.trim() || !Number.isFinite(Date.parse(a.at)))) throw new Error("Payment approvals require a reason and reviewer.");
    if (run.overrides.some(o => !finite(o.amount) || !o.reason.trim()) || run.manual.some(m => !finite(m.amount) || !m.reason.trim())) throw new Error("Overrides and manual adjustments require a non-negative amount and a reason.");
    if (Object.values(run.attendance).some(a => !["confirm", "override", "excuse"].includes(a.action) || !a.reason.trim() || !a.who.trim() ||
      (a.clockIn !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(a.clockIn)) ||
      (a.clockOut !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(a.clockOut)))) throw new Error("Attendance decisions require actor, reason and valid HH:mm times.");
  }
}
