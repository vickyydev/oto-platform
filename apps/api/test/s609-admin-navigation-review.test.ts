import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_BUNDLES } from '@oto/shared/permissions';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

/** SCRUM-609 house review. Prescribed fixes are applied; each former finding is a passing pin. */
describe('SCRUM-609 navigation review', () => {
  it('FINDING R1 medium: a launcher label must retain its app identity and gate; rename only the offered name', () => {
    const apps = source('../../launcher/src/suite/apps.ts');
    const consoleTile = apps.slice(apps.indexOf("key: 'console'"), apps.indexOf("key: 'oto_app'"));
    expect(consoleTile).toContain("name: 'Admin'");
    expect(consoleTile).toContain("permission: 'app:console:access'");
    expect(consoleTile).toContain('env.VITE_CONSOLE_URL');
  });

  it('FINDING R2 high: a new home gate must not lock managers out; converge the permission through existing bundles', () => {
    expect(PERMISSIONS).toContain('console:overview:read');
    for (const role of ['branch_manager', 'operator_admin', 'platform_admin'] as const) {
      expect(ROLE_BUNDLES[role]).toContain('console:overview:read');
    }
    expect(ROLE_BUNDLES.reception).not.toContain('console:overview:read');
  });

  it('FINDING R3 high: hidden menu groups must not strengthen old page guards; route aliases use Section and its page permission', () => {
    const app = source('../../console/src/App.tsx');
    expect(app).toContain('new Set([page.path, `/${page.id}`])');
    expect(app).toContain('<Section id={page.id}>{pageElements[page.id] ?? <NotFound />}</Section>');
    const section = app.slice(app.indexOf('function Section('), app.indexOf('function NotFound('));
    expect(section).toContain('has(section.permission)');
    expect(section).not.toContain('canSeeArea');
  });
});
