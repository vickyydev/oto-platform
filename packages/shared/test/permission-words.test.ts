import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_WORDS, ROLE_BUNDLES, SYSTEM_ROLES, type Permission } from '../src/permissions';

describe('plain permission sentences (SCRUM-612)', () => {
  it('gives analytics and configuration reads to administrators without adding branch-manager authority', () => {
    for (const key of ['console:analytics:read', 'console:config:read']) {
      expect(PERMISSIONS).toContain(key);
      expect(ROLE_BUNDLES.platform_admin).toContain(key);
      expect(ROLE_BUNDLES.operator_admin).toContain(key);
      expect(ROLE_BUNDLES.branch_manager).not.toContain(key);
      const words = PERMISSION_WORDS as Record<string, string>;
      expect(words[key]).toMatch(/^Read /);
      expect(words[key]).not.toMatch(/change|rerun|unfreeze|edit/i);
    }
  });

  it('gives the analytics source switch and re-run to administrators only, with honest words (SCRUM-646 Q27)', () => {
    for (const key of ['console:analytics:manage_source', 'console:analytics:rerun']) {
      expect(PERMISSIONS).toContain(key);
      expect(ROLE_BUNDLES.platform_admin).toContain(key);
      expect(ROLE_BUNDLES.operator_admin).toContain(key);
      expect(ROLE_BUNDLES.branch_manager).not.toContain(key);
    }
    const words = PERMISSION_WORDS as Record<string, string>;
    expect(words['console:analytics:manage_source']).toMatch(/preview/);
    expect(words['console:analytics:rerun']).toMatch(/our own records/);
    expect(words['console:analytics:rerun']).toMatch(/never be rebuilt/);
    expect(Object.values(words).join(' ')).not.toMatch(/unfreeze/i);
  });

  it('gives Money oversight to administrators only, read-only and recorded (SCRUM-647)', () => {
    for (const key of ['console:money:read', 'console:money:investigate'] as const) {
      expect(PERMISSIONS).toContain(key);
      expect(ROLE_BUNDLES.platform_admin).toContain(key);
      expect(ROLE_BUNDLES.operator_admin).toContain(key);
      for (const role of ['branch_manager', 'reception', 'staff'] as const) {
        expect(ROLE_BUNDLES[role], `${role} ${key}`).not.toContain(key);
      }
      expect(PERMISSION_WORDS[key]).toMatch(/^(Read|Also read) /);
      expect(PERMISSION_WORDS[key]).toMatch(/every read recorded/);
      expect(PERMISSION_WORDS[key]).not.toMatch(/\b(change|edit|move|refund|void|settle|import)\b/i);
    }
    expect(PERMISSION_WORDS['console:money:investigate']).toMatch(/integrity checks/);
  });

  it('covers exactly the declared vocabulary through the public permissions module', () => {
    expect(Object.keys(PERMISSION_WORDS).sort()).toEqual([...PERMISSIONS].sort());
    for (const permission of PERMISSIONS) {
      const sentence: string = PERMISSION_WORDS[permission];
      expect(sentence, permission).toMatch(/^[A-Z][^\n]+\.$/);
      expect(sentence.trim(), permission).toBe(sentence);
      expect(sentence.split(/\s+/).length, permission).toBeGreaterThanOrEqual(4);
      expect(sentence, permission).not.toMatch(/[:_]/);
      expect(sentence, permission).not.toContain(permission);
    }
  });

  it('distinguishes a single member lookup from browsing the customer register', () => {
    expect(PERMISSION_WORDS['pos:member:read']).toMatch(/one member/i);
    expect(PERMISSION_WORDS['pos:member:list']).toMatch(/register.*phone numbers/i);
    expect(PERMISSION_WORDS['pos:booking:read']).toMatch(/families.*online booking/i);
    expect(PERMISSION_WORDS['pos:booking:redeem']).toMatch(/claim.*paid online booking/i);
  });

  it('keeps app entry, booth staffing and whole-operator recognition distinct from action grants', () => {
    const appEntries = PERMISSIONS.filter((permission) => permission.startsWith('app:'));
    for (const permission of appEntries) {
      expect(PERMISSION_WORDS[permission]).toMatch(/^Open .+actions.*own permissions/);
    }
    expect(PERMISSION_WORDS['booth:staff:sign_in']).toMatch(/also assigned as staff/);
    expect(PERMISSION_WORDS['admin:operator:all']).toMatch(/whole operator.*without adding other permissions/);
    expect(PERMISSION_WORDS['assistant:ask:use']).toMatch(/existing access allows/);
  });

  it('describes the menu workbook import without promising merchandise import', () => {
    expect(PERMISSION_WORDS['catalog:menu:import']).toMatch(/menu.*spreadsheet/i);
    expect(PERMISSION_WORDS['catalog:menu:import']).not.toMatch(/merchandise/i);
  });

  it('describes salary visibility without promising pay editing or payroll approval', () => {
    const sentence = PERMISSION_WORDS['hr:salary:view'];
    expect(sentence).toMatch(/view.*salary.*pay details.*OTO App/i);
    expect(sentence).toMatch(/platform access is enabled/i);
    expect(sentence).not.toMatch(/edit|approve|confirm|lock/i);
  });

  it('explains the sensitive, approval and payment distinctions in park terms', () => {
    const examples: [Permission, RegExp][] = [
      ['admin:audit:read_sensitive', /unmasked.*child health notes.*phone numbers/i],
      ['pos:payment:confirm', /unresolved.*terminal or gateway/i],
      ['pos:refund:approve', /refunds.*voids after payment/i],
      ['pos:cash:approve', /countersign.*paid-out.*safe drop.*variance/i],
      ['pos:cash:session_close', /close.*drawer session/i],
      ['pos:cash:day_close', /close.*trading day/i],
      ['pos:party:charge', /party.*tab/],
      ['pos:party:payment', /payment.*party.*balance/],
      ['pos:stock:receive', /deliveries.*stock/],
      ['pos:stock:order', /purchase orders/],
    ];
    for (const [permission, meaning] of examples) {
      expect(PERMISSION_WORDS[permission], permission).toMatch(meaning);
    }
  });
});

