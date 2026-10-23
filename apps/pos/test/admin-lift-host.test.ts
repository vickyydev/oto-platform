import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adminTargetFromSearch, ADMIN_PANEL_TARGETS } from '@/api/admin-entry';

vi.mock('@/api/client', () => ({ api: { post: vi.fn() }, idemKey: vi.fn() }));

describe('the POS compatibility address host', () => {
  it('has one fixed native Admin destination for all 27 previous panel identities', () => {
    expect(Object.keys(ADMIN_PANEL_TARGETS)).toHaveLength(27);
    for (const [panel, target] of Object.entries(ADMIN_PANEL_TARGETS)) {
      expect(adminTargetFromSearch(`?panel=${encodeURIComponent(panel)}`)).toBe(target);
    }
    expect(ADMIN_PANEL_TARGETS.inventory).toBe('/catalogue/inventory');
    expect(ADMIN_PANEL_TARGETS.members).toBe('/catalogue/members');
    expect(ADMIN_PANEL_TARGETS['tier-verifications']).toBe('/catalogue/tier-verifications');
    expect(ADMIN_PANEL_TARGETS.wallets).toBe('/reports/wallets');
    expect(ADMIN_PANEL_TARGETS.devices).toBe('/devices');
  });

  it('uses a fixed default and carries only an existing template-kind query', () => {
    for (const search of ['', '?panel=unknown', '?panel=__proto__', '?panel=constructor', '?panel=https%3A%2F%2Fevil.invalid&to=%2Fplatform']) {
      expect(adminTargetFromSearch(search)).toBe('/overview');
    }
    expect(adminTargetFromSearch('?panel=templates&template=receipt&next=https://evil.invalid&branchId=foreign')).toBe('/catalogue/print-templates?template=receipt');
    expect(adminTargetFromSearch('?panel=templates&template=not-a-kind')).toBe('/catalogue/print-templates');
    expect(adminTargetFromSearch('?panel=menu&template=receipt')).toBe('/catalogue/menu');
    expect(adminTargetFromSearch('?panel=tax&panel=templates&template=receipt')).toBe('/catalogue/tax');
  });

  it('keeps the Admin route outside the station gate and preserves all three Station Setup addresses', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<Route path="/admin" component={Admin} />');
    expect(app.indexOf('<Route path="/admin"')).toBeLessThan(app.indexOf('<AuthGate />'));
    for (const path of ['/station-setup', '/station-setup/new', '/station-setup/settings']) expect(app).toContain(`<Route path="${path}" component={StationSetup} />`);
    expect(app).not.toContain('components/admin/');
  });
});
