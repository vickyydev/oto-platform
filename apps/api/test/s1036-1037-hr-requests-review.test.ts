import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Adversarial pins for two of the owner's smaller HR app requests of
 * 19 November 2026 (docs/progress/plans/dropoff-beo-20261119/ANSWERS.md §6):
 *
 * - SCRUM-1036, the Scheduling order: "Repair it". The drag saves the order
 *   shown; a new employee takes a place at the end.
 * - SCRUM-1037, leave types: Training and Other off; staff see annual leave
 *   and holidays; the other legal types for managers only.
 *
 * The behaviour itself is checked in the app's own files, run by CI's app
 * job: tests/employee-order.check.ts, tests/employee-order-http.check.ts,
 * tests/leave-type-audience.check.ts (0053 replayed twice) and
 * tests/leave-types-manager-ui.check.ts. These pins hold the release
 * contract: what the migration may and may not touch, where the access rule
 * lives on the server, and that the two screens share one order.
 *
 * SCRUM-1038 (a former employee invited to one shift) is not in this
 * landing: company payroll does not pay a single shift until the owner rules
 * how, so its code is held off main and nothing of it is pinned here.
 *
 * Standing owner notes (on SCRUM-1037, not defects): staff still see their
 * own Sick Leave and Business Days records and balances, as history reads as
 * before; payroll builds its leave policy from active types (world.ts), so a
 * run calculated after 0053 has five types and a confirmed, unpaid run reads
 * as changed once and is confirmed again with the same figures.
 */
const app = new URL('../../oto-app/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), 'utf8').replace(/\r\n/g, '\n');
const executable = (sql: string) => sql.replace(/^\s*--.*$/gm, '');

describe('SCRUM-1037: managers-only leave types, Training and Other off', () => {
  const sql = read('migrations/0053_leave_type_managers_only.sql');
  const code = executable(sql);
  const journal: { entries: Array<{ idx: number; tag: string; when: number }> } = JSON.parse(read('migrations/meta/_journal.json'));

  it('CRITICAL control: 0053 is the next migration after 0052, its snapshot chained to 0052', () => {
    const entry = journal.entries.find((e) => e.tag === '0053_leave_type_managers_only');
    const prior = journal.entries.find((e) => e.idx === 52);
    expect(entry).toMatchObject({ idx: 53 });
    expect(prior?.tag).toBe('0052_otoapp_beo_bar_charge_provenance');
    expect(entry!.when).toBeGreaterThan(prior!.when);
    const before = JSON.parse(read('migrations/meta/0052_snapshot.json'));
    const after = JSON.parse(read('migrations/meta/0053_snapshot.json'));
    expect(after.prevId).toBe(before.id);
    expect(after.tables['public.leave_types'].columns.managers_only)
      .toEqual({ name: 'managers_only', type: 'boolean', primaryKey: false, notNull: true, default: false });
    delete before.tables['public.leave_types'].columns;
    const afterTable = after.tables['public.leave_types'];
    delete afterTable.columns;
    expect(afterTable).toEqual(before.tables['public.leave_types']);
  });

  it('CRITICAL control: 0053 is expand-only and writes no leave record, balance or pay', () => {
    expect(sql).not.toContain('"public".');
    expect(code).toContain('ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "managers_only" boolean DEFAULT false NOT NULL;');
    expect(code).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/i);
    expect(code).not.toMatch(/\b(?:employee_time_off|leave_openings|employee_leave_overrides|payroll_[a-z_]+)\b/i);
    expect(code.match(/^UPDATE\s+(\w+)/gim)).toEqual(['UPDATE leave_types', 'UPDATE leave_types']);
    expect(code.match(/ALTER TABLE/g)).toHaveLength(1);
  });

  it('HIGH fixed: only the built-in codes change, by code, and a switched-off type is never deleted', () => {
    expect(code).toMatch(/UPDATE leave_types SET managers_only = true, updated_at = now\(\)\s+WHERE upper\(code\) IN \('SICK', 'BUSINESS', 'UNPAID'\) AND NOT managers_only;/);
    expect(code).toMatch(/UPDATE leave_types SET is_active = false, updated_at = now\(\)\s+WHERE is_active\s+AND upper\(code\) IN \('TRAINING', 'OTHER'\);/);
    // A new park group's seed makes the same set: Annual Leave and Days Off seen by staff.
    expect(code).toContain("(p_tenant, 'ANNUAL', 'Annual Leave', true, false, 'YEARLY',");
    expect(code).toContain("(p_tenant, 'CHANGE_DAY_OFF', 'Days Off', true, false, 'WORKDAYS', 0, 0, false,");
    expect(code).toContain("(p_tenant, 'TRAINING', 'Training', false, false, 'NONE', 0, 0, false, 0, 0),");
    expect(code).toContain("(p_tenant, 'OTHER', 'Other', false, false, 'NONE', 0, 0, false, 0, 0)");
    expect(code).toContain('ON CONFLICT (tenant_id, upper(code)) DO NOTHING;');
  });

  it('CRITICAL control: the managers-only rule is enforced on the server list, by the manager rank', () => {
    const routes = read('server/routes.ts');
    const audience = read('server/lib/leaveTypeAudience.ts');
    expect(audience).toContain('return manager ? types : types.filter((type) => !type.managersOnly);');
    expect(routes).toContain('const types = leaveTypesShownTo(await listTenantLeaveTypes(tenantId), isManagerRank(user));');
    // Recording stays a manager's, as before: no staff door was opened.
    expect(routes).toContain('app.post("/api/time-off", requireAuth, requireManager, async (req, res, next) => {');
    expect(routes).toContain('app.patch("/api/time-off/:id", requireAuth, requireManager, async (req, res, next) => {');
  });

  it('HIGH fixed: leave already taken on a switched-off type reads as it did while on', () => {
    const reading = read('client/src/lib/leave-balance-reading.ts');
    expect(reading).toContain('return balance.isActive || balance.used !== 0;');
    expect(read('client/src/pages/employee-editor-page.tsx')).toContain('const totalBalance = data ? daysLeftTotal(data.balances) : 0;');
    const card = read('client/src/pages/timekeeping-employee-detail-page.tsx');
    expect(card).toContain('{!readsAsActive(balance) ? "Not active"');
    expect(card).toContain('{readsAsActive(balance) ? `${balance.balance} days` : "—"}');
  });

  it('MEDIUM owner note pinned as built: payroll still reads active types only (no payroll change here)', () => {
    expect(read('server/payroll/world.ts'))
      .toContain('const leavePolicy = leavePolicyFromCatalogue(country, leaveTypes.filter((t) => t.isActive), holidays, dayOff);');
  });
});

