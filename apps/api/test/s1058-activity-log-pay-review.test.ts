import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Adversarial pins for SCRUM-1058, found in review of the HR app's smaller
 * requests: the activity log showed salary-change entries, whose words and
 * metadata carry the old and new figures, to any signed-in person with the
 * branch in reach. Decision of 19 November 2026: pay figures are shown only
 * to the roles that may see salaries (canViewHrSalary, SCRUM-559), and the
 * activity log follows the same rule.
 *
 * The behaviour is checked over HTTP in the app's own file, run by CI's app
 * job: tests/activity-log-pay.check.ts (staff and a manager by list, count,
 * type, employee, search and summary; another entry's pay fields taken out;
 * an administrator reads it whole; nothing stored changes). These pins hold
 * where the rule lives on the server, so a later edit of the log's routes or
 * storage cannot drop it silently.
 *
 * Also in this landing: on Policies > Leave Types a switched-off type names
 * no audience beside "Disabled" (a follow-up of SCRUM-1037).
 *
 * SCRUM-1038 and SCRUM-1055 (a former employee invited to one shift, and its
 * pay) are not in this landing: parts of the pay wait for the owner (a casual
 * day rate, the service-charge share), so the single shift is held off main
 * and nothing of it is pinned here.
 */
const app = new URL('../../oto-app/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), 'utf8').replace(/\r\n/g, '\n');

describe('SCRUM-1058: pay entries of the activity log reach the salary roles only', () => {
  const rule = read('server/lib/activityPay.ts');
  const routes = read('server/routes.ts');
  const storage = read('server/storage.ts');

  it('CRITICAL control: the rule is the app\'s own salary rule, not a new one', () => {
    expect(rule).toContain('import { canViewHrSalary, containsHrPayFields, redactHrPay, type HrSalarySubject } from "@shared/hr-salary-permission";');
    // SCRUM-1038: a single shift's pay switch joined the list; the rule and its two readers are unchanged.
    expect(rule).toContain('export const PAY_ACTIVITY_TYPES: readonly ActivityType[] = ["salary_change", "single_shift_pay_changed"];');
    expect(rule).toContain('return canViewHrSalary(subject) ? [] : PAY_ACTIVITY_TYPES;');
    expect(rule).toContain('if (canViewHrSalary(subject)) return logs;');
    expect(rule).toContain('return containsHrPayFields(metadata) ? { ...log, metadataJson: JSON.stringify(redactHrPay(metadata)) } : log;');
  });

  it('CRITICAL control: the list withholds the pay types and redacts what it returns, for the signed-in reader', () => {
    expect(routes).toContain('options.withheldTypes = activityTypesWithheldFrom(req.userWithAccess ?? req.user);');
    expect(routes).toContain('res.json({ logs: activityForReader(logs, req.userWithAccess ?? req.user), totalCount });');
    // One options object feeds both the page and its count.
    expect(routes).toMatch(/storage\.getActivityLogs\(options\),\s+storage\.getActivityLogCount\(options\)/);
  });

  it('HIGH fixed: the dashboard summary counts a salary change for the salary roles only', () => {
    expect(routes).toContain('{ parkGroup, withheldTypes: activityTypesWithheldFrom(req.userWithAccess ?? req.user) };');
    expect(storage).toMatch(/types: employeeChangeTypes,\s+withheldTypes: options\?\.withheldTypes,/);
  });

  it('CRITICAL control: the withheld types are a condition of the one builder the list, count and filters share', () => {
    expect(storage).toContain('conditions.push(notInArray(activityLog.activityType, [...options.withheldTypes]));');
    expect(storage.match(/private buildActivityLogConditions\(/g)).toHaveLength(1);
    // Every reader of the log takes them: the interface's three and the class's four.
    expect(storage.match(/withheldTypes\?: readonly ActivityType\[\];/g)).toHaveLength(7);
    // A type filter cannot ask for them back: the conditions are ANDed.
    expect(storage).toContain('.where(conditions.length > 0 ? and(...conditions) : undefined);');
  });

  it('HIGH fixed: the log has three doors only, each under the rule or writing no entry back', () => {
    const doors = Array.from(routes.matchAll(/app\.(get|post|put|patch|delete)\("(\/api\/activity-log[^"]*)"/g)).map((m) => `${m[1]} ${m[2]}`);
    expect(doors).toEqual(['get /api/activity-logs', 'get /api/activity-logs/summary', 'post /api/activity-logs/backfill-departures']);
  });

  it('MEDIUM pinned as built: the salary change still writes its figures, so the rule is what keeps them in', () => {
    expect(routes).toContain('activityType: "salary_change",');
    expect(read('server/employee-action-routes.ts')).toContain('salary_adjustment: "salary_change"');
  });

  it('MEDIUM: CI runs the HTTP check in the app job', () => {
    const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).toContain('run: npx tsx tests/activity-log-pay.check.ts');
  });
});

describe('SCRUM-1037 follow-up: a switched-off leave type names no audience', () => {
  it('LOW fixed: "Managers only" or "Staff can see" shows only beside an active type', () => {
    const screen = read('client/src/components/leave/leave-types-manager.tsx');
    expect(screen).toContain('{type.isActive && <Badge variant={type.managersOnly ? "secondary" : "outline"} data-testid={`leave-type-audience-${type.code}`}>{type.managersOnly ? "Managers only" : "Staff can see"}</Badge>}');
    expect(screen).toContain('{type.isActive ? "Active" : "Disabled"}');
  });
});
