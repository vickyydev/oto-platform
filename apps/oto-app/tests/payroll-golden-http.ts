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
//
// SCRUM-569 (Payroll R4): the LIFECYCLE leg on the same park group. Each
// person gets a valid fictional Thai ID, an SSO title and a given name (they
// feed only warnings and upload files, never a number); then the GM confirms
// (admin), the Owner locks (operator_admin), marks paid and reopens, and a
// second park group is answered 404 on every URL of the fixture's run. What
// the lock froze is read back over HTTP — the frozen calculation, the bank
// files and the cash list as stored — so checks 10-11 run on stored bytes.
import { buildSeptemberGoldenFixture, GOLDEN_ENTITY, GOLDEN_MONTH } from "../server/payroll/diagnostics/september-golden-fixture";
import type { GoldenIds } from "../server/payroll/diagnostics/september-golden";
import type { CompanyCalculation } from "../server/payroll/engine/company-model";
import { caller, database, makeEmployee, makeGroup, serve, signIn, stopServers, APP_ENV } from "./payroll-harness";
import { fictionalThaiId } from "../server/payroll/engine/upload-common";
import type { CompanyOutputs, CompanyResult } from "../server/payroll/engine/company-model";

const C = "hkt-central", H = "hkt-chalong";
const reason = "ZZ TEST SCRUM-568 September golden over HTTP";

let appPool: { end(): Promise<void> } | null = null;

/** What the lifecycle leg saw, for the golden check to assert. */
export interface GoldenLifecycle {
  previewBefore: CompanyResult; previewUnchanged: boolean;
  refusals: Record<string, { status: number; message: string }>;
  confirm: { status: number; body: { status: string; signature: string } };
  lock: { status: number; body: { status: string; version: number; snapshotId: string; lines: number; files: number } };
  lockAgain: { status: number; body: { unchanged: boolean } };
  frozenCalc: CompanyCalculation; frozenResult: CompanyResult; frozenOutputs: CompanyOutputs;
  bankCsvTotal: number; bankReferences: string[]; gmPayslips: number; payslipOpens: number; gmPayslipHtml: string; gmName: string;
  paid: { status: number; body: { status: string } };
  reopen: { status: number; body: { status: string; version: number } };
  reopenAgain: { status: number; body: { unchanged: boolean; version: number } };
  v1Unchanged: boolean; v1Status: string; currentVersion: number; currentStatus: string;
  crossTenant: { url: string; status: number }[];
}

