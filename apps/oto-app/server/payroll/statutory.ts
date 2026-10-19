/**
 * Statutory documents (SCRUM-571, the company payroll's R6; plan §9 R6 with
 * owner decision 3, rulebook §7 and §10.1).
 *
 * THE SNAPSHOT BRIDGE, AS BUILT. The prototype's document engine
 * (engine/statutory-engine.ts, statutory-th.ts, ewf-documents.ts — ported
 * unchanged) reads `world.runSnapshots`: the OLDER per-branch flow's locked
 * `RunSnapshot` records. A company month-end lock writes only its own
 * snapshot (prototype company-workflow.ts:44-47; ours, payroll_run_snapshots),
 * never those. The owner ruled (2026-10-20, decision 3) that the build keeps
 * it exactly so until the park decides: company snapshots are NOT converted
 * into per-branch ones. The bridge therefore hands the engine the per-branch
 * locked runs that exist — and the build has no per-branch month-end, so
 * there are none (`legacyBranchRuns`). Everything else the engine reads (the
 * branches, their dated payroll details and lifecycle, the staff, EWF
 * settings) comes from the same world loader the month-end uses.
 *
 * What that means on screen: every offer has no source run, monthly forms
 * show their period as missing, annual forms say "PROVISIONAL – 0 of 12
 * months; missing applicable months are not treated as zero." (the engine's
 * own words), generation refuses with the prototype's "No locked source run
 * is available for this offer.", and the page explains why in plain words
 * (STATUTORY_NO_SOURCE_NOTE), naming the company month-ends of the period
 * that give the documents nothing. Nothing is filled in.
 *
 * Rendering, when a source exists, is the engine's createStatutoryDocument:
 * its printable HTML and its NOT-FOR-FILING upload placeholder are stored
 * frozen (migration 0026) and served sandboxed; every render, opening and
 * filing is written to payroll_statutory_audit. Filing follows the prototype
 * (markStatutoryDocumentFiled): never a provisional, superseded, reminder or
 * EWF document, once per document. A form filed outside the app can also be
 * recorded, saved with the coverage the page showed (usually "no-source").
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, like } from "drizzle-orm";
import {
  payrollEwfRemittances, payrollPayingEntities, payrollRunSnapshots, payrollStatutoryAudit, payrollStatutoryDocuments, payrollStatutoryFilings,
  type PayrollStatutoryDocumentRow, type PayrollStatutoryFilingRow,
} from "@shared/schema";
import {
  STATUTORY_NO_SOURCE_NOTE, statutoryCompanyRunsNote,
  type EwfSurchargeView, type StatutoryAuditView, type StatutoryCoverageState, type StatutoryDocumentView, type StatutoryFilingView, type StatutoryOfferView, type StatutoryView,
} from "@shared/payroll-statutory";
import { db } from "../db";
import { PayrollRefusal, isIsoDate, requireReason, type PayrollActor } from "./setup";
import { loadPayrollWorld, parkToday, WorldRefusal } from "./world";
import { createStatutoryDocument, listStatutoryOffers } from "./engine/statutory-engine";
import { calculateEwfSurcharge } from "./engine/ewf-documents";
import { latestLockedSnapshot } from "./engine/statutory-shared";
import { systemClock, type PayrollClock } from "./engine/clock";
import type { PayrollWorld, RunSnapshot, StatutoryOffer } from "./engine/model";
import type { ServedFile } from "./payslips";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The per-branch locked runs the documents read. The build has no
 * per-branch month-end, so none exist; company month-ends are deliberately
 * not converted into them (owner decision 3). Kept as the one seam the park's
 * ruling will change.
 */
export async function legacyBranchRuns(_tenantId: string): Promise<RunSnapshot[]> {
  return [];
}

export function requirePeriod(value: unknown): string {
  if (typeof value === "string" && (MONTH.test(value) || YEAR.test(value))) return value;
  throw new PayrollRefusal(400, "Statutory period must be YYYY-MM for monthly forms or YYYY for annual forms.");
}

