// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes once; needs a database whose otoapp schema
// the app's migrator has built (0025 included).
//
// SCRUM-570, the company payroll's R5 (plan §1 `payroll_output_files`, §9 R5,
// §10 "PDPA"): the output files a lock stores and the downloads that serve them.
//   1. bytes: every stored file is BYTE-IDENTICAL to what the engine's own
//      builders make from the frozen snapshot (SCB payment TXT per product and
//      its XLSX fallback, the KBANK draft CSV, the SSO BIFF8 .xls, the PND and
//      report CSVs, the cash list, every payslip); the two ZIPs hold exactly
//      the stored files; each row's sha256 is its bytes' and the manifest's;
//      the SCB accounts' draft CSV and (EWF not configured) the EWF workbook
//      are not stored; with EWF settings in force, version 2 stores it;
//   2. immutability: UPDATE and DELETE of a stored file are refused by
//      migration 0025's trigger; version 1's files survive a relock unchanged;
//   3. download fences: a manager and staff get 403, another park group 404,
//      no sign-in 401 — on the file route and on the downloads view;
//   4. audit: every download a payroll role makes is a run-audit row naming
//      the file and its sha256; the bytes served are the stored bytes;
//   5. the reconciliation gate: the downloads view reconciles at 0.00 from the
//      stored bytes; a set missing a transfer, a tampered amount, a byte-order
//      mark or a missing cash list is refused in plain words; mark paid
//      re-reads the stored files and refuses a mismatched set.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/payroll-outputs.check.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { caller, database, makeEmployee, makeGroup, serve, signIn, stopServers, APP_ENV, type Group, type Role } from "./payroll-harness";
import { fictionalThaiId } from "../server/payroll/engine/upload-common";
import type { CompanyCalculation, CompanyResult } from "../server/payroll/engine/company-model";
import type { PayrollWorld } from "../server/payroll/engine/model";