describe('SCRUM-1036: the employee order saved as dragged', () => {
  const order = read('client/src/lib/employee-order.ts');

  it('HIGH fixed: one comparator, stable, for both screens', () => {
    expect(order).toContain('return (a.displayOrder ?? 0) - (b.displayOrder ?? 0);');
    for (const page of ['client/src/pages/scheduling-page.tsx', 'client/src/pages/employees-page.tsx']) {
      const text = read(page);
      expect(text).toContain('import { compareEmployeeOrder, orderAfterDrag } from "@/lib/employee-order";');
      expect(text).toContain('emps.sort(compareEmployeeOrder);');
      expect(text).toMatch(/const newOrder = orderAfterDrag\(department, shownIds, activeEmpId, overEmpId\);\s+if \(newOrder\) reorderEmployeesMutation\.mutate\(newOrder\);/);
    }
  });

  it('HIGH fixed: a drag in a filtered view saves the whole department, hidden staff in their places', () => {
    expect(order).toContain('const full = sortEmployeesForDisplay(department).map((e) => e.id);');
    expect(order).toContain('return full.map((id) => (shownSet.has(id) ? moved[next++] : id));');
  });

  it('MEDIUM fixed: the reorder endpoint refuses repeated or non-string ids and stays in the park group', () => {
    const routes = read('server/routes.ts');
    expect(routes).toContain('new Set(orderedIds).size !== orderedIds.length');
    expect(routes).toContain('return res.status(400).json({ message: "orderedIds must be an array of distinct employee ids" });');
    expect(routes).toContain('if (parkGroup) await storage.reorderEmployees(orderedIds, parkGroup);');
  });

  it('HIGH fixed: a new employee takes the place after the last; a set place is kept', () => {
    const storage = read('server/storage.ts');
    expect(storage).toContain('if (displayOrder === undefined || displayOrder === null) {');
    expect(storage).toContain('.where(eq(employees.tenantId, employee.tenantId));');
    expect(storage).toContain('displayOrder = (last?.max ?? -1) + 1;');
  });
});
