/**
 * The company payroll's statutory documents (SCRUM-571, R6) as the routes
 * return them and the page reads them. The engine's own offer type is
 * re-exported type-only: nothing of the engine is bundled into the client.
 *
 * Owner decision 3 (2026-10-20): the documents are built exactly as the
 * prototype has them. Its document engine reads the OLDER per-branch locked
 * runs; a company month-end lock writes none. So on our data every form has
 * no source, and the page says so in the words below — never an empty page,
 * never a figure that was not frozen.
 */
export type { StatutoryOffer } from "../server/payroll/engine/model";
import type { StatutoryOffer } from "../server/payroll/engine/model";

/** Why every form is empty or provisional while company month-ends are the only month-ends. */
export const STATUTORY_NO_SOURCE_NOTE =
  "Company month-ends do not feed these documents. The documents read locked per-branch payroll runs, as the prototype's document engine does, and locking a company month-end writes none. Until the park decides how company month-ends should reach the tax and social-security documents, every form here shows no source and stays provisional. Nothing is filled in, and no missing month is counted as zero.";

/** Said when the period HAS locked company month-ends: they are there, and they give the documents nothing. */
export const statutoryCompanyRunsNote = (count: number, list: string) =>
  `${count} locked company month-end${count === 1 ? "" : "s"} for this period (${list}) ${count === 1 ? "gives" : "give"} these documents nothing.`;

/** A filing recorded for a form filed outside the app: what the record does and does not say. */
export const STATUTORY_OUTSIDE_FILING_NOTE =
  "This records that the form was filed outside the app (for example by the accountant). No document from this page backs it; it is saved with the coverage this page showed at the time.";

export type StatutoryCoverageState = "complete" | "provisional" | "no-source";

export interface StatutoryBranchRef { id: string; name: string; legalEntity: string }

export interface StatutoryOfferView extends StatutoryOffer {
  key: string;
  /** Reminder-only offers are not filing documents (prototype: isReminderOffer). */
  reminderOnly: boolean;
  coverageState: StatutoryCoverageState;
  /** The newest rendered document for this offer, if any. */
  documentId: string | null;
  filed: boolean;
}

export interface StatutoryDocumentFileRef { index: number; name: string; mime: string }
export interface StatutoryDocumentView {
  id: string; branchId: string; period: string; code: string; title: string; staffId: string | null;
  sourceRuns: StatutoryOffer["sourceRuns"]; provisional: boolean; coverage: StatutoryOffer["coverage"]; warnings: string[];
  dueDate: string; files: StatutoryDocumentFileRef[]; renderedAt: string; renderedBy: string;
  superseded: boolean; filing: StatutoryFilingView | null;
}

export interface StatutoryFilingView {
  id: string; branchId: string; period: string; code: string; staffId: string | null; documentId: string | null;
  coverageState: StatutoryCoverageState; coverage: StatutoryOffer["coverage"]; renderedAt: string | null;
  filedOn: string; reference: string; reason: string; filedBy: string; createdAt: string;
}

export interface StatutoryAuditView {
  id: string; code: string; staffId: string | null; documentId: string | null; filingId: string | null;
  action: string; reason: string | null; who: string; at: string;
}

export interface StatutoryEwfView {
  /** The prototype's rule: a Thai branch, a monthly period from October 2026. */
  relevant: boolean;
  remittanceDue: string | null;
  /** The frozen employee + employer EWF of the locked source month; null when there is none. */
  frozenPrincipal: number | null;
  paid: { amountPaid: number; paidOn: string | null } | null;
  lines: string[];
}

export interface StatutoryView {
  period: string;
  kind: "month" | "year";
  today: string;
  branches: StatutoryBranchRef[];
  branchId: string | null;
  source: { legacyRuns: number; companyLocked: { entityName: string; month: string; version: number }[]; notes: string[] };
  offers: StatutoryOfferView[];
  documents: StatutoryDocumentView[];
  filings: StatutoryFilingView[];
  audit: StatutoryAuditView[];
  ewf: StatutoryEwfView;
  canManage: boolean;
}

export interface EwfSurchargeView {
  dueDate: string; asOfDate: string; unpaidPrincipal: number; chargeableMonths: number; surcharge: number;
}
