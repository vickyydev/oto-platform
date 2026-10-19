/**
 * The company payroll's output files and downloads (SCRUM-570, R5; plan §1
 * `payroll_output_files`, §9 R5, §10 "PDPA").
 *
 * AT LOCK every file of the prototype's downloads list is made by the engine's
 * own builders (generateCompanyOutputs → companyUploadFiles: the SCB payment
 * TXT per account and product with its Excel Toolkit fallback, the other
 * banks' draft CSVs, the SSO BIFF8 .xls per 6-digit SSO branch, the EWF
 * workbook, the PND.1/PND.3 and report CSVs, the cash and manual-payment list,
 * every payslip and the payslips ZIP), plus the remittance reports the
 * downloads list leaves out (the SSO remittance CSV) and "all downloads" as
 * one ZIP (the prototype's payrollUploadsZip). Each is stored as the exact
 * bytes the builder produced, with its sha256, in payroll_output_files —
 * unchangeable by migration 0025's trigger — and served only as those bytes.
 *
 * Two departures from what the builders hand over, both the prototype's own
 * rules made explicit:
 *   - The SCB accounts' draft CSV is not stored: the prototype's downloads list
 *     never offers it (its SCB TXT replaces it), and storing it beside the TXT
 *     would show the same batch twice.
 *   - The EWF workbook is stored only when the entity's welfare fund settings
 *     are in force for the month. None are seeded (plan §8); until the
 *     accountant's settings are entered, the downloads say "Not configured"
 *     instead of offering an empty workbook.
 *
 * THE RECONCILIATION reads the stored bytes themselves: every uploadable bank
 * file (SCB TXT, other banks' CSV; never the XLSX fallback of the same batch)
 * is parsed and summed, the cash and manual-payment list's amounts are read
 * from its HTML, and bank plus cash must equal net to the satang. The lock
 * refuses otherwise (nothing is written), and mark paid re-reads the stored
 * files and refuses the same way.
 *
 * STORAGE: inline bytes in the row, not object storage. A month's files are
 * small (well under a few MB), the row and its bytes commit or roll back with
 * the lock in ONE transaction, and the trigger makes the bytes themselves
 * unchangeable — object storage would add an upload outside the transaction
 * (orphans on a refused lock) and an object that can be overwritten. The
 * `object_key` column stays for a later move if months grow large.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { payrollOutputFiles, payrollPayingEntities, payrollRunSnapshots, payrollRunVersions } from "@shared/schema";
import type { EwfOutputState, OutputFileView, OutputsManifest, PayrollDownloadsView, StoredBankFileView, StoredReconciliationView } from "@shared/payroll-month";
import { db } from "../db";
import { PayrollRefusal } from "./setup";
import { requireMonth } from "./inputs";
import { payrollUploadsZip, uploadFileBytes } from "./engine/company-upload-files";
import type { CompanyDownloadFile, CompanyOutputs, CompanyResult, CompanySnapshot } from "./engine/company-model";
import type { PayrollWorld } from "./engine/model";

/** The prototype's downloads-list groups, in its order (downloads-list.tsx). */
export const DOWNLOAD_GROUPS = ["Bank files", "Social security (SSO)", "Welfare fund (EWF)", "Tax (PND.1/PND.3)", "Payslips", "Reports"] as const;
/** The "Download all as ZIP" bundle's group. */
export const ALL_FILES_GROUP = "All files";
export const EWF_GROUP = "Welfare fund (EWF)";