export async function runGoldenHttpLeg(options: { lifecycle?: boolean } = {}): Promise<{ calc: CompanyCalculation; ids: GoldenIds; outputs: CompanyOutputs; previewMs: number; timing: { loadMs: number; calculateMs: number; queries: number }; stored: Record<string, number>; lifecycle: GoldenLifecycle | null }> {
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
    let lifecycle: GoldenLifecycle | null = null;
    if (options.lifecycle) {
      // ── Upload details: a valid fictional Thai ID, an SSO title and a given name per person (no number moves) ──
      let i = 0;
      for (const { s } of people) {
        const view = await ok("GET", `/api/payroll/profiles/${staff[s.id]}`);
        const p = { ...view.profile, taxId: fictionalThaiId(++i), ssoTitle: "Mr.", givenName: s.name.split(" ")[0] || "ZZ", surname: s.name.split(" ").slice(1).join(" ") || "Test",
          bankDetails: { ...view.profile.bankDetails, accountNumber: `990${String(i).padStart(7, "0")}` } };
        await ok("PUT", `/api/payroll/profiles/${staff[s.id]}`, { profile: p, revision: view.revision, reason });
      }
      const as = (role: "admin" | "operator_admin" | "staff" | "manager") => (method: string, path: string, payload?: unknown) => call(g, role, method, path, payload);
      const previewAgain = await ok("GET", `${base}/preview`);
      const previewBefore = previewAgain.result as CompanyResult;
      const nets = (r: CompanyResult) => JSON.stringify(r.people.map((p) => [p.id, p.gross, p.deductions, p.net, p.employer]).sort());
      const refusals: GoldenLifecycle["refusals"] = {};
      const refuse = async (label: string, res: Promise<{ status: number; body: { message?: string } }>) => { const r = await res; refusals[label] = { status: r.status, message: r.body?.message ?? "" }; };
      await refuse("lock before confirm", as("operator_admin")("POST", `${base}/lock`, { reason }));
      await refuse("admin locks", as("admin")("POST", `${base}/lock`, { reason }));
      await refuse("staff confirms", as("staff")("POST", `${base}/confirm`, { reason }));
      await refuse("manager confirms", as("manager")("POST", `${base}/confirm`, { reason }));
      const confirm = await as("admin")("POST", `${base}/confirm`, { reason: "ZZ TEST GM review" });
      const lock = await as("operator_admin")("POST", `${base}/lock`, { reason: "ZZ TEST Owner review" });
      const lockAgain = await as("operator_admin")("POST", `${base}/lock`, { reason: "ZZ TEST repeated" });
      if (lock.status !== 200) throw new Error(`the lock was refused: ${lock.status} ${JSON.stringify(lock.body)} (confirm: ${confirm.status} ${JSON.stringify(confirm.body)})`);
      // ── What the lock froze, read back over HTTP ──
      const frozen = await ok("GET", `${base}/preview`);
      const version = await ok("GET", `/api/payroll/history/${entity.id}/${GOLDEN_MONTH}/1`);
      const fileText = async (id: string) => {
        const res = await fetch(`${origin}/api/payroll/history/files/${id}`, { headers: { cookie: g.cookies.admin } });
        if (res.status !== 200) throw new Error(`file ${id}: ${res.status}`);
        return res.text();
      };
      const fileOf = (name: string) => version.files.find((f: { filename: string }) => f.filename === name);
      const banks = [];
      let bankCsvTotal = 0;
      const bankReferences: string[] = [];
      for (const b of version.manifest.banks) {
        const csv = await fileText(fileOf(b.filename).id);
        const rows = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((row: string) => (row.match(/"(?:[^"]|"")*"|[^,]+|(?<=,)(?=,|$)/g) ?? []).map((f) => f.replace(/^"|"$/g, "").replace(/""/g, '"')));
        const amount = rows[0].indexOf("Amount"), ref = rows[0].indexOf("Reference");
        for (const row of rows.slice(1)) { bankCsvTotal += Number(row[amount]); bankReferences.push(row[ref]); }
        banks.push({ ...b, csv });
      }
      const cashHtml = await fileText(fileOf(`${entity.id}-${GOLDEN_MONTH}-cash-signature-list.html`).id);
      const reports: Record<string, string> = {};
      for (const name of version.manifest.reports) reports[name] = await fileText(fileOf(`${entity.id}-${GOLDEN_MONTH}-${name}`).id);
      const slips = version.files.filter((f: { group: string }) => f.group === "Payslips") as { id: string; employeeId: string }[];
      const gmSlips = slips.filter((f) => f.employeeId === staff["gold-gm"]);
      const opensBefore = await count("select count(*) n from payroll_run_audit where tenant_id = $1 and action = 'Opened a payslip'", [g.tenant]);
      const gmPayslipHtml = await fileText(gmSlips[0].id);
      const payslipOpens = await count("select count(*) n from payroll_run_audit where tenant_id = $1 and action = 'Opened a payslip'", [g.tenant]) - opensBefore;
      // Every payslip is a frozen file; the GM's is read back whole, the rest are named by their file.
      const payslips = Object.fromEntries(slips.map((f) => [f.employeeId, f.employeeId === staff["gold-gm"] ? gmPayslipHtml : `frozen file ${f.id}`]));
      const frozenOutputs = { ...version.manifest, banks, cashHtml, reports, payslips } as unknown as CompanyOutputs;
      const gmPayslips = gmSlips.length;
      const snapshotFingerprint = () => q<{ h: string; status: string }>(`select md5(s.result::text || s.calculation::text || s.world::text || s.outputs_manifest::text) h, v.status from payroll_run_snapshots s
        join payroll_run_versions v on v.id = s.run_version_id where s.tenant_id = $1 and s.version = 1`, [g.tenant]);
      const [v1Before] = await snapshotFingerprint();
      const paid = await as("operator_admin")("POST", `${base}/paid`, { reason: "ZZ TEST paid at the bank" });
      const reopen = await as("operator_admin")("POST", `${base}/reopen`, { reason: "ZZ TEST correction", fromVersion: 1 });
      const reopenAgain = await as("operator_admin")("POST", `${base}/reopen`, { reason: "ZZ TEST correction", fromVersion: 1 });
      const [v1After] = await snapshotFingerprint();
      const view = await ok("GET", base);
      // ── Another park group: every URL of this run is a 404 ──
      const other = await makeGroup(q, "golden-other", ["ZZ TEST Elsewhere"]);
      await signIn(origin, other);
      const slip = version.files.find((f: { group: string }) => f.group === "Payslips");
      const urls: [string, string][] = [
        ["GET", base], ["GET", `${base}/preview`], ["POST", `${base}/confirm`], ["POST", `${base}/lock`], ["POST", `${base}/paid`], ["POST", `${base}/reopen`],
        ["GET", `/api/payroll/history/${entity.id}/${GOLDEN_MONTH}/1`], ["GET", `/api/payroll/history/files/${slip.id}`], ["GET", `/api/payroll/me/payslips/${slip.id}`],
      ];
      const crossTenant = [];
      for (const [method, url] of urls) crossTenant.push({ url: `${method} ${url}`, status: (await call(other, "operator_admin", method, url, { reason })).status });
      lifecycle = {
        previewBefore, previewUnchanged: nets(previewBefore) === nets(preview.result), refusals,
        confirm, lock, lockAgain, frozenCalc: frozen.calculation, frozenResult: frozen.result, frozenOutputs,
        bankCsvTotal: Math.round(bankCsvTotal * 100) / 100, bankReferences, gmPayslips, payslipOpens, gmPayslipHtml,
        gmName: (frozen.result as CompanyResult).people.find((p) => p.id === staff["gold-gm"])?.name ?? "",
        paid, reopen, reopenAgain, v1Unchanged: v1Before.h === v1After.h, v1Status: v1After.status,
        currentVersion: view.run.version, currentStatus: view.run.status, crossTenant,
      };
    }
    return { calc: preview.calculation, ids, outputs, previewMs, timing: preview.timing, stored, lifecycle };
  } finally {
    stopServers();
    await pool.end();
    await appPool?.end().catch(() => undefined);
  }
}
