import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_WORDS, ROLE_BUNDLES } from '../src/permissions';

/**
 * SCRUM-645 / planner ruling Q26 — the additive Integrations permissions.
 * `admin:health:read` stays the read door; these two only add the test
 * buttons and the owner-supplied credential expiry write.
 */
const added = {
  'console:integration:test': 'Run the harmless integration test checks, where this deployment allows test controls.',
  'console:integration:manage': 'Record when an integration credential expires, so it is flagged 30 and 7 days before.',
} as const;

describe('SCRUM-645 integration permissions', () => {
  it('declares each new permission exactly once', () => {
    for (const permission of Object.keys(added)) {
      expect((PERMISSIONS as readonly string[]).filter((entry) => entry === permission), permission).toEqual([permission]);
    }
  });

  it('the two administrator bundles carry them through ALL, and nothing narrower does', () => {
    for (const role of ['platform_admin', 'operator_admin'] as const) {
      for (const permission of Object.keys(added)) expect(ROLE_BUNDLES[role], `${role} ${permission}`).toContain(permission);
    }
    for (const role of ['branch_manager', 'reception', 'staff'] as const) {
      for (const permission of Object.keys(added)) expect(ROLE_BUNDLES[role], `${role} ${permission}`).not.toContain(permission);
    }
  });

  it('keeps the existing read and ops doors unchanged', () => {
    expect(PERMISSIONS).toContain('admin:health:read');
    expect(PERMISSIONS).toContain('admin:ops:manage');
    expect(ROLE_BUNDLES.branch_manager).toContain('admin:health:read');
  });

  it('explains each in one plain sentence', () => {
    for (const [permission, sentence] of Object.entries(added)) {
      const words = (PERMISSION_WORDS as Readonly<Record<string, string>>)[permission];
      expect(words, permission).toBe(sentence);
      expect(words).toMatch(/^[A-Z][^\n]+\.$/);
      expect(words).not.toMatch(/[:_]/);
      expect((words ?? '').match(/[.!?](?=\s|$)/g)).toHaveLength(1);
    }
  });
});