const { pool, q, count } = database();
const reason = "ZZ TEST SCRUM-570";
const MONTH = "2026-08";
let passed = 0;
const okAsync = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ok  ${name}`); };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface FileRow { id: string; file_group: string; filename: string; mime: string; encoding: string; content: string; sha256: string; bytes: number; employee_id: string | null; snapshot_id: string }
const bodyOf = (r: Pick<FileRow, "encoding" | "content">) => r.encoding === "base64" ? Buffer.from(r.content, "base64") : Buffer.from(r.content, "utf8");

const groups: Group[] = [];
try {
  const A = await makeGroup(q, "out-a", ["ZZ TEST A Central"]);
  const B = await makeGroup(q, "out-b", ["ZZ TEST B Park"]);
  groups.push(A, B);
  const origin = await serve();
  await signIn(origin, A); await signIn(origin, B);
  const call = caller(origin);
  const must = async (g: Group, role: Role, method: string, path: string, payload?: unknown, status = [200, 201]) => {
    const res = await call(g, role, method, path, payload ?? { reason });
    assert.ok(status.includes(res.status), `${role} ${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const fetchAs = async (g: Group | null, role: Role, url: string) => {
    const r = await fetch(`${origin}${url}`, { headers: g ? { cookie: g.cookies[role] } : {} });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()), headers: r.headers };
  };

  // ── Park group A: one entity, an SCB account (PAY) and a KBANK account, one SSO branch; four people ──
  const entity = (await must(A, "admin", "POST", "/api/payroll/setup/entities", { name: "ZZ Outputs Co.", country: "TH", taxId: "0105500000002", ssoEmployerNumber: "1000000002", defaultPayDay: 28, reason })).id as string;
  const scb = (await must(A, "admin", "POST", "/api/payroll/setup/accounts", { entityId: entity, label: "ZZ SCB payroll", bank: "SCB", bankCode: "014", accountNumber: "9902000001",
    accountName: "ZZ Outputs", fileFormat: "SCB", scbProduct: "PAY", debitAccount: "9902000001", feeAccount: "9902000001", reason })).id as string;
  const kbank = (await must(A, "admin", "POST", "/api/payroll/setup/accounts", { entityId: entity, label: "ZZ KBANK payroll", bank: "KBANK", bankCode: "004", accountNumber: "9902000002",
    accountName: "ZZ Outputs", fileFormat: "KBANK", reason })).id as string;
  const home = A.branches[0];
  await must(A, "admin", "POST", `/api/payroll/setup/branches/${home}/details`, { effectiveFrom: "2025-01-01", foodAllowanceDefault: 60, reason,
    details: { country: "TH", payingEntityId: entity, defaultPayingAccountId: scb, ssoBranchNumber: "830002", payDate: 28, legalEntity: "ZZ", employerNumber: "1000000002", taxId: "0105500000002", address: "ZZ", payrollBank: "SCB" } });
  await must(A, "admin", "POST", "/api/payroll/setup/revenue-streams", { key: "tickets", label: "Tickets", reason });
  await must(A, "admin", "POST", `/api/payroll/setup/rewards/service-policies/${home}`, { month: "2026-07",
    policy: { percent: 3, basis: "worked", excluded: "retain", streams: ["tickets"], addBack: [], roleWeights: {} }, reason });
  await must(A, "admin", "PUT", `/api/payroll/inputs/2026-07/revenue/${home}`, { streams: { tickets: { amount: 0, vat: 0, serviceCharge: 0 } }, discounts: {}, reason });
  let thaiId = 700;
  const profile = (name: string, salary: number, paymentMethod: string, bank: { bank: string; bankCode: string }, payingAccountId: string) => ({
    workerType: "monthly", jobTitle: "ZZ TEST Floor", monthlySalary: salary, dayRate: 0, fixedFee: 0, joinedOn: "2025-01-01", lastWorkingDay: null,
    taxId: fictionalThaiId(++thaiId), ssoNumber: "", ssoTitle: "Mr.", givenName: name, surname: "Test", dateOfBirth: "1990-01-01", nationality: "Thai",
    foodAllowanceEligible: false, foodAllowancePerDay: 0, ssoEligible: true, pnd1Eligible: false, serviceChargeEligible: false, otEligible: false,
    pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0, paymentMethod, bankDetails: { ...bank, accountNumber: `98${String(thaiId).padStart(8, "0")}`, accountName: `ZZ ${name}` },
    thirdPartyReason: "", allocations: [{ effectiveFrom: "2025-01-01", homeBranchId: home, lines: [{ costCentre: home, percent: 100, entityId: entity, payingAccountId }] }],
    studentLoanMonthly: 0, advances: [], separatePayments: [], notes: "",
  });
  const people = [
    ["Somchai", 21000, "bank-transfer", { bank: "SCB", bankCode: "014" }, scb],      // SCB → SCB: the PAY file
    ["Kanya", 18500.5, "bank-transfer", { bank: "KBANK", bankCode: "004" }, scb],    // SCB → another bank: the SPN file
    ["Prasert", 16000, "bank-transfer", { bank: "KBANK", bankCode: "004" }, kbank],  // the KBANK account's draft CSV
    ["Malee", 12000, "cash", { bank: "", bankCode: "" }, scb],                        // the cash list
  ] as const;
  const ids: Record<string, string> = {};
  for (const [name, salary, method, bank, account] of people) {
    ids[name] = await makeEmployee(q, A, home, `ZZ TEST ${name}`, "2025-01-01", [0]);
    await must(A, "admin", "PUT", `/api/payroll/profiles/${ids[name]}`, { profile: profile(name, salary, method, bank, account), revision: 0, reason });
  }
  const base = `/api/payroll/month-end/${entity}/${MONTH}`;
  await must(A, "admin", "POST", `${base}/run`, { reason });
  await must(A, "admin", "POST", `${base}/confirm`, { reason: "ZZ GM review" });
  const locked = await must(A, "operator_admin", "POST", `${base}/lock`, { reason: "ZZ Owner review" });

  Object.assign(process.env, APP_ENV);
  const appPool = (await import("../server/db")).pool;
  const { generateCompanyOutputs } = await import("../server/payroll/engine/company-outputs");
  const { uploadFileBytes } = await import("../server/payroll/engine/company-upload-files");
  const outputs = await import("../server/payroll/outputs");

  const filesOf = (version: number) => q<FileRow>(`select f.* from payroll_output_files f join payroll_run_snapshots s on s.id = f.snapshot_id
    where f.tenant_id = $1 and s.version = $2 order by f.filename`, [A.tenant, version]);
  const v1Files = await filesOf(1);
  const [snap] = await q<{ id: string; result: CompanyResult; calculation: CompanyCalculation; world: { world: PayrollWorld; doc: unknown }; outputs_manifest: { files: { filename: string; sha256: string; bytes: number }[]; ewf: unknown; reconciliation: { difference: number } } }>(
    "select id, result, calculation, world, outputs_manifest from payroll_run_snapshots where tenant_id = $1 and version = 1", [A.tenant]);
  // The engine's builders, run again on the frozen snapshot's own world and calculation.
  const frozenWorld = { ...snap.world.world, companyPayroll: snap.world.doc } as PayrollWorld;
  const rebuilt = generateCompanyOutputs(frozenWorld, snap.calculation, entity);
  const byName = new Map(v1Files.map((f) => [f.filename, f]));
  const zipNames = (f: FileRow) => Object.keys(unzipSync(bodyOf(f))).sort();

  // ── 1. Bytes ──
  await okAsync("lock: the Owner locks; every file is stored, each with its sha256 and size, as the manifest lists them", async () => {
    assert.equal(locked.status, "locked");
    assert.equal(locked.files, v1Files.length);
    for (const f of v1Files) {
      assert.equal(sha(bodyOf(f)), f.sha256, f.filename); assert.equal(bodyOf(f).length, f.bytes, f.filename);
    }
    assert.deepEqual(snap.outputs_manifest.files.map((f) => [f.filename, f.sha256, f.bytes]).sort(), v1Files.map((f) => [f.filename, f.sha256, f.bytes]).sort());
    assert.equal(snap.outputs_manifest.reconciliation.difference, 0);
  });
  await okAsync("bytes: every downloads-list file is byte-identical to the engine's builders on the frozen snapshot (ZIPs: identical contents)", async () => {
    const built = (rebuilt.downloadFiles ?? []).filter((f) => f.group !== "Welfare fund (EWF)");
    assert.ok(built.length >= 10, `${built.length} files built`);
    for (const f of built) {
      const stored = byName.get(f.filename);
      assert.ok(stored, `${f.filename} is stored`);
      assert.equal(stored.file_group, f.group, f.filename); assert.equal(stored.mime, f.mime, f.filename);
      if (f.mime === "application/zip") {
        const want = unzipSync(uploadFileBytes(f)), got = unzipSync(bodyOf(stored));
        assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), f.filename);
        for (const name of Object.keys(want)) assert.equal(sha(got[name]), sha(want[name]), `${f.filename} › ${name}`);
      } else {
        assert.ok(Buffer.from(uploadFileBytes(f)).equals(bodyOf(stored)), `${f.filename} differs from the builder's bytes`);
      }
    }
    for (const [name, content] of Object.entries(rebuilt.reports)) {
      const stored = byName.get(`${entity}-${MONTH}-${name}`);
      assert.ok(stored && bodyOf(stored).equals(Buffer.from(content, "utf8")), `report ${name}`);
    }
  });
  await okAsync("bytes: the SCB account pays by its PAY and SPN TXT (each with its XLSX fallback); its draft CSV is not stored; the KBANK account's draft CSV is", async () => {
    const bank = v1Files.filter((f) => f.file_group === "Bank files").map((f) => f.filename);
    assert.equal(bank.filter((n) => /^SCB_file_reference_\d{12}\.txt$/.test(n)).length, 2, bank.join(", "));
    assert.equal(bank.filter((n) => /^SCB_file_reference_\d{12}\.xlsx$/.test(n)).length, 2);
    assert.deepEqual(bank.filter((n) => n.endsWith(".csv")), [`${entity}-${MONTH}-${kbank}-KBANK-DRAFT.csv`]);
    assert.equal(bank.some((n) => n.includes("-SCB-DRAFT")), false);
    const products = v1Files.filter((f) => f.filename.endsWith(".txt")).map((f) => bodyOf(f).toString("utf8").split("\r\n")[1].split("|")[2]).sort();
    assert.deepEqual(products, ["PAY", "SPN"]);
  });
  await okAsync("bytes: one SSO BIFF8 .xls for the 6-digit SSO branch; no EWF workbook while EWF is not configured", async () => {
    const sso = v1Files.filter((f) => f.file_group === "Social security (SSO)");
    assert.deepEqual(sso.map((f) => f.filename), [`1000000002_830002_${2569}0828.xls`]);
    assert.deepEqual([...bodyOf(sso[0]).subarray(0, 8)], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "a BIFF8 (OLE2) workbook");
    assert.equal(v1Files.some((f) => f.file_group === "Welfare fund (EWF)"), false);
    assert.deepEqual(snap.outputs_manifest.ewf, { status: "not-configured" });
    assert.ok(byName.get(`${entity}-${MONTH}-SSO-remittance.csv`), "the SSO remittance report is kept with the reports");
  });
  await okAsync("bytes: the all-downloads ZIP holds every downloads-list file byte for byte, plus its README; the payslips ZIP one payslip per person", async () => {
    const bundle = v1Files.find((f) => f.file_group === "All files")!;
    assert.equal(bundle.filename, `${entity}-${MONTH}-all-downloads.zip`);
    const inside = unzipSync(bodyOf(bundle));
    const listed = v1Files.filter((f) => f.file_group !== "All files" && !f.filename.endsWith("-SSO-remittance.csv"));
    assert.deepEqual(Object.keys(inside).sort(), [...listed.map((f) => f.filename), "README.txt"].sort());
    for (const f of listed) assert.equal(sha(inside[f.filename]), f.sha256, f.filename);
    assert.match(strFromU8(inside["README.txt"]), /upload only one/);
    const slips = v1Files.find((f) => f.filename === `${entity}-${MONTH}-payslips.zip`)!;
    assert.equal(slips.employee_id, null);
    assert.deepEqual(zipNames(slips), Object.values(ids).map((id) => `${entity}-${MONTH}-${id}-payslip.html`).sort());
    assert.equal(v1Files.filter((f) => f.file_group === "Payslips" && f.employee_id).length, 4);
  });

  // ── 2. Immutability ──
  await okAsync("immutability: a stored file refuses UPDATE and DELETE at the database (trigger)", async () => {
    const txt = v1Files.find((f) => f.filename.endsWith(".txt"))!;
    await assert.rejects(q("update payroll_output_files set content = 'tampered' where id = $1", [txt.id]), /frozen payroll/);
    await assert.rejects(q("update payroll_output_files set sha256 = repeat('0', 64) where id = $1", [txt.id]), /frozen payroll/);
    await assert.rejects(q("delete from payroll_output_files where id = $1", [txt.id]), /frozen payroll/);
    const [after] = await q<FileRow>("select * from payroll_output_files where id = $1", [txt.id]);
    assert.equal(after.sha256, txt.sha256); assert.equal(after.content, txt.content);
  });

  // ── 3. Download fences ──
  const txt = v1Files.find((f) => f.filename.endsWith(".txt"))!;
  const downloadsUrl = `/api/payroll/history/${entity}/${MONTH}/1/downloads`;
  await okAsync("fences: a manager and staff get 403 on the file and the downloads view; another park group's Owner 404; no sign-in 401", async () => {
    for (const role of ["manager", "staff"] as const) {
      assert.equal((await fetchAs(A, role, `/api/payroll/history/files/${txt.id}`)).status, 403, `${role} file`);
      assert.equal((await fetchAs(A, role, downloadsUrl)).status, 403, `${role} downloads`);
    }
    for (const role of ["operator_admin", "admin", "global_admin"] as const) {
      assert.equal((await fetchAs(B, role, `/api/payroll/history/files/${txt.id}`)).status, 404, `park group B ${role} file`);
      assert.equal((await fetchAs(B, role, downloadsUrl)).status, 404, `park group B ${role} downloads`);
    }
    assert.equal((await fetchAs(null, "admin", `/api/payroll/history/files/${txt.id}`)).status, 401);
    assert.equal((await fetchAs(null, "admin", downloadsUrl)).status, 401);
    assert.equal((await fetchAs(A, "staff", `/api/payroll/me/payslips/${txt.id}`)).status, 404, "a bank file is nobody's payslip");
  });

  // ── 4. Audit and exact bytes ──
  await okAsync("audit: each download is a run-audit row naming the file and its sha256; the bytes served are the stored bytes, saved as an attachment", async () => {
    const audits = () => count("select count(*) n from payroll_run_audit where tenant_id = $1 and subject = 'file'", [A.tenant]);
    const before = await audits();
    const r = await fetchAs(A, "admin", `/api/payroll/history/files/${txt.id}?download=1`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(bodyOf(txt)), "served bytes are the stored bytes");
    assert.match(r.headers.get("content-disposition") ?? "", new RegExp(`^attachment; filename="${txt.filename}"`));
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    const [row] = await q<{ action: string; subject_id: string; reason: string; new_value: { sha256: string }; actor_user_id: string }>(
      "select action, subject_id, reason, new_value, actor_user_id from payroll_run_audit where tenant_id = $1 and subject = 'file' order by at desc limit 1", [A.tenant]);
    assert.deepEqual([row.action, row.subject_id, row.new_value.sha256, row.actor_user_id], ["Downloaded a file", txt.id, txt.sha256, A.accounts.admin.id]);
    assert.equal(row.reason, `${txt.filename} (Bank files)`);
    const bundle = v1Files.find((f) => f.file_group === "All files")!;
    const z = await fetchAs(A, "operator_admin", `/api/payroll/history/files/${bundle.id}?download=1`);
    assert.equal(z.status, 200); assert.equal(sha(z.body), bundle.sha256);
    assert.equal(await count("select count(*) n from payroll_run_audit where tenant_id = $1 and action = 'Downloaded all files (ZIP)' and subject_id = $2", [A.tenant, bundle.id]), 1);
    // A refused download writes nothing.
    await fetchAs(A, "manager", `/api/payroll/history/files/${txt.id}`);
    await fetchAs(B, "operator_admin", `/api/payroll/history/files/${txt.id}`);
    assert.equal(await audits(), before + 2);
  });

  // ── 5. The reconciliation, from the stored bytes ──
  const net = snap.result.totals.net;
  await okAsync("downloads view: groups in the prototype's order, notes kept, the bundle, EWF Not configured, and bank + cash = net at 0.00 from the stored bytes", async () => {
    const d = await must(A, "admin", "GET", downloadsUrl);
    assert.deepEqual(d.groups.map((g: { group: string }) => g.group), ["Bank files", "Social security (SSO)", "Tax (PND.1/PND.3)", "Payslips", "Reports"]);
    assert.ok(d.groups[0].files.some((f: { note: string | null }) => /Excel Toolkit fallback/.test(f.note ?? "")));
    assert.equal(d.allFiles.filename, `${entity}-${MONTH}-all-downloads.zip`);
    assert.deepEqual(d.ewf, { status: "not-configured" });
    assert.equal(d.lockedBeforeR5, false);
    assert.deepEqual([d.reconciliation.reconciled, d.reconciliation.difference, d.reconciliation.net], [true, 0, net]);
    const malee = snap.result.people.find((p) => p.id === ids.Malee)!;
    assert.equal(d.reconciliation.cash, malee.net, "the cash list holds Malee's net, and only hers");
    assert.ok(malee.net > 0 && malee.net < 12000);
    assert.deepEqual(d.reconciliation.bankFiles.map((b: { format: string; transfers: number }) => [b.format, b.transfers]).sort(), [["CSV", 1], ["SCB TXT", 1], ["SCB TXT", 1]]);
    assert.equal(d.reconciliation.bankFiles.flatMap((b: { references: string[] }) => b.references).every((r: string) => r === "SALARY AUG26"), true);
  });
  const stored = v1Files.map((f) => ({ group: f.file_group, filename: f.filename, body: bodyOf(f) }));
  const refusal = (files: typeof stored) => { try { outputs.assertStoredFilesReconcile(files, net, "Nothing was locked: the stored files do not reconcile."); return null; } catch (e) { return e as Error & { status: number }; } };
  await okAsync("gate: the stored set as locked passes; the XLSX fallbacks are never counted twice", () => {
    assert.equal(refusal(stored), null);
    assert.equal(outputs.reconcileStoredFiles(stored, net).bankFiles.some((b) => b.filename.endsWith(".xlsx")), false);
  });
  await okAsync("gate: a set missing a transfer, with a tampered amount, a byte-order mark or no cash list is refused in plain words", () => {
    const edit = (pick: (f: typeof stored[number]) => boolean, change: (text: string) => string) =>
      stored.map((f) => pick(f) ? { ...f, body: Buffer.from(change(f.body.toString("utf8")), "utf8") } : f);
    const scbTxt = (f: typeof stored[number]) => f.filename.endsWith(".txt") && f.body.toString("utf8").includes("|PAY|");
    // A whole batch file gone: the set no longer pays net.
    const netOf = (name: string) => snap.result.people.find((p) => p.id === ids[name])!.net;
    const esc = (n: number) => n.toFixed(2).replace(".", "\\.");
    const gone = refusal(stored.filter((f) => !scbTxt(f)));
    assert.equal(gone?.status, 409);
    assert.match(gone!.message, new RegExp(`^Nothing was locked: the stored files do not reconcile\\. Bank files [\\d.]+ \\+ cash ${esc(netOf("Malee"))} differ from net pay ${esc(net)} by ${esc(netOf("Somchai"))}\\.$`));
    // One transfer dropped inside a file: its trailer no longer matches either.
    const dropped = refusal(edit(scbTxt, (t) => t.split("\r\n").filter((l) => !l.startsWith("TXNDET")).join("\r\n")));
    assert.match(dropped!.message, /the BCHDET total or count does not match its transfers/);
    const tampered = refusal(edit((f) => f.filename.endsWith("KBANK-DRAFT.csv"), (t) => t.replace(`"${netOf("Prasert").toFixed(2)}"`, `"${(netOf("Prasert") - 0.01).toFixed(2)}"`)));
    assert.match(tampered!.message, / by 0\.01\.$/);
    const bom = refusal(edit(scbTxt, (t) => String.fromCharCode(0xfeff) + t));
    assert.match(bom!.message, /starts with a byte-order mark/);
    const lf = refusal(edit(scbTxt, (t) => t.replace(/\r\n/g, "\n")));
    assert.match(lf!.message, /every line must end with CRLF/);
    const noCash = refusal(stored.filter((f) => !f.filename.endsWith("-cash-signature-list.html")));
    assert.match(noCash!.message, /The cash and manual-payment list is missing\./);
  });
  await okAsync("gate: mark paid re-reads the STORED files — with the cash list gone from the set it refuses; restored, it passes", async () => {
    const cash = v1Files.find((f) => f.filename.endsWith("-cash-signature-list.html"))!;
    const client = await pool.connect();
    const bypass = async (sql: string, params: unknown[]) => {
      await client.query("begin");
      await client.query("alter table payroll_output_files disable trigger payroll_output_files_frozen");
      await client.query(sql, params);
      await client.query("alter table payroll_output_files enable trigger payroll_output_files_frozen");
      await client.query("commit");
    };
    try {
      await bypass("delete from payroll_output_files where id = $1", [cash.id]);
      const refused = await call(A, "operator_admin", "POST", `${base}/paid`, { reason: "ZZ paid" });
      assert.equal(refused.status, 409);
      assert.match(refused.body.message, /^Frozen bank files plus cash do not reconcile to total net\. .*The cash and manual-payment list is missing\.$/);
      const view = await must(A, "admin", "GET", downloadsUrl);
      assert.equal(view.reconciliation.reconciled, false);
    } finally {
      const cols = Object.keys(cash);
      await bypass(`insert into payroll_output_files (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => (cash as unknown as Record<string, unknown>)[c]));
      client.release();
    }
    assert.equal((await must(A, "operator_admin", "POST", `${base}/paid`, { reason: "ZZ paid at the bank" })).status, "paid");
  });

  // ── EWF in force: version 2 stores the workbook; version 1 is untouched ──
  const v1Fingerprint = async () => (await q<{ h: string }>(`select md5(string_agg(f.filename || f.sha256 || coalesce(f.content, ''), '' order by f.filename)) h
    from payroll_output_files f join payroll_run_snapshots s on s.id = f.snapshot_id where f.tenant_id = $1 and s.version = 1`, [A.tenant]))[0].h;
  const before = await v1Fingerprint();
  await okAsync("EWF: with the accountant's settings in force, the relocked version 2 stores the EWF workbook byte for byte; version 1's files are unchanged", async () => {
    await must(A, "operator_admin", "POST", `${base}/reopen`, { reason: "ZZ welfare fund entered", fromVersion: 1 });
    await must(A, "admin", "POST", "/api/payroll/setup/ewf-settings", { entityId: entity, effectiveFrom: "2025-01-01",
      settings: { employeeRate: 0.0025, employerRate: 0.0025, headcountThreshold: 10, providentFundAvailable: false, voluntaryBelowThreshold: true }, reason });
    await must(A, "admin", "POST", `${base}/confirm`, { reason: "ZZ GM v2" });
    await must(A, "operator_admin", "POST", `${base}/lock`, { reason: "ZZ Owner v2" });
    const v2 = await filesOf(2);
    const ewf = v2.filter((f) => f.file_group === "Welfare fund (EWF)");
    assert.equal(ewf.length, 1); assert.match(ewf[0].filename, /^EWF_.+_256908\.xlsx$/);
    const [s2] = await q<{ calculation: CompanyCalculation; world: { world: PayrollWorld; doc: unknown }; outputs_manifest: { ewf: unknown } }>(
      "select calculation, world, outputs_manifest from payroll_run_snapshots where tenant_id = $1 and version = 2", [A.tenant]);
    assert.deepEqual(s2.outputs_manifest.ewf, { status: "in-force", from: "2025-01-01" });
    const built = generateCompanyOutputs({ ...s2.world.world, companyPayroll: s2.world.doc } as PayrollWorld, s2.calculation, entity).downloadFiles!.find((f) => f.group === "Welfare fund (EWF)")!;
    assert.ok(Buffer.from(uploadFileBytes(built)).equals(bodyOf(ewf[0])));
    const d2 = await must(A, "admin", "GET", `/api/payroll/history/${entity}/${MONTH}/2/downloads`);
    assert.ok(d2.groups.some((g: { group: string }) => g.group === "Welfare fund (EWF)"));
    assert.equal(d2.reconciliation.difference, 0);
    assert.equal(await v1Fingerprint(), before);
  });
  await appPool.end().catch(() => undefined);
  console.log(`payroll-outputs.check: ${passed} checks passed`);
} catch (error) {
  console.error("payroll-outputs.check FAILED:", error);
  process.exitCode = 1;
} finally {
  stopServers();
  await pool.end();
}