export interface LockFile {
  employeeId: string | null; group: string; filename: string; mime: string; encoding: "utf8" | "base64"; content: string;
  rows: number; total: number; note: string | null; body: Buffer; sha256: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const satang = (n: number) => Math.round(n * 100);
const baht = (s: number) => s / 100;

/** Whether the entity's welfare fund workbook belongs in this month's files (effectiveEwfSettings's own date rule). */
export function ewfOutputState(world: PayrollWorld, entityId: string, month: string): EwfOutputState {
  if (world.payingEntities?.find((e) => e.id === entityId)?.country !== "TH") return { status: "not-applicable" };
  const versions = (world.ewfSettings ?? []).filter((v) => v.entityId === entityId).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const inForce = versions.filter((v) => v.effectiveFrom <= `${month}-31`).at(-1);
  if (inForce) return { status: "in-force", from: inForce.effectiveFrom };
  if (versions.length) return { status: "not-yet-in-force", from: versions[0].effectiveFrom };
  return { status: "not-configured" };
}

const lockFile = (f: Omit<LockFile, "body" | "sha256">): LockFile => {
  const body = Buffer.from(uploadFileBytes({ encoding: f.encoding, content: f.content, group: "Reports", filename: f.filename, mime: f.mime, rows: f.rows, total: f.total, preview: { headers: [], rows: [] } }));
  return { ...f, body, sha256: sha256(body) };
};

/** Every file the lock stores, as the engine's builders made them (see the header for the two departures). */
export function lockOutputFiles(outputs: CompanyOutputs, result: CompanyResult, world: PayrollWorld, entityId: string, month: string): { files: LockFile[]; ewf: EwfOutputState } {
  const base = `${entityId}-${month}`;
  const ewf = ewfOutputState(world, entityId, month);
  const payslipOwner = new Map(Object.keys(outputs.payslips).map((id) => [`${base}-${id}-payslip.html`, id]));
  const downloads: CompanyDownloadFile[] = (outputs.downloadFiles ?? []).filter((f) => f.group !== EWF_GROUP || ewf.status === "in-force");
  const files: LockFile[] = [];
  const seen = new Set<string>();
  const add = (f: Omit<LockFile, "body" | "sha256">) => { if (seen.has(f.filename)) return; seen.add(f.filename); files.push(lockFile(f)); };
  for (const f of downloads) {
    const employeeId = f.group === "Payslips" ? payslipOwner.get(f.filename) ?? null : null;
    add({ employeeId, group: f.group, filename: f.filename, mime: f.mime, encoding: f.encoding, content: f.content, rows: f.rows, total: f.total, note: f.note ?? null });
  }
  // The remittance reports the downloads list leaves out (the SSO remittance CSV, replaced there by the SSO upload).
  for (const [name, content] of Object.entries(outputs.reports)) {
    add({ employeeId: null, group: "Reports", filename: `${base}-${name}`, mime: "text/csv", encoding: "utf8", content,
      rows: Math.max(0, content.split("\r\n").length - 1), total: 0, note: null });
  }
  // "Download all as ZIP": the prototype's bundle of the downloads list with its README.
  const zip = payrollUploadsZip({ outputs: { ...outputs, downloadFiles: downloads } } as CompanySnapshot);
  add({ employeeId: null, group: ALL_FILES_GROUP, filename: `${base}-all-downloads.zip`, mime: "application/zip", encoding: "base64",
    content: Buffer.from(zip).toString("base64"), rows: downloads.length, total: result.totals.net, note: "Every file of the downloads list in one ZIP, with a README." });
  return { files, ewf };
}

// ─── Reading the stored bytes back ───────────────────────────────────────────

/** An uploadable bank file: SCB TXT or another bank's CSV — never the XLSX fallback of the same batch, never an SCB account's draft CSV. */
export const isUploadBankFile = (f: { group: string; filename: string }) =>
  f.group === "Bank files" && !/\.xlsx$/i.test(f.filename) && !/-SCB-DRAFT\.csv$/i.test(f.filename);
export const isCashList = (f: { filename: string }) => /-cash-signature-list\.html$/.test(f.filename);

const csvRows = (text: string) => text.replace(/^\uFEFF/, "").trim().split(/\r?\n/)
  .map((row) => (row.match(/"(?:[^"]|"")*"|[^,]+|(?<=,)(?=,|$)/g) ?? []).map((field) => field.replace(/^"|"$/g, "").replace(/""/g, '"')));

/** One bank file's transfers and amount, read from its bytes; anything malformed is a problem, never a guess. */
export function readBankFile(filename: string, body: Buffer): StoredBankFileView {
  const text = body.toString("utf8");
  const problems: string[] = [];
  const references: string[] = [];
  let sum = 0, transfers = 0;
  if (/\.txt$/i.test(filename)) {
    if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) problems.push(`${filename}: starts with a byte-order mark.`);
    if (!text.endsWith("\r\n") || /(^|[^\r])\n/.test(text)) problems.push(`${filename}: every line must end with CRLF.`);
    const lines = text.split("\r\n").filter((l) => l.length > 0).map((l) => l.split("|"));
    const batch = lines.find((l) => l[0] === "BCHDET"), trailer = lines.find((l) => l[0] === "TRAILR");
    if (lines[0]?.[0] !== "HEADER" || !batch || !trailer || lines.at(-1)?.[0] !== "TRAILR") problems.push(`${filename}: HEADER, BCHDET and TRAILR records are required.`);
    for (const l of lines.filter((r) => r[0] === "TXNDET")) {
      if (l.length !== 28) problems.push(`${filename}: a TXNDET record has ${l.length} fields, not 28.`);
      const amount = Number(l[6]);
      if (!/^\d+\.\d{2}$/.test(l[6] ?? "") || !Number.isFinite(amount)) problems.push(`${filename}: a TXNDET amount is not a number.`);
      else sum += satang(amount);
      transfers += 1;
      references.push(l[27] ?? "");
    }
    if (batch && (satang(Number(batch[6])) !== sum || Number(batch[7]) !== transfers)) problems.push(`${filename}: the BCHDET total or count does not match its transfers.`);
    if (trailer && (satang(Number(trailer[3])) !== sum || Number(trailer[2]) !== transfers)) problems.push(`${filename}: the TRAILR total or count does not match its transfers.`);
    return { filename, format: "SCB TXT", transfers, amount: baht(sum), references, problems };
  }
  const rows = csvRows(text);
  const amountColumn = rows[0]?.indexOf("Amount") ?? -1, referenceColumn = rows[0]?.indexOf("Reference") ?? -1;
  if (amountColumn < 0) problems.push(`${filename}: no Amount column.`);
  for (const row of rows.slice(1)) {
    const amount = Number(row[amountColumn]);
    if (!Number.isFinite(amount)) problems.push(`${filename}: an amount is not a number.`);
    else sum += satang(amount);
    transfers += 1;
    references.push(referenceColumn >= 0 ? row[referenceColumn] ?? "" : "");
  }
  return { filename, format: "CSV", transfers, amount: baht(sum), references, problems };
}

const htmlAmount = (sign: string, digits: string) => (sign ? -1 : 1) * satang(Number(digits.replace(/,/g, "")));

/** The cash and manual-payment list's rows and total, read from its HTML (company-outputs.ts's cashHtml). */
export function readCashList(filename: string, body: Buffer): { amount: number; rows: number; problems: string[] } {
  const html = body.toString("utf8");
  let sum = 0, rows = 0;
  for (const m of html.matchAll(/<td class="number">(−?)(?:฿|RM)([\d,]+(?:\.\d+)?)<\/td>/g)) { sum += htmlAmount(m[1], m[2]); rows += 1; }
  const total = /<h2>Total (−?)(?:฿|RM)([\d,]+(?:\.\d+)?)<\/h2>/.exec(html);
  const problems = !total ? [`${filename}: no total line.`] : htmlAmount(total[1], total[2]) !== sum ? [`${filename}: its rows do not add up to its total.`] : [];
  return { amount: baht(sum), rows, problems };
}

/** Bank files plus cash against net, from the stored bytes. */
export function reconcileStoredFiles(files: { group: string; filename: string; body: Buffer }[], net: number): StoredReconciliationView {
  const bankFiles = files.filter(isUploadBankFile).sort((a, b) => a.filename.localeCompare(b.filename)).map((f) => readBankFile(f.filename, f.body));
  const cashFile = files.find(isCashList) ?? null;
  const cash = cashFile ? readCashList(cashFile.filename, cashFile.body) : { amount: 0, rows: 0, problems: ["The cash and manual-payment list is missing."] };
  const bank = bankFiles.reduce((n, b) => n + satang(b.amount), 0);
  const difference = satang(net) - bank - satang(cash.amount);
  const problems = [...bankFiles.flatMap((b) => b.problems), ...cash.problems];
  return { bank: baht(bank), cash: cash.amount, net: baht(satang(net)), difference: baht(difference), reconciled: difference === 0 && !problems.length,
    bankFiles, cashFile: cashFile?.filename ?? null, problems };
}

/** The lock's and mark paid's gate: refuse unless the stored bank files plus cash equal net to the satang. */
export function assertStoredFilesReconcile(files: { group: string; filename: string; body: Buffer }[], net: number, words: string): StoredReconciliationView {
  const r = reconcileStoredFiles(files, net);
  if (!r.reconciled) {
    throw new PayrollRefusal(409, `${words} Bank files ${r.bank.toFixed(2)} + cash ${r.cash.toFixed(2)} differ from net pay ${r.net.toFixed(2)} by ${r.difference.toFixed(2)}.${r.problems.length ? ` ${r.problems.join(" ")}` : ""}`);
  }
  return r;
}

/** A stored row's bytes, refused unless they are the ones frozen at lock. */
export function storedBody(file: { content: string | null; encoding: string; sha256: string; filename: string }): Buffer {
  if (file.content == null) throw new PayrollRefusal(409, "This file is kept in storage that is not connected yet.");
  const body = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
  if (sha256(body) !== file.sha256) throw new PayrollRefusal(409, `${file.filename} does not match the copy frozen at lock.`);
  return body;
}

type Reader = Pick<typeof db, "select">;

/** The stored bank files and cash list of one locked version, bytes checked against their sha256. */
export async function storedPaymentFiles(tx: Reader, tenantId: string, snapshotId: string) {
  const rows = await tx.select({ fileGroup: payrollOutputFiles.fileGroup, filename: payrollOutputFiles.filename, content: payrollOutputFiles.content,
    encoding: payrollOutputFiles.encoding, sha256: payrollOutputFiles.sha256 }).from(payrollOutputFiles)
    .where(and(eq(payrollOutputFiles.tenantId, tenantId), eq(payrollOutputFiles.snapshotId, snapshotId), inArray(payrollOutputFiles.fileGroup, ["Bank files", "Reports"])));
  return rows.filter((r) => isUploadBankFile({ group: r.fileGroup, filename: r.filename }) || isCashList(r))
    .map((r) => ({ group: r.fileGroup, filename: r.filename, body: storedBody(r) }));
}

// ─── The downloads of one locked version ─────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadDownloads(tenantId: string, entityId: string, monthValue: string, versionValue: string): Promise<PayrollDownloadsView> {
  const month = requireMonth(monthValue);
  const version = Number(versionValue);
  if (!UUID.test(entityId) || !Number.isInteger(version) || version < 1) throw new PayrollRefusal(404, "Locked payroll not found");
  const [row] = await db.select({ snapshotId: payrollRunSnapshots.id, entityName: payrollPayingEntities.name, status: payrollRunVersions.status,
    lockedAt: payrollRunSnapshots.lockedAt, lockedBy: payrollRunSnapshots.lockedByName, result: payrollRunSnapshots.result, manifest: payrollRunSnapshots.outputsManifest })
    .from(payrollRunSnapshots)
    .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.id, payrollRunSnapshots.runVersionId)))
    .innerJoin(payrollPayingEntities, and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, payrollRunSnapshots.entityId)))
    .where(and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.entityId, entityId), eq(payrollRunSnapshots.month, month), eq(payrollRunSnapshots.version, version))).limit(1);
  if (!row) throw new PayrollRefusal(404, "Locked payroll not found");
  const result = row.result as CompanyResult;
  const manifest = row.manifest as OutputsManifest;
  const names = new Map(result.people.map((p) => [p.id, p.name]));
  const notes = new Map((manifest.files ?? []).map((f) => [f.filename, f.note ?? null]));
  const files = await db.select({ id: payrollOutputFiles.id, fileGroup: payrollOutputFiles.fileGroup, filename: payrollOutputFiles.filename, mime: payrollOutputFiles.mime,
    employeeId: payrollOutputFiles.employeeId, bytes: payrollOutputFiles.bytes, rows: payrollOutputFiles.rows, total: payrollOutputFiles.total, sha256: payrollOutputFiles.sha256 })
    .from(payrollOutputFiles).where(and(eq(payrollOutputFiles.tenantId, tenantId), eq(payrollOutputFiles.snapshotId, row.snapshotId)))
    .orderBy(asc(payrollOutputFiles.filename));
  const view = (f: typeof files[number]): OutputFileView => ({ id: f.id, group: f.fileGroup, filename: f.filename, mime: f.mime, employeeId: f.employeeId,
    name: f.employeeId ? names.get(f.employeeId) ?? null : null, bytes: f.bytes, rows: f.rows, total: Number(f.total ?? 0), sha256: f.sha256 });
  const groups = DOWNLOAD_GROUPS.map((group) => ({ group, files: files.filter((f) => f.fileGroup === group && !(f.fileGroup === "Bank files" && /-SCB-DRAFT\.csv$/i.test(f.filename)))
    .map((f) => ({ ...view(f), note: notes.get(f.filename) ?? null })) })).filter((g) => g.files.length);
  const bundle = files.find((f) => f.fileGroup === ALL_FILES_GROUP);
  return {
    snapshotId: row.snapshotId, entityId, entityName: row.entityName, month, version, status: row.status, lockedAt: row.lockedAt.toISOString(), lockedBy: row.lockedBy,
    currency: result.currency, groups, allFiles: bundle ? view(bundle) : null,
    reconciliation: reconcileStoredFiles(await storedPaymentFiles(db, tenantId, row.snapshotId), result.totals.net),
    ewf: manifest.ewf ?? null, uploadIssues: manifest.uploadIssues ?? [], note: manifest.note, lockedBeforeR5: !manifest.files,
  };
}
