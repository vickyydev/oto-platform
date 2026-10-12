import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-516 attendance review: resolved findings retain their severity and
 * prescribed correction below. Real handler/DB attacks live in the app's
 * tests/timekeeping-review.check.ts: own/foreign parents, empty branch access,
 * repeated and competing decisions, and a failure between the related writes.
 * These pins hold the registration, field mapping and scope seams in API CI,
 * which does not install the lifted app's separate dependency tree.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../oto-app/${path}`, import.meta.url)), 'utf8');
const source = read('server/timekeeping-review-routes.ts');
const routes = read('server/routes.ts');
const page = read('client/src/pages/timekeeping-review-page.tsx');

describe('SCRUM-516 attendance review consistency', () => {
  it('high: both reviewer doors retain authentication and the existing manager guard', () => {
    expect(source).toContain('app.get("/api/timekeeping/pending-issues", requireAuth, requireManager');
    expect(source).toContain('app.post("/api/timekeeping/issues/:issueId/resolve", requireAuth, requireManager');
    expect(routes).toContain('registerTimekeepingReviewRoutes(app, {');
    expect(routes).toContain('getUserBranchAccess: userId => storage.getUserBranchAccess(userId)');
  });

  it('FINDING resolved [high]: select OPEN issues through their pending entry and exact park/employee/branch parents', () => {
    expect(source).toContain('eq(timekeepingIssues.status, "OPEN")');
    expect(source).toContain('eq(timeEntries.status, "PENDING_APPROVAL")');
    expect(source).toContain('eq(timeEntries.id, timekeepingIssues.linkedTimeEntryId)');
    for (const table of ['timekeepingIssues', 'timeEntries', 'employees', 'branches']) {
      expect(source).toContain(`eq(${table}.tenantId, tenantId)`);
    }
    expect(source).toContain('eq(timeEntries.employeeId, timekeepingIssues.employeeId)');
    expect(source).toContain('eq(timeEntries.branchId, timekeepingIssues.branchId)');
    expect(source).toContain('!allBranches && branchIds.length === 0');
    expect(source).toContain('orderBy(desc(timekeepingIssues.issueDate))');
  });

  it('FINDING resolved [high]: resolve the exact linked parent and atomically save existing entry/issue states and note', () => {
    expect(source).toContain('db.transaction(async tx =>');
    expect(source.match(/\.for\("update"/g)).toHaveLength(2);
    expect(source).toContain('eq(timeEntries.id, issue.linkedTimeEntryId ?? "")');
    expect(source).toContain('eq(timeEntries.employeeId, issue.employeeId)');
    expect(source).toContain('eq(timeEntries.branchId, issue.branchId)');
    expect(source).toContain('!allBranches && !branchIds.includes(issue.branchId)');
    expect(source).toContain('action === "approve" ? "APPROVED" : "REJECTED"');
    expect(source).toContain('action === "approve" ? "RESOLVED" : "REJECTED"');
    expect(source).toContain('resolutionNote: managerNote || null');
    expect(source).not.toMatch(/clock(?:In|Out)At\s*:/);
  });

  it('FINDING resolved [medium]: retries retain the first reviewer, note and time; competing decisions cannot overwrite them', () => {
    const replay = source.indexOf('issue.status === issueStatus && linked.entry.status === entryStatus');
    const pending = source.indexOf('issue.status !== "OPEN" || linked.entry.status !== "PENDING_APPROVAL"');
    const write = source.indexOf('tx.update(timeEntries)');
    expect(replay).toBeGreaterThan(0);
    expect(pending).toBeGreaterThan(replay);
    expect(write).toBeGreaterThan(pending);
    expect(source).toContain('new ReviewRefusal(409, "Issue is no longer pending review")');
  });

  it('FINDING resolved [medium]: display the stored proposed clock-in and submitted note', () => {
    expect(page).toContain('userProposedClockInAt');
    expect(page).toContain('issue.note');
    expect(page).not.toContain('userClockInAt');
    expect(page).not.toContain('userNote');
  });

  it('high: optional attendance attachment metadata never exposes the storage object name', () => {
    expect(source).toContain('attachment: attachment ? { fileName: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size } : null');
    expect(source).not.toContain('objectName');
  });
});