const countryOf = (world: PayrollWorld, branchId: string) => world.branches[branchId]?.detailsHistory.at(-1)?.details.country === "MY" ? "MY" : "TH";
const offerKey = (offer: Pick<StatutoryOffer, "period" | "code" | "staffId">) => `${offer.period}:${offer.code}:${offer.staffId ?? "employer"}`;
const isReminder = (offer: Pick<StatutoryOffer, "code" | "title">) => offer.code.toUpperCase().includes("REMINDER") || offer.title.toUpperCase().includes("REMINDER");
export const coverageState = (offer: Pick<StatutoryOffer, "sourceRuns" | "provisional">): StatutoryCoverageState =>
  !offer.sourceRuns.length ? "no-source" : offer.provisional ? "provisional" : "complete";

/** The world the document engine reads: the month-end's world with the per-branch locked runs bridged in. */
export async function statutoryWorld(tenantId: string, period: string): Promise<PayrollWorld> {
  const month = MONTH.test(period) ? period : `${period}-12`;
  let world: PayrollWorld;
  try {
    ({ world } = await loadPayrollWorld(tenantId, month));
  } catch (error) {
    if (error instanceof WorldRefusal) throw new PayrollRefusal(error.status, error.message);
    throw error;
  }
  world.runSnapshots = await legacyBranchRuns(tenantId);
  // Thailand only goes live (plan §4): a Malaysian branch stays dormant and is not offered here.
  for (const id of Object.keys(world.branches)) if (countryOf(world, id) !== "TH") delete world.branches[id];
  return world;
}

function branchOf(world: PayrollWorld, branchId: unknown) {
  const id = typeof branchId === "string" ? branchId : "";
  if (!id || !world.branches[id]) throw new PayrollRefusal(404, "Branch not found");
  return id;
}

function offersOf(world: PayrollWorld, branchId: string, period: string): StatutoryOffer[] {
  try {
    return listStatutoryOffers(world, branchId, period);
  } catch (error) {
    throw new PayrollRefusal(400, error instanceof Error ? error.message : String(error));
  }
}

/** The prototype's ewfFrozenAmount: employee + employer EWF of every frozen row, or null when any is missing. */
function frozenEwfAmount(snapshot: RunSnapshot | undefined): number | null {
  if (!snapshot) return null;
  const rows = (snapshot.calculations as { rows?: Array<{ statutoryBreakdown?: { employee?: { ewf?: unknown }; employer?: { ewf?: unknown } } }> } | null)?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.some((row) =>
    typeof row.statutoryBreakdown?.employee?.ewf !== "number" || typeof row.statutoryBreakdown?.employer?.ewf !== "number")) return null;
  return rows.reduce((sum, row) => sum + (row.statutoryBreakdown!.employee!.ewf as number) + (row.statutoryBreakdown!.employer!.ewf as number), 0);
}

const superseded = (world: PayrollWorld, sourceRuns: StatutoryOffer["sourceRuns"]) => sourceRuns.some((run) =>
  world.runSnapshots.filter((s) => s.branchId === run.branchId && s.month === run.month).reduce((max, s) => Math.max(max, s.version), 0) > run.version);

const filingOut = (f: PayrollStatutoryFilingRow): StatutoryFilingView => ({
  id: f.id, branchId: f.branchId, period: f.period, code: f.documentCode, staffId: f.staffId, documentId: f.documentId,
  coverageState: f.coverageState, coverage: f.coverage as StatutoryOffer["coverage"], renderedAt: f.renderedAt ? f.renderedAt.toISOString() : null,
  filedOn: String(f.filedOn).slice(0, 10), reference: f.reference, reason: f.reason, filedBy: f.filedByName, createdAt: f.createdAt.toISOString(),
});
type StoredFile = { name: string; mime: string; content: string };
const documentOut = (world: PayrollWorld, d: PayrollStatutoryDocumentRow, filing: PayrollStatutoryFilingRow | undefined): StatutoryDocumentView => ({
  id: d.id, branchId: d.branchId, period: d.period, code: d.documentCode, title: d.title, staffId: d.staffId,
  sourceRuns: d.sourceRuns as StatutoryOffer["sourceRuns"], provisional: d.provisional, coverage: d.coverage as StatutoryOffer["coverage"],
  warnings: d.warnings as string[], dueDate: String(d.dueDate).slice(0, 10),
  files: (d.files as StoredFile[]).map((f, index) => ({ index, name: f.name, mime: f.mime })),
  renderedAt: d.renderedAt.toISOString(), renderedBy: d.renderedByName,
  superseded: superseded(world, d.sourceRuns as StatutoryOffer["sourceRuns"]), filing: filing ? filingOut(filing) : null,
});