describe('suite controls permission boundaries (SCRUM-643)', () => {
  const entries = [
    ['console:app_registry:read', /read.*app.*directory.*maintenance/i],
    ['console:app_registry:manage', /manage.*app.*maintenance/i],
    ['console:release:read', /read.*versions.*deployment.*flags.*kill switches/i],
    ['console:release:flag_manage', /change.*scoped feature flags/i],
    ['console:release:kill_switch', /emergency.*expiry.*reason.*confirmation/i],
  ] as const;
  // SCRUM-648 adds impersonation to the platform-only set.
  const writes = new Set<string>([
    'console:app_registry:manage', 'console:release:flag_manage', 'console:release:kill_switch',
    'console:support:impersonate',
  ]);

  it.each(entries)('declares %s exactly once with a distinct plain meaning', (permission, meaning) => {
    expect((PERMISSIONS as readonly string[]).filter(entry => entry === permission)).toEqual([permission]);
    expect((PERMISSION_WORDS as Readonly<Record<string, string>>)[permission]).toMatch(meaning);
  });

  it('gives the platform administrator all five controls without losing existing permissions', () => {
    expect(ROLE_BUNDLES.platform_admin).toEqual(expect.arrayContaining(entries.map(([permission]) => permission)));
    expect([...ROLE_BUNDLES.platform_admin].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('gives operator administrators both reads while excluding exactly the platform-only writes', () => {
    expect(ROLE_BUNDLES.operator_admin).toEqual(expect.arrayContaining([
      'console:app_registry:read', 'console:release:read',
    ]));
    expect([...ROLE_BUNDLES.operator_admin].sort()).toEqual(PERMISSIONS.filter(permission => !writes.has(permission)).sort());
    expect(ROLE_BUNDLES.platform_admin.filter(permission => !ROLE_BUNDLES.operator_admin.includes(permission)).sort())
      .toEqual([...writes].sort());
  });

  it('adds no suite control to branch manager, reception or staff bundles', () => {
    const suiteControls = new Set<string>(entries.map(([permission]) => permission));
    for (const role of ['branch_manager', 'reception', 'staff'] as const) {
      expect(ROLE_BUNDLES[role].filter(permission => suiteControls.has(permission)), role).toEqual([]);
    }
  });
});

describe('support tools permission boundaries (SCRUM-648)', () => {
  it('declares lookup, trace and impersonate once each with plain words', () => {
    for (const [permission, meaning] of [
      ['console:support:lookup', /search.*recorded/i],
      ['console:support:trace', /follow.*sale.*gaps.*recorded/i],
      ['console:support:impersonate', /view an app as.*window.*second administrator/i],
    ] as const) {
      expect((PERMISSIONS as readonly string[]).filter(entry => entry === permission)).toEqual([permission]);
      expect((PERMISSION_WORDS as Readonly<Record<string, string>>)[permission]).toMatch(meaning);
    }
  });

  it('seeds a support role with the Console door, its reads, lookup and trace, and never impersonation', () => {
    expect(SYSTEM_ROLES).toContain('support');
    expect([...ROLE_BUNDLES.support].sort()).toEqual(['app:console:access', 'assistant:ask:use', 'console:app_registry:read',
      'console:overview:read', 'console:release:read', 'console:support:lookup', 'console:support:trace']);
    expect(ROLE_BUNDLES.support).not.toContain('console:support:impersonate');
    // No app data of its own: every lookup section still answers through that app's permission.
    expect(ROLE_BUNDLES.support.filter(permission => !permission.startsWith('console:')
      && permission !== 'app:console:access' && permission !== 'assistant:ask:use')).toEqual([]);
  });

  it('gives impersonation to the platform administrator only, and the two reads to operator administrators', () => {
    expect(ROLE_BUNDLES.platform_admin).toContain('console:support:impersonate');
    expect(ROLE_BUNDLES.operator_admin).not.toContain('console:support:impersonate');
    expect(ROLE_BUNDLES.operator_admin).toEqual(expect.arrayContaining(['console:support:lookup', 'console:support:trace']));
    for (const role of ['branch_manager', 'reception', 'staff'] as const) {
      expect(ROLE_BUNDLES[role].filter(permission => permission.startsWith('console:support:')), role).toEqual([]);
    }
  });
});
