// seed: its own — one ZZ TEST park group made here. A helper of
// tests/payroll-golden.check.ts, not a check of its own.
//
// SCRUM-568 (Payroll R3): the September golden's SERVICE AND HTTP leg (plan
// §6). The fixture's inputs are entered through the REAL routes, as an
// administrator would: the paying entity, its two SCB accounts, both
// branches' payroll details, the Thai rule set, the revenue stream
// catalogue, 55 profiles (17 people and 38 prior-month leavers; the plan's "15" miscounted), the two
// service-charge policies (no groups), the five incentive rules (stored as
// dated versions plus assignments, never the fixture's undated fallback),
// August and September sales, the worked-days figures, the chef's PND.3
// basis; then the run: started, the GM's PND.1 override and the two manual
// bonuses. The preview route computes the month from what was stored, and
// the same eleven checks run on its answer.
import { buildSeptemberGoldenFixture, GOLDEN_ENTITY, GOLDEN_MONTH } from "../server/payroll/diagnostics/september-golden-fixture";
import type { GoldenIds } from "../server/payroll/diagnostics/september-golden";
import type { CompanyCalculation } from "../server/payroll/engine/company-model";
import { caller, database, makeEmployee, makeGroup, serve, signIn, stopServers, APP_ENV } from "./payroll-harness";

const C = "hkt-central", H = "hkt-chalong";
const reason = "ZZ TEST SCRUM-568 September golden over HTTP";

let appPool: { end(): Promise<void> } | null = null;