async function audit(tx: Tx | typeof db, tenantId: string, actor: PayrollActor, entry: {
  branchId: string; period: string; code: string; staffId?: string | null; documentId?: string | null; filingId?: string | null;
  action: string; reason?: string | null; detail?: unknown;
}) {
  await tx.insert(payrollStatutoryAudit).values({
    tenantId, branchId: entry.branchId, period: entry.period, documentCode: entry.code, staffId: entry.staffId ?? null,
    documentId: entry.documentId ?? null, filingId: entry.filingId ?? null, action: entry.action, reason: entry.reason ?? null,
    detail: entry.detail ?? null, actorUserId: actor.userId, actorName: actor.name,
  });
}

// ─── The page ────────────────────────────────────────────────────────────────

export async function loadStatutoryView(tenantId: string, input: { branchId?: unknown; period?: unknown }, canManage: boolean): Promise<StatutoryView> {
  const today = parkToday();
  const period = input.period == null || input.period === "" ? today.slice(0, 7) : requirePeriod(input.period);
  const kind = MONTH.test(period) ? "month" : "year";
  const world = await statutoryWorld(tenantId, period);
  const branches = Object.values(world.branches).map((b) => {
    const details = b.detailsHistory.at(-1)?.details;
    return { id: b.id, name: world.costCentreNames?.[b.id] ?? details?.name ?? b.id, legalEntity: details?.legalEntity ?? "" };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const requested = typeof input.branchId === "string" && input.branchId ? input.branchId : null;
  if (requested && !world.branches[requested]) throw new PayrollRefusal(404, "Branch not found");
  const branchId = requested ?? branches[0]?.id ?? null;

  const companyLocked = (await db.select({ entityName: payrollPayingEntities.name, month: payrollRunSnapshots.month, version: payrollRunSnapshots.version })
    .from(payrollRunSnapshots)
    .innerJoin(payrollPayingEntities, and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, payrollRunSnapshots.entityId)))
    .where(and(eq(payrollRunSnapshots.tenantId, tenantId), kind === "month" ? eq(payrollRunSnapshots.month, period) : like(payrollRunSnapshots.month, `${period}-%`)))
    .orderBy(asc(payrollRunSnapshots.month), asc(payrollPayingEntities.name), asc(payrollRunSnapshots.version)));
  const notes: string[] = [];
  if (!world.runSnapshots.length) notes.push(STATUTORY_NO_SOURCE_NOTE);
  if (companyLocked.length) {
    notes.push(statutoryCompanyRunsNote(companyLocked.length, companyLocked.map((r) => `${r.entityName} ${r.month} v${r.version}`).join(", ")));
  }

  const empty: StatutoryView = {
    period, kind, today, branches, branchId, source: { legacyRuns: world.runSnapshots.length, companyLocked, notes },
    offers: [], documents: [], filings: [], audit: [], ewf: { relevant: false, remittanceDue: null, frozenPrincipal: null, paid: null, lines: [] }, canManage,
  };
  if (!branchId) return empty;

  const offers = offersOf(world, branchId, period);
  const [docRows, filingRows, auditRows] = await Promise.all([
    db.select().from(payrollStatutoryDocuments).where(and(eq(payrollStatutoryDocuments.tenantId, tenantId), eq(payrollStatutoryDocuments.branchId, branchId), eq(payrollStatutoryDocuments.period, period)))
      .orderBy(desc(payrollStatutoryDocuments.renderedAt)),
    db.select().from(payrollStatutoryFilings).where(and(eq(payrollStatutoryFilings.tenantId, tenantId), eq(payrollStatutoryFilings.branchId, branchId), eq(payrollStatutoryFilings.period, period)))
      .orderBy(desc(payrollStatutoryFilings.createdAt)),
    db.select().from(payrollStatutoryAudit).where(and(eq(payrollStatutoryAudit.tenantId, tenantId), eq(payrollStatutoryAudit.branchId, branchId), eq(payrollStatutoryAudit.period, period)))
      .orderBy(desc(payrollStatutoryAudit.at)).limit(200),
  ]);
  const filingByDoc = new Map(filingRows.filter((f) => f.documentId).map((f) => [f.documentId!, f]));
  const documents = docRows.map((d) => documentOut(world, d, filingByDoc.get(d.id)));
  const offerViews: StatutoryOfferView[] = offers.map((offer) => {
    const doc = documents.find((d) => d.code === offer.code && (d.staffId ?? undefined) === offer.staffId);
    return { ...offer, key: offerKey(offer), reminderOnly: isReminder(offer), coverageState: coverageState(offer), documentId: doc?.id ?? null,
      filed: Boolean(doc?.filing) || filingRows.some((f) => f.documentCode === offer.code && (f.staffId ?? undefined) === offer.staffId) };
  });

  // EWF (prototype statutory page): a Thai branch and a month from October 2026.
  const ewf: StatutoryView["ewf"] = { relevant: false, remittanceDue: null, frozenPrincipal: null, paid: null, lines: [] };
  const details = world.branches[branchId].detailsHistory.filter((d) => d.effectiveFrom <= (kind === "month" ? period : `${period}-12`)).at(-1)?.details;
  if (kind === "month" && period >= "2026-10" && countryOf(world, branchId) === "TH") {
    ewf.relevant = true;
    const snapshot = latestLockedSnapshot(world, branchId, period);
    const remittanceOffer = offers.find((o) => o.code === "EWF3");
    ewf.remittanceDue = remittanceOffer?.dueDate ?? null;
    ewf.frozenPrincipal = frozenEwfAmount(snapshot);
    if (details?.payingEntityId) {
      const [paid] = await db.select().from(payrollEwfRemittances).where(and(eq(payrollEwfRemittances.tenantId, tenantId),
        eq(payrollEwfRemittances.entityId, details.payingEntityId), eq(payrollEwfRemittances.month, period))).limit(1);
      if (paid) ewf.paid = { amountPaid: Number(paid.amountPaid), paidOn: paid.paidOn ? String(paid.paidOn).slice(0, 10) : null };
    }
    if (!snapshot) ewf.lines.push(`No locked per-branch payroll month for ${period}: the EWF documents, contribution totals and alerts are unavailable.`);
    if (snapshot && !remittanceOffer && ewf.frozenPrincipal === null) ewf.lines.push("Frozen EWF employee/employer amounts are unavailable for this approved version; no contribution or surcharge amount is inferred.");
    if (ewf.frozenPrincipal === null) ewf.lines.push("Estimate unavailable: no locked EWF3 source with frozen contribution amounts is available.");
  }

  return {
    ...empty, offers: offerViews, documents, filings: filingRows.map(filingOut),
    audit: auditRows.map((a): StatutoryAuditView => ({ id: a.id, code: a.documentCode, staffId: a.staffId, documentId: a.documentId, filingId: a.filingId,
      action: a.action, reason: a.reason, who: a.actorName, at: a.at.toISOString() })),
    ewf,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export async function renderDocument(tenantId: string, actor: PayrollActor, input: Record<string, unknown>, clock: PayrollClock = systemClock) {
  const reason = requireReason(input.reason);
  const period = requirePeriod(input.period);
  const world = await statutoryWorld(tenantId, period);
  const branchId = branchOf(world, input.branchId);
  const code = typeof input.code === "string" ? input.code : "";
  const staffId = typeof input.staffId === "string" && input.staffId ? input.staffId : undefined;
  const offer = offersOf(world, branchId, period).find((o) => o.code === code && o.staffId === staffId);
  if (!offer) throw new PayrollRefusal(409, `Statutory offer ${code || "(none)"} is no longer applicable; refresh the offer list.`);
  if (isReminder(offer)) throw new PayrollRefusal(409, "Reminder-only entries are not filing documents and cannot be generated.");
  if (!offer.sourceRuns.length) throw new PayrollRefusal(409, "No locked source run is available for this offer.", [STATUTORY_NO_SOURCE_NOTE]);
  let document;
  try {
    document = createStatutoryDocument(world, offer, actor.name, clock);
  } catch (error) {
    throw new PayrollRefusal(409, error instanceof Error ? error.message : String(error));
  }
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(payrollStatutoryDocuments)
      .where(and(eq(payrollStatutoryDocuments.tenantId, tenantId), eq(payrollStatutoryDocuments.documentKey, document.id))).limit(1);
    if (existing) {
      await audit(tx, tenantId, actor, { branchId, period, code, staffId: staffId ?? null, documentId: existing.id,
        action: "regeneration-noop: identical frozen source version retained", reason });
      return { id: existing.id, created: false, message: "This exact frozen source version is already registered. It was preserved without creating a duplicate; the request was audited." };
    }
    const [prior] = await tx.select({ id: payrollStatutoryDocuments.id }).from(payrollStatutoryDocuments).where(and(eq(payrollStatutoryDocuments.tenantId, tenantId),
      eq(payrollStatutoryDocuments.branchId, branchId), eq(payrollStatutoryDocuments.period, period), eq(payrollStatutoryDocuments.documentCode, code))).limit(1);
    const [row] = await tx.insert(payrollStatutoryDocuments).values({
      tenantId, branchId, period, documentCode: code, documentKey: document.id, staffId: staffId ?? null, title: document.title,
      sourceRuns: document.sourceRuns, provisional: document.provisional, coverage: document.coverage, warnings: document.warnings,
      dueDate: document.dueDate, html: document.html, files: document.files, sha256: createHash("sha256").update(document.html).digest("hex"),
      renderedBy: actor.userId, renderedByName: actor.name,
    }).returning();
    await audit(tx, tenantId, actor, { branchId, period, code, staffId: staffId ?? null, documentId: row.id, action: prior ? "regenerated" : "generated", reason,
      detail: { sourceRuns: document.sourceRuns, provisional: document.provisional } });
    return { id: row.id, created: true, message: `${document.title} generated from ${document.sourceRuns.length} approved run(s).` };
  });
}

