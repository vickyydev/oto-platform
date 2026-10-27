import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_WORDS, ROLE_BUNDLES } from '../src/permissions';

const permission = 'platform:operator:switch';
const sentence = 'Select the park group this session reads and changes while keeping the signed-in account unchanged.';

describe('SCRUM-640 session operator selection permission', () => {
  it('declares the new permission exactly once in the public vocabulary', () => {
    expect((PERMISSIONS as readonly string[]).filter(entry => entry === permission)).toEqual([permission]);
  });

  it('retains selection in both administrator bundles without treating membership as platform-wide authority', () => {
    for (const role of ['platform_admin', 'operator_admin'] as const) {
      expect(ROLE_BUNDLES[role], role).toContain(permission);
    }
    expect([...ROLE_BUNDLES.platform_admin].sort()).toEqual([...PERMISSIONS].sort());
    // SCRUM-643 reserves only these new suite writers for the platform administrator,
    // and SCRUM-648 adds viewing as another account.
    const platformOnly = new Set<string>([
      'console:app_registry:manage', 'console:release:flag_manage', 'console:release:kill_switch',
      'console:support:impersonate',
    ]);
    expect([...ROLE_BUNDLES.operator_admin].sort()).toEqual(PERMISSIONS.filter(entry => !platformOnly.has(entry)).sort());
    // The session route must separately require a genuine null-scope assignment.
    // This vocabulary test grants no scope and makes no route-authority claim.
  });

  it('does not add operator selection to branch manager, reception or staff bundles', () => {
    for (const role of ['branch_manager', 'reception', 'staff'] as const) {
      expect(ROLE_BUNDLES[role], role).not.toContain(permission);
    }
  });

  it('explains the session context and unchanged account in exactly one plain sentence', () => {
    const words = (PERMISSION_WORDS as Readonly<Record<string, string>>)[permission];
    expect(words).toBe(sentence);
    expect(words).toMatch(/^[A-Z][^\n]+\.$/);
    expect(words).not.toMatch(/[:_]/);
    expect(words).not.toContain(permission);
    expect((words ?? '').match(/[.!?](?=\s|$)/g)).toHaveLength(1);
    expect((words ?? '').trim()).toBe(words);
  });
});
