import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const page = readFileSync(fileURLToPath(new URL(
  '../../oto-app/client/src/pages/bulk-employee-upload-page.tsx', import.meta.url,
)), 'utf8');

/**
 * SCRUM-518: presentation-only employee import review. Runtime browser evidence
 * accompanies these source boundary pins; they do not establish route isolation.
 *
 * FINDING 1 (low, resolved): a same-name employee match was not visible.
 * Prescribed fix: show Matched whenever matchedEmployeeId is present, alongside
 * the existing preview class. Keep email-then-name matching and apply unchanged.
 *
 * FINDING 2 (low, resolved): preview terminology differed from section 6.2.
 * Prescribed fix: label the existing classes New, Changed, Unchanged and Invalid;
 * retain the separate application outcome labels and every per-row message.
 */
describe('SCRUM-518 employee import presentation boundaries', () => {
  it('FINDING 1 fixed: same-name matches are visible without a fifth class', () => {
    expect(page).toContain('{row.matchedEmployeeId && (');
    expect(page).toContain('Matched: {row.matchedEmployeeName || "Existing employee"}');
    expect(page).not.toContain('row.matchedEmployeeName !== row.data.fullName');
    expect(page).toContain('status: "update" | "new" | "no_change" | "error";');
  });

  it('FINDING 2 fixed: preview labels are distinct from application outcomes', () => {
    for (const label of ['New', 'Changed', 'Unchanged', 'Invalid']) {
      expect(page).toContain(`>${label}: </span>`);
    }
    expect(page).toContain('{getStatusBadge(row.status, true)}');
    expect(page).toContain('{preview ? "Invalid" : "Error"}');
    expect(page).toContain('{getStatusBadge(result.status)}');
  });

  it('keeps invalid and unchanged rows outside both automatic and select-all choices', () => {
    expect(page.match(/filter\(r => r\.status !== "error" && r\.status !== "no_change"\)/g)).toHaveLength(2);
    expect(page).toContain('disabled={row.status === "error" || row.status === "no_change"}');
  });

  it('sends the selected original rows and displays each returned result', () => {
    expect(page).toContain('previewData.previewRows.filter(r => selectedRows.has(r.rowNumber))');
    expect(page).toContain('apiRequest("POST", "/api/employees/bulk-update", { rows: rowsToApply })');
    expect(page).toContain('applyResults.results.map((result) => (');
    expect(page).toContain('{result.message}');
    expect(page).toContain('data-testid={`row-result-${result.rowNumber}`}');
  });

  it('retains the existing staff restriction and authenticated preview request', () => {
    expect(page).toContain('const canEdit = user?.role !== "staff";');
    expect(page).toContain('if (!canEdit) {');
    expect(page).toContain('credentials: "include"');
  });
});