/** A rendered document's file, exactly as frozen; the opening is audited. Index 0 is the printable HTML. */
export async function openDocumentFile(tenantId: string, actor: PayrollActor, id: string, index: string, download: boolean): Promise<ServedFile> {
  if (!UUID.test(id)) throw new PayrollRefusal(404, "Document not found");
  const [doc] = await db.select().from(payrollStatutoryDocuments).where(and(eq(payrollStatutoryDocuments.tenantId, tenantId), eq(payrollStatutoryDocuments.id, id))).limit(1);
  if (!doc) throw new PayrollRefusal(404, "Document not found");
  const file = (doc.files as StoredFile[])[Number(index)];
  if (!/^\d+$/.test(index) || !file) throw new PayrollRefusal(404, "File not found");
  await audit(db, tenantId, actor, { branchId: doc.branchId, period: doc.period, code: doc.documentCode, staffId: doc.staffId, documentId: doc.id,
    action: `${download ? "downloaded" : "opened"} ${file.name}` });
  return { filename: file.name, mime: file.mime.split(";")[0], body: Buffer.from(file.content, "utf8") };
}

// ─── Filing records ──────────────────────────────────────────────────────────

export async function recordFiling(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  const reference = typeof input.reference === "string" ? input.reference.trim().slice(0, 200) : "";
  if (!isIsoDate(input.filedOn) || !reference) throw new PayrollRefusal(400, "A valid filing date, reference, recognized role, and actor are required.");
  const filedOn = input.filedOn as string;
  const documentId = typeof input.documentId === "string" && input.documentId ? input.documentId : null;

  if (documentId) {
    // The prototype's markStatutoryDocumentFiled, in its order.
    if (!UUID.test(documentId)) throw new PayrollRefusal(404, "Document not found");
    const [doc] = await db.select().from(payrollStatutoryDocuments).where(and(eq(payrollStatutoryDocuments.tenantId, tenantId), eq(payrollStatutoryDocuments.id, documentId))).limit(1);
    if (!doc) throw new PayrollRefusal(404, "Document not found");
    if (doc.provisional) throw new PayrollRefusal(409, "Provisional statutory documents cannot be marked filed.");
    if (isReminder({ code: doc.documentCode, title: doc.title })) throw new PayrollRefusal(409, "Reminder-only entries are not filing documents and cannot be marked filed.");
    if (doc.documentCode.startsWith("EWF")) throw new PayrollRefusal(409, "Prototype-only EWF document. Never file this output; no official PDF or submission is included.");
    const world = await statutoryWorld(tenantId, doc.period);
    if (!world.branches[doc.branchId]) throw new PayrollRefusal(404, "Branch not found");
    const current = offersOf(world, doc.branchId, doc.period).find((o) => o.code === doc.documentCode && (o.staffId ?? null) === doc.staffId);
    if (!current) throw new PayrollRefusal(409, `Statutory offer ${doc.documentCode} is no longer applicable; refresh the offer list.`);
    if (current.provisional) throw new PayrollRefusal(409, "Statutory documents must be final against current authoritative coverage before filing.");
    if (superseded(world, doc.sourceRuns as StatutoryOffer["sourceRuns"])) throw new PayrollRefusal(409, "Superseded statutory documents cannot be marked filed.");
    return db.transaction(async (tx) => {
      const [already] = await tx.select({ id: payrollStatutoryFilings.id }).from(payrollStatutoryFilings)
        .where(and(eq(payrollStatutoryFilings.tenantId, tenantId), eq(payrollStatutoryFilings.documentId, doc.id))).limit(1);
      if (already) throw new PayrollRefusal(409, "This document already has a filing event; generate a new version for an amendment.");
      const [row] = await tx.insert(payrollStatutoryFilings).values({
        tenantId, branchId: doc.branchId, period: doc.period, documentCode: doc.documentCode, staffId: doc.staffId, documentId: doc.id,
        coverageState: "complete", coverage: doc.coverage, sourceRuns: doc.sourceRuns, renderedAt: doc.renderedAt,
        filedOn, reference, reason, filedBy: actor.userId, filedByName: actor.name,
      }).returning();
      await audit(tx, tenantId, actor, { branchId: doc.branchId, period: doc.period, code: doc.documentCode, staffId: doc.staffId, documentId: doc.id, filingId: row.id,
        action: "filed", reason, detail: { filedOn, reference } });
      return filingOut(row);
    });
  }

  // A form filed outside the app: recorded with the coverage this page shows now.
  const period = requirePeriod(input.period);
  const world = await statutoryWorld(tenantId, period);
  const branchId = branchOf(world, input.branchId);
  const code = typeof input.code === "string" ? input.code : "";
  const staffId = typeof input.staffId === "string" && input.staffId ? input.staffId : undefined;
  const offer = offersOf(world, branchId, period).find((o) => o.code === code && o.staffId === staffId);
  if (!offer) throw new PayrollRefusal(409, `Statutory offer ${code || "(none)"} is no longer applicable; refresh the offer list.`);
  if (isReminder(offer)) throw new PayrollRefusal(409, "Reminder-only entries are not filing documents and cannot be marked filed.");
  const state = coverageState(offer);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(payrollStatutoryFilings).values({
      tenantId, branchId, period, documentCode: code, staffId: staffId ?? null, documentId: null,
      coverageState: state, coverage: offer.coverage, sourceRuns: offer.sourceRuns, renderedAt: null,
      filedOn, reference, reason, filedBy: actor.userId, filedByName: actor.name,
    }).returning();
    await audit(tx, tenantId, actor, { branchId, period, code, staffId: staffId ?? null, filingId: row.id,
      action: "filing recorded (filed outside the app)", reason, detail: { filedOn, reference, coverageState: state, coverage: offer.coverage } });
    return filingOut(row);
  });
}

// ─── EWF late-payment surcharge (rulebook §7) ────────────────────────────────

/** The engine's calculateEwfSurcharge on entered figures: 5% per full month late, +1 at a 15-day remainder, never compounded. */
export function ewfSurcharge(input: { dueDate?: unknown; asOfDate?: unknown; principal?: unknown }): EwfSurchargeView {
  const principal = typeof input.principal === "string" && input.principal.trim() !== "" ? Number(input.principal) : typeof input.principal === "number" ? input.principal : NaN;
  try {
    return calculateEwfSurcharge(String(input.dueDate ?? ""), String(input.asOfDate ?? ""), principal);
  } catch (error) {
    throw new PayrollRefusal(400, error instanceof Error ? error.message : String(error));
  }
}

