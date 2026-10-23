import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ post: vi.fn(), idemKey: vi.fn() }));
vi.mock('../../pos/src/api/client', () => ({ api: { post: client.post }, idemKey: client.idemKey }));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const helperPath = fileURLToPath(new URL('../../pos/src/api/admin-entry.ts', import.meta.url));
let loaded: Record<string, unknown>;
const target = (search: string) => {
  if (typeof loaded.adminTargetFromSearch !== 'function') throw new Error('Missing fixed legacy address resolver');
  return (loaded.adminTargetFromSearch as (value: string) => string)(search);
};
const destination = (search: string) => {
  if (typeof loaded.adminDestination !== 'function') throw new Error('Missing signed-in legacy destination');
  return (loaded.adminDestination as (value: string) => Promise<string>)(search);
};
const accounts = () => (loaded.adminAccountsDestination as () => Promise<string>)();
beforeAll(async () => { loaded = await import(helperPath) as Record<string, unknown>; });
beforeEach(() => {
  client.post.mockReset(); client.idemKey.mockReset(); let sequence = 0;
  client.idemKey.mockImplementation(() => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'));
});
const expected: Record<string, string> = {
  tickets: '/catalogue/tickets', addons: '/catalogue/add-ons', menu: '/catalogue/menu',
  categories: '/catalogue/categories', modifiers: '/catalogue/modifiers', merch: '/catalogue/merch',
  inventory: '/catalogue/inventory', pricing: '/catalogue/tiers', discounts: '/catalogue/discounts',
  'voucher-promotions': '/catalogue/voucher-campaigns', tax: '/catalogue/tax', supervision: '/catalogue/care',
  events: '/catalogue/event-pricing', templates: '/catalogue/print-templates', devices: '/devices',
  'staff-benefits': '/catalogue/staff-benefits', 'reports-sales': '/reports/sales',
  'reports-profitability': '/reports/profitability', 'reports-wallet': '/reports/wallet-promo',
  wallets: '/reports/wallets', 'reports-discounts': '/reports/discounts', 'reports-tax': '/reports/tax-vat',
  members: '/catalogue/members', 'tier-verifications': '/catalogue/tier-verifications',
  'login-users': '/people/accounts', operators: '/organisation/operators', branches: '/organisation/branches',
};
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(row => {
  const path = join(directory, row.name);
  return row.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(row.name) ? [path] : [];
});

describe('SCRUM-627 independent review of the POS admin retirement', () => {
  it('R1 [high] retains fixed Accounts sign-on compatibility; fix: preserve the earlier explicit entry', async () => {
    client.post.mockResolvedValue({ launchUrl: 'https://admin.example.test/base/?release=blue#handoff=fixture&issued=pos' });
    expect(await accounts()).toBe('https://admin.example.test/base/?release=blue#handoff=fixture&issued=pos&to=%2Fpeople%2Faccounts');
    expect(client.post).toHaveBeenCalledWith('/auth/handoff', { app: 'console' }, { idempotencyKey: expect.any(String) });
  });
  it('R2 [high] every old live panel keeps a native home; fix: use the approved complete whitelist', () => {
    expect(loaded.ADMIN_PANEL_TARGETS).toEqual(expected);
    for (const [panel, path] of Object.entries(expected)) expect(target('?panel=' + panel)).toBe(path);
  });
  it('R3 [high] untrusted address parts cannot choose a target; fix: fixed default and no query or fragment copying', () => {
    for (const search of ['', '?panel=unknown', '?panel=https://outside.example.test', '?panel=//outside.example.test',
      '?panel=%2Fdevices', '?to=%2Fdevices', '?next=https://outside.example.test', '?panel=__proto__', '?panel=constructor']) {
      expect(target(search)).toBe('/overview');
    }
    expect(target('?panel=tax&panel=members&to=%2Fdevices#anything')).toBe('/catalogue/tax');
    expect(target('?panel=templates&template=unknown&next=elsewhere')).toBe('/catalogue/print-templates');
  });
  it('R4 [high] mapped sign-on keeps the configured base and audience; fix: append only the fixed fragment target', async () => {
    client.post.mockResolvedValue({ launchUrl: 'https://admin.example.test/base/?release=blue#handoff=fixture&issued=pos' });
    expect(await destination('?panel=wallets&operator=other&branch=other')).toBe('https://admin.example.test/base/?release=blue#handoff=fixture&issued=pos&to=%2Freports%2Fwallets');
    expect(client.post.mock.calls).toEqual([['/auth/handoff', { app: 'console' }, { idempotencyKey: '00000000-0000-4000-8000-000000000001' }]]);
  });
  it('R5 [high] each retry gets a fresh issue without caching; fix: keep destination resolution local to the action', async () => {
    client.post.mockResolvedValue({ launchUrl: 'https://admin.example.test/#handoff=fixture' });
    await destination('?panel=members'); await destination('?panel=tax');
    expect(client.post.mock.calls.map(row => row[2])).toEqual([
      { idempotencyKey: '00000000-0000-4000-8000-000000000001' },
      { idempotencyKey: '00000000-0000-4000-8000-000000000002' },
    ]);
  });
  it('R6 [high] authorization and network refusals stay authoritative; fix: reject without fallback or another request', async () => {
    const failures = [Object.assign(new Error('Not authorized'), { status: 403 }), new Error('No platform response')];
    for (const error of failures) { client.post.mockRejectedValueOnce(error); await expect(destination('?panel=members')).rejects.toBe(error); }
    expect(client.post).toHaveBeenCalledTimes(2);
  });
  it('R7 [high] unsafe issued addresses never navigate; fix: reject malformed, credential and pretargeted answers privately', async () => {
    for (const launchUrl of ['javascript:alert(1)#handoff=fixture', '//admin.example.test/#handoff=fixture',
      'https://fixture-user@admin.example.test/#handoff=fixture', 'https://admin.example.test/#handoff=fixture&to=%2Fdevices']) {
      client.post.mockResolvedValueOnce({ launchUrl });
      const result = await destination('?panel=tax').then(() => null, (error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).not.toContain('fixture'); expect(String(result)).not.toContain(launchUrl);
    }
  });
  it('R8 [high] overlapping issue replies retain their own targets; fix: do not share pending destination state', async () => {
    let finishFirst!: (value: unknown) => void, finishSecond!: (value: unknown) => void;
    client.post.mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }));
    client.post.mockReturnValueOnce(new Promise(resolve => { finishSecond = resolve; }));
    const first = destination('?panel=members'), second = destination('?panel=wallets');
    void first.catch(() => undefined); void second.catch(() => undefined);
    finishSecond({ launchUrl: 'https://admin.example.test/#handoff=second-fixture' });
    expect(new URL(await second).hash).toContain('to=%2Freports%2Fwallets');
    finishFirst({ launchUrl: 'https://admin.example.test/#handoff=first-fixture' });
    expect(new URL(await first).hash).toContain('to=%2Fcatalogue%2Fmembers');
  });
  it('R12 [medium] preserves only the existing requested template kind; fix: carry the native query through the fixed destination', async () => {
    for (const kind of ['receipt', 'kids_wristband', 'adult_wristband', 'kitchen_ticket', 'bar_ticket', 'credit_voucher']) {
      expect(target('?panel=templates&template=' + kind + '&next=https://outside.example.test')).toBe('/catalogue/print-templates?template=' + kind);
    }
    expect(target('?panel=tax&template=receipt')).toBe('/catalogue/tax');
    client.post.mockResolvedValue({ launchUrl: 'https://admin.example.test/#handoff=fixture' });
    const answer = new URL(await destination('?panel=templates&template=receipt'));
    expect(new URLSearchParams(answer.hash.slice(1)).get('to')).toBe('/catalogue/print-templates?template=receipt');
  });
  it('R9 [high] Station Setup retains its three independent routes; fix: keep operational station selection outside retirement', () => {
    const source = readFileSync(join(root, 'apps/pos/src/App.tsx'), 'utf8');
    for (const path of ['/station-setup', '/station-setup/new', '/station-setup/settings']) expect(source).toContain('path="' + path + '"');
  });
  it('R10 [high] the POS package and sources no longer depend on admin-screens; fix: preserve operational calls locally before dropping the edge', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'apps/pos/package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(manifest.dependencies?.['@oto/admin-screens']).toBeUndefined();
    expect(manifest.devDependencies?.['@oto/admin-screens']).toBeUndefined();
    const edges = sources(join(root, 'apps/pos/src')).filter(path => /(?:from\s*|import\s*\(?\s*)['"]@oto\/admin-screens(?:['"/])/.test(readFileSync(path, 'utf8')));
    expect(edges).toEqual([]);
  });
  it('R11 [medium] the mock Devices editor and POS admin host are retired; fix: remove genuinely dead shells after native homes exist', () => {
    const directory = join(root, 'apps/pos/src/components/admin');
    expect(existsSync(directory) ? sources(directory) : []).toEqual([]);
    const app = readFileSync(join(root, 'apps/pos/src/App.tsx'), 'utf8');
    expect(app).not.toContain('AdminAccessGate');
  });
});