export async function runGoldenHttpLeg(): Promise<{ calc: CompanyCalculation; ids: GoldenIds; outputs: import("../server/payroll/engine/company-model").CompanyOutputs; previewMs: number; timing: { loadMs: number; calculateMs: number; queries: number }; stored: Record<string, number> }> {
  const { pool, q, count } = database();
  try {
    const g = await makeGroup(q, "golden", ["ZZ TEST Central", "ZZ TEST Chalong"]);
    const branch: Record<string, string> = { [C]: g.branches[0], [H]: g.branches[1] };
    const origin = await serve();
    await signIn(origin, g);
    const call = caller(origin);
    const ok = async (method: string, path: string, payload?: unknown, status = [200, 201]) => {
      const res = await call(g, "admin", method, path, payload);
      if (!status.includes(res.status)) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const { data, doc } = buildSeptemberGoldenFixture();

    // ── Setup: entity, accounts, branch details, rule set, streams ──
    const fixtureEntity = data.payingEntities![0];
    const entity = await ok("POST", "/api/payroll/setup/entities", { name: fixtureEntity.name, country: "TH", taxId: fixtureEntity.taxId, ssoEmployerNumber: fixtureEntity.ssoEmployerNumber, defaultPayDay: 28, reason });
    const account: Record<string, string> = {};
    for (const a of data.payingAccounts!) {
      account[a.id] = (await ok("POST", "/api/payroll/setup/accounts", { entityId: entity.id, label: a.label, bank: a.bank, bankCode: a.bankCode, accountNumber: a.accountNumber,
        accountName: a.accountName, fileFormat: a.fileFormat, scbProduct: a.scbProduct, debitAccount: a.debitAccount, feeAccount: a.feeAccount, reason })).id;
    }
    for (const id of [C, H]) {
      const d = data.branches[id].detailsHistory[0].details;
      await ok("POST", `/api/payroll/setup/branches/${branch[id]}/details`, { effectiveFrom: "2025-01-01", foodAllowanceDefault: 60, reason,
        details: { ...d, payingEntityId: entity.id, defaultPayingAccountId: account[d.defaultPayingAccountId!] } });
    }
    await ok("POST", "/api/payroll/setup/rule-sets", { country: "TH", effectiveFrom: "2025-01", rules: data.branches[C].rulesHistory[0], reason });
    for (const key of ["sc-pool", "net", "birthday", "nanny-pool"]) await ok("POST", "/api/payroll/setup/revenue-streams", { key, label: `ZZ ${key}`, reason });

    // ── People: employees, then their payroll profiles through the profile route ──
    const staff: Record<string, string> = {};
    const people = Object.entries(data.branches).flatMap(([home, b]) => b.staff.map((s) => ({ home, s })));
    for (const { home, s } of people) staff[s.id] = await makeEmployee(q, g, branch[home], s.name, s.payrollProfile!.joinedOn);
    for (const { s } of people) {
      const p = structuredClone(s.payrollProfile!);
      p.allocations = p.allocations.map((v) => ({ ...v, homeBranchId: branch[v.homeBranchId],
        lines: v.lines.map((l) => ({ ...l, costCentre: l.costCentre === "owner-non-operational" ? l.costCentre : branch[l.costCentre], entityId: entity.id,
          payingAccountId: l.payingAccountId ? account[l.payingAccountId] : null })) }));
      await ok("PUT", `/api/payroll/profiles/${staff[s.id]}`, { profile: p, revision: 0, reason });
    }

    // ── Rewards: two service-charge policies (no groups), five rules as versions + assignments ──
    for (const id of [C, H]) {
      const { effectiveFrom, ...policy } = doc.servicePolicies[id]![0];
      await ok("POST", `/api/payroll/setup/rewards/service-policies/${branch[id]}`, { month: effectiveFrom.slice(0, 7), policy, reason });
    }
    const rule: Record<string, string> = {};
    for (const r of doc.incentives) {
      const { id: _id, staffIds, effectiveFrom, effectiveTo: _to, ...terms } = r;
      const saved = await ok("POST", "/api/payroll/setup/rewards/incentives", {
        terms: { ...terms, base: { ...terms.base, branches: terms.base.branches.map((b) => branch[b]) } },
        from: effectiveFrom, splitDays: false, titles: [], reason,
        selected: staffIds.map((sid) => ({ staffId: staff[sid], startDate: effectiveFrom })),
      });
      rule[r.id] = saved.id;
    }

    // ── Month inputs: sales of both months, worked days, the chef's PND.3 basis ──
    for (const month of ["2026-08", GOLDEN_MONTH]) {
      for (const [id, revenue] of Object.entries(doc.months[month].revenue)) {
        await ok("PUT", `/api/payroll/inputs/${month}/revenue/${branch[id]}`, { streams: revenue!.streams, discounts: revenue!.discounts, reason });
      }
    }
    for (const [sid, input] of Object.entries(doc.months[GOLDEN_MONTH].staff)) {
      if (input.daysWorked !== undefined) await ok("POST", `/api/payroll/inputs/${GOLDEN_MONTH}/override`, { key: `days:${staff[sid]}`, value: input.daysWorked, reason });
      if (input.pnd3Basis) await ok("PUT", `/api/payroll/inputs/${GOLDEN_MONTH}/people/${staff[sid]}`, { pnd3Basis: input.pnd3Basis, reason });
    }

    // ── The run: started, the GM's PND.1 override, two manual bonuses ──
    const base = `/api/payroll/month-end/${entity.id}/${GOLDEN_MONTH}`;
    await ok("POST", `${base}/run`, { reason });
    const run = doc.runs[`${GOLDEN_ENTITY}:${GOLDEN_MONTH}`];
    for (const o of run.overrides) await ok("POST", `${base}/overrides`, { employeeId: staff[o.staffId], component: o.component, amount: o.amount, reason: o.reason });
    for (const m of run.manual) await ok("POST", `${base}/manual`, { employeeId: staff[m.staffId], kind: m.kind, amount: m.amount, reason: m.reason });

    // ── The preview, from what was stored ──
    const started = performance.now();
    const preview = await ok("GET", `${base}/preview`);
    const previewMs = Math.round(performance.now() - started);
    const ids: GoldenIds = {
      entity: entity.id, staff: (id) => staff[id] ?? id, branch: (id) => branch[id] ?? id,
      account: (id) => account[id] ?? id, rule: (id) => rule[id] ?? `missing:${id}`,
    };
    // The outputs (payslips, remittance list) from the loader's own world, on the route's calculation.
    Object.assign(process.env, APP_ENV);
    const { loadPayrollWorld } = await import("../server/payroll/world");
    appPool = (await import("../server/db")).pool;
    const { generateCompanyOutputs } = await import("../server/payroll/engine/company-outputs");
    const loaded = await loadPayrollWorld(g.tenant, GOLDEN_MONTH);
    const outputs = generateCompanyOutputs(loaded.world, preview.calculation, entity.id);
    const stored = {
      profiles: await count("select count(*) n from payroll_profiles where tenant_id = $1", [g.tenant]),
      versions: await count("select count(*) n from payroll_incentive_rule_versions where tenant_id = $1", [g.tenant]),
      assignments: await count("select count(*) n from payroll_incentive_assignments where tenant_id = $1", [g.tenant]),
      policiesWithGroups: await count("select count(*) n from payroll_service_policies where tenant_id = $1 and policy ? 'groups'", [g.tenant]),
      partMonthDefaulted: await count("select count(*) n from payroll_incentive_rules where tenant_id = $1 and terms ? 'partMonth'", [g.tenant]),
    };
    return { calc: preview.calculation, ids, outputs, previewMs, timing: preview.timing, stored };
  } finally {
    stopServers();
    await pool.end();
    await appPool?.end().catch(() => undefined);
  }
}
