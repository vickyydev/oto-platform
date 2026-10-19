import type { PayrollWorld } from "./model";
import type { CompanyDraft, CompanyPayrollDocument } from "./company-model";
import { calculateCompanyEngine, companySourceSignature } from "./company-calculations";
import { generateCompanyOutputs } from "./company-outputs";
import { validateCompanyDocument } from "./company-validation";
import { issueGroup, openCheckFixProblems } from "./company-issue-review";
import { systemClock, type PayrollClock } from "./clock";

export function newCompanyDraft(entityId: string, month: string, version = 1): CompanyDraft {
  return { entityId, month, version, payDate: `${month}-28`, stage: "attendance", status: "draft", attendance: {}, overrides: [], manual: [], audit: [] };
}
export function approveCompanyRun(data: PayrollWorld, document: CompanyPayrollDocument, entityId: string, month: string, actor: string,
  confirmation?: { reason: string; allowOpenProblems?: boolean }, clock: PayrollClock = systemClock): CompanyPayrollDocument {
  if (!actor.trim()) throw new Error("Signed-in reviewer required.");
  if (confirmation && !confirmation.reason.trim()) throw new Error("A confirmation reason is required.");
  const doc = structuredClone(document), key = `${entityId}:${month}`, run = doc.runs[key] ??= newCompanyDraft(entityId, month);
  if (run.status === "locked" || run.status === "paid") throw new Error("Reopen the locked run into a new version first.");
  validateCompanyDocument(doc);
  const calculation = calculateCompanyEngine(data, doc, month), result = calculation.entities.find(e => e.entityId === entityId);
  if (!result?.people.length) throw new Error("No employees or payable lines in this entity.");
  const blocking = result.exceptions.filter(e => e.severity === "blocking" && (!confirmation?.allowOpenProblems || issueGroup(e) === "Attendance"));
  if (blocking.length) throw new Error(`Resolve ${blocking.length} blocking items first: ${blocking.slice(0, 3).map(e => e.message).join(" ")}`);
  run.status = "gm-confirmed"; run.stage = "approvals"; run.gmActor = actor;
  run.approvedSignature = calculation.signature;
  const open = openCheckFixProblems(result, run);
  run.audit.push({ at: clock.now().toISOString(), who: actor, action: "GM confirm (development role simulation)",
    reason: confirmation ? `${confirmation.allowOpenProblems && open ? `${open} problems still open; confirmed anyway. ` : ""}${confirmation.reason.trim()}` : "Attendance, inputs, flags and company totals reviewed." });
  return doc;
}
export function lockCompanyRun(data: PayrollWorld, document: CompanyPayrollDocument, entityId: string, month: string, actor: string, clock: PayrollClock = systemClock): CompanyPayrollDocument {
  if (!actor.trim()) throw new Error("Signed-in Owner actor required.");
  const doc = structuredClone(document), run = doc.runs[`${entityId}:${month}`];
  if (!run || run.status !== "gm-confirmed") throw new Error("GM confirmation is required before Owner lock.");
  if (run.approvedSignature !== companySourceSignature(data, doc, month)) throw new Error("Financial sources changed after GM confirmation. Reconfirm before locking.");
  const calculation = calculateCompanyEngine(data, doc, month), result = calculation.entities.find(e => e.entityId === entityId)!;
  if (result.exceptions.some(e => e.severity === "blocking")) throw new Error("Resolve blocking exceptions before locking.");
  const outputs = generateCompanyOutputs(data, calculation, entityId);
  if (outputs.uploadIssues?.length) throw new Error(`Fix upload details before locking: ${outputs.uploadIssues.join(" ")}`);
  if (outputs.difference !== 0) throw new Error(`Bank files + cash differ from net pay by ${outputs.difference}.`);
  if (doc.snapshots.some(s => s.entityId === entityId && s.month === month && s.version === run.version)) throw new Error("This version is already frozen.");
  const at = clock.now().toISOString();
  run.audit.push({ at, who: actor, action: "Owner lock (development role simulation)",
    reason: actor === run.gmActor ? "Owner completed both reviews; this is explicitly a non-independent review." : "Independent Owner review and bank/cash reconciliation." });
  run.status = "locked"; run.stage = "outputs"; run.ownerActor = actor;
  doc.snapshots.push({ entityId, month, version: run.version, lockedAt: at, lockedBy: actor, gmActor: run.gmActor!,
    result: structuredClone(result), calculation: structuredClone(calculation), outputs, audit: structuredClone(run.audit),
    rewardConfig: structuredClone({ incentiveAssignments: doc.incentiveAssignments, incentiveVersions: doc.incentiveVersions, servicePolicies: doc.servicePolicies }),
    inputSnapshot: structuredClone(doc.months) });
  return doc;
}
export function markCompanyPaid(document: CompanyPayrollDocument, entityId: string, month: string, actor: string, clock: PayrollClock = systemClock): CompanyPayrollDocument {
  const doc = structuredClone(document), run = doc.runs[`${entityId}:${month}`];
  const snapshot = doc.snapshots.find(s => s.entityId === entityId && s.month === month && s.version === run?.version);
  if (!actor.trim() || run?.status !== "locked" || !snapshot) throw new Error("A locked, reconciled company run is required.");
  const bank = snapshot.outputs.banks.reduce((s, b) => s + b.transfers.reduce((n, p) => n + Math.round(p.amount * 100), 0), 0);
  const cash = snapshot.result.payments.filter(p => p.method !== "bank-transfer").reduce((n, p) => n + Math.round(p.amount * 100), 0);
  if (Math.round(snapshot.result.totals.net * 100) !== bank + cash || snapshot.outputs.difference !== 0 || (snapshot.outputs.uploadDifference ?? 0) !== 0) throw new Error("Frozen bank files plus cash do not reconcile to total net.");
  run.status = "paid"; run.audit.push({ at: clock.now().toISOString(), who: actor, action: "Marked paid (demo record only)", reason: "Reconciliation matches; no bank transfer or cash issuance performed." });
  return doc;
}
export function reopenCompanyRun(document: CompanyPayrollDocument, entityId: string, month: string, actor: string, reason: string, clock: PayrollClock = systemClock): CompanyPayrollDocument {
  if (!actor.trim() || !reason.trim()) throw new Error("Owner actor and reopening reason required.");
  const doc = structuredClone(document), key = `${entityId}:${month}`, prior = doc.runs[key];
  if (!prior || !["locked", "paid"].includes(prior.status)) throw new Error("Only locked or paid runs may be reopened.");
  doc.runs[key] = { ...prior, version: prior.version + 1, status: "draft", stage: "attendance", approvedSignature: undefined, gmActor: undefined, ownerActor: undefined,
    audit: [...prior.audit, { at: clock.now().toISOString(), who: actor, action: "Owner reopen into new version", reason }] };
  return doc;
}
