import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_WORDS, ROLE_BUNDLES } from '../src/permissions';

/**
 * SCRUM-644 (planner ruling Q25): the audited export and the alert routing /
 * fingerprint mute controls are additive permissions. Administrators inherit
 * them through their ALL bundles; no counter or branch bundle gains them, and
 * the existing read doors (`admin:audit:read`, `admin:health:read`) are not
 * replaced or moved.
 */
const ADDED = ['console:activity:export', 'console:alert:manage'] as const;

describe('SCRUM-644 export and alert-management permissions', () => {
  it('declares each new permission exactly once', () => {
    for (const permission of ADDED) {
      expect((PERMISSIONS as readonly string[]).filter((p) => p === permission), permission).toEqual([permission]);
    }
  });

  it('gives them to both administrator bundles and to no branch, counter or staff bundle', () => {
    for (const permission of ADDED) {
      expect(ROLE_BUNDLES.platform_admin, permission).toContain(permission);
      expect(ROLE_BUNDLES.operator_admin, permission).toContain(permission);
      for (const role of ['branch_manager', 'reception', 'staff'] as const) {
        expect(ROLE_BUNDLES[role], `${role} ${permission}`).not.toContain(permission);
      }
    }
  });

  it('leaves the existing read doors where they were', () => {
    expect(ROLE_BUNDLES.branch_manager).toContain('admin:audit:read');
    expect(ROLE_BUNDLES.branch_manager).toContain('admin:health:read');
    expect(PERMISSIONS).toContain('admin:audit:read_sensitive');
    expect(PERMISSIONS).toContain('admin:ops:manage');
  });

  it('explains each in one plain sentence that names console-only delivery for alerts', () => {
    const words = PERMISSION_WORDS as Readonly<Record<string, string>>;
    expect(words['console:activity:export']).toMatch(/^Download /);
    expect(words['console:activity:export']).toMatch(/recorded/);
    expect(words['console:alert:manage']).toMatch(/mute/i);
    expect(words['console:alert:manage']).toMatch(/console/i);
    for (const permission of ADDED) {
      const sentence = words[permission] ?? '';
      expect(sentence).toMatch(/^[A-Z][^\n]+\.$/);
      expect((sentence.match(/[.!?](?=\s|$)/g) ?? []).length, permission).toBe(1);
    }
  });
});
