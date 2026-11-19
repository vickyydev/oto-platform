// seed: none — a helper, not a check. SCRUM-1055: a month's run as figures
// and lines only, with every database id of a scratch park group replaced by
// a stable name, so a run computed in one database compares exactly with the
// same run computed in another (tests/payroll-single-shift.check.ts).
//
// What is kept: everything the engine answered (people, their lines with
// amounts, flags and allocations, payments, totals, warnings, exceptions,
// the service-charge pools, the incentive awards). What is dropped: the
// engine's own source signature, a hash over the ids themselves. Arrays are
// compared as sets of canonical items, because the order of people follows
// their random ids; every item, and every figure in it, must still match.
import type { CompanyCalculation } from "../../server/payroll/engine/company-model";

type Query = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every id of the park group's rows a run can name, with a name that is the same in any database. */
export async function stableNames(q: Query, tenantId: string): Promise<{ ids: Map<string, string>; texts: [string, string][] }> {
  const ids = new Map<string, string>([[tenantId, "tenant"]]);
  const texts: [string, string][] = [];
  const add = (rows: { id: string; label: string }[], prefix: string) => {
    for (const r of rows) {
      const label = `${prefix}:${r.label}`;
      if ([...ids.values()].includes(label)) throw new Error(`two ${prefix} rows are both named ${r.label}`);
      ids.set(String(r.id), label);
    }
  };
  const branches = await q<{ id: string; name: string }>("select id, name from branches where tenant_id = $1", [tenantId]);
  // Branch names carry the run's random suffix; the run's formulas print them.
  for (const b of branches) texts.push([b.name, b.name.replace(/\s+[0-9a-f]{6}$/, "")]);
  add(branches.map((b) => ({ id: b.id, label: b.name.replace(/\s+[0-9a-f]{6}$/, "") })), "branch");
  add(await q("select id, full_name as label from employees where tenant_id = $1", [tenantId]), "person");
  add(await q("select id, name as label from payroll_paying_entities where tenant_id = $1", [tenantId]), "entity");
  add(await q("select id, label from payroll_paying_accounts where tenant_id = $1", [tenantId]), "account");
  add(await q("select id, name as label from payroll_incentive_rules where tenant_id = $1", [tenantId]), "rule");
  add(await q(`select m.id, e.full_name || ' ' || m.kind || ' ' || m.amount::text as label from payroll_run_manual_lines m
               join employees e on e.id = m.employee_id where m.tenant_id = $1`, [tenantId]), "manual");
  // A single shift's lines carry its invitation (SCRUM-1055).
  add(await q(`select i.id, e.full_name || ' ' || i.shift_date::text || ' ' || i.pay_basis as label from single_shift_invitations i
               join employees e on e.id = i.employee_id where i.tenant_id = $1`, [tenantId]), "single-shift");
  // A profile's advances and separate payments name their lines (advance:<id>, separate:<id>, pnd3:<id>).
  for (const [table, prefix] of [["payroll_profile_advances", "advance"], ["payroll_profile_separate_payments", "separate"]] as const) {
    add(await q(`select x.id, e.full_name || ' ' || row_number() over (partition by x.profile_id order by x.created_at, x.id)::text as label
                 from ${table} x join payroll_profiles p on p.id = x.profile_id join employees e on e.id = p.employee_id
                 where x.tenant_id = $1`, [tenantId]), prefix);
  }
  return { ids, texts };
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical).map((v) => [JSON.stringify(v), v] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
};

/** The run as figures and lines, with stable names in place of ids; throws on an id it cannot name. */
export function projectRun(calc: CompanyCalculation, names: { ids: Map<string, string>; texts: [string, string][] }): unknown {
  let text = JSON.stringify({ ...calc, signature: undefined });
  for (const [from, to] of names.texts) text = text.split(from).join(to);
  const unknown = new Set<string>();
  text = text.replace(UUID, (id) => {
    const name = names.ids.get(id.toLowerCase());
    if (!name) unknown.add(id);
    return name ?? id;
  });
  if (unknown.size) throw new Error(`the run names ids this projection cannot name: ${[...unknown].join(", ")}`);
  // When a reward assignment was saved is a time of the run that entered it, never a figure.
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "(saved at)");
  return canonical(JSON.parse(text));
}

/** The people of one projected entity, by stable name. */
export function projectedPeople(projection: unknown, entity: string): Map<string, unknown> {
  const p = projection as { entities: { entityId: string; people: { id: string }[] }[] };
  return new Map((p.entities.find((e) => e.entityId === entity)?.people ?? []).map((x) => [x.id, x]));
}
