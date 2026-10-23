import { describe, expect, it } from 'vitest';
import {
  INBOX_ROLE_BUNDLES, PERMISSIONS, PERMISSION_WORDS, ROLE_BUNDLES, SYSTEM_ROLES,
  type Permission,
} from '@oto/shared';
import { hasPermission, type EffectivePermission } from '../src/services/permissions';

/**
 * SCRUM-630 house review. These pins run the real bundles and scope resolver;
 * salary access is a permission, not an app role or a payroll write right.
 * A reproduced regression receives a severity and prescribed fix before landing.
 */
const salary: Permission = 'hr:salary:view';
const own = 'zz-test-salary-own', foreign = 'zz-test-salary-foreign';
const target = { operatorId: own, operatorOnly: true as const };
const grants = (roleName: (typeof SYSTEM_ROLES)[number], scopeType: EffectivePermission['scopeType'] = 'operator', scopeId: string | null = own): EffectivePermission[] =>
  ROLE_BUNDLES[roleName].map(permission => ({ permission, roleName, scopeType, scopeId }));

describe('SCRUM-630 salary permission adversarial review', () => {
  it('[high] declares one readable salary grant with a plain view-only description', () => {
    expect(PERMISSIONS.filter(permission => permission === salary)).toHaveLength(1);
    expect(PERMISSION_WORDS[salary]).toMatch(/view.*salary.*pay details.*OTO App/i);
    expect(PERMISSION_WORDS[salary]).not.toMatch(/edit|approve|confirm|lock/i);
  });

  it('[high] administrators receive salary access while every lower and Inbox bundle stays without it', () => {
    for (const name of SYSTEM_ROLES) {
      expect(hasPermission(grants(name), salary, target), name).toBe(name === 'platform_admin' || name === 'operator_admin');
    }
    for (const [name, permissions] of Object.entries(INBOX_ROLE_BUNDLES)) {
      expect(permissions, name).not.toContain(salary);
    }
  });

  it('[high] an operator grant does not cover another park group', () => {
    expect(hasPermission(grants('operator_admin'), salary, target)).toBe(true);
    expect(hasPermission(grants('operator_admin'), salary, { operatorId: foreign, operatorOnly: true })).toBe(false);
    expect(hasPermission(grants('platform_admin', 'operator', null), salary, target)).toBe(true);
  });

  it('[high] branch, department and record assignments cannot cover an operator-wide salary target', () => {
    for (const scope of ['branch', 'department', 'record'] as const) {
      expect(hasPermission(grants('operator_admin', scope), salary,
        { ...target, branchId: own, departmentId: own, recordId: own }), scope).toBe(false);
    }
  });

  it('[high] an administrator role name cannot substitute for the actual permission', () => {
    const noSalary: EffectivePermission[] = [{ permission: 'admin:account:read', roleName: 'operator_admin', scopeType: 'operator', scopeId: own }];
    expect(hasPermission(noSalary, salary, target)).toBe(false);
    const salaryOnly: EffectivePermission[] = [{ permission: salary, roleName: 'ZZ TEST salary reader', scopeType: 'operator', scopeId: own }];
    expect(hasPermission(salaryOnly, salary, target)).toBe(true);
    expect(hasPermission(salaryOnly, 'admin:account:update', target)).toBe(false);
  });
});
