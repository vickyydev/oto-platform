import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@oto/db';
import type { AuthContext } from '../src/plugins/session';
import type { SummaryBranch } from '../src/services/analytics-summary';
import type { HandoffConfig } from '../src/services/handoff';
import type { EffectivePermission } from '../src/services/permissions';

const seams = vi.hoisted(() => ({ branches: vi.fn(), department: vi.fn() }));
vi.mock('../src/services/analytics-summary', () => ({ operatorBranches: seams.branches }));
vi.mock('../src/services/access-control', async original => ({
  ...await original<typeof import('../src/services/access-control')>(),
  holdsAtOwnDepartment: seams.department,
}));

const core = randomUUID();
const otherCore = randomUUID();
const appBranch = randomUUID();
const tenant = randomUUID();
const accountId = randomUUID();
const db = {} as Db;
const now = new Date('2026-10-24T18:30:00.000Z');
const auth: AuthContext = {
  accountId, operatorId: randomUUID(), sessionId: randomUUID(), branchId: core,
  stationId: null, status: 'active', mustChangePassword: false, isPlatformAdmin: false, lockedAt: null,
};
const handoff: HandoffConfig = { keys: [], origins: new Map([['oto_app', 'https://oto.example.test']]), ttlSeconds: 60 };
const effective: EffectivePermission[] = ['admin:account:read', 'app:oto_app:access'].map(permission => ({
  permission: permission as EffectivePermission['permission'], scopeType: 'branch', scopeId: core, roleName: 'ZZ TEST summary',
}));
const park = (id = core, name = 'ZZ TEST Alpha', timezone = 'Asia/Bangkok'): SummaryBranch => ({
  id, name, timezone, businessDayStart: '06:00:00', archivedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'),
});
const upstreamUser = () => ({ id: 'ZZ TEST app-user', platformUserId: accountId, tenantId: tenant, role: 'manager' });
const upstreamBranches = () => [{ id: appBranch, tenantId: tenant, coreBranchId: core }];
const hidden = randomBytes(20).toString('hex');
function sessionFixture(answer?: (path: string) => { status: number; body: unknown } | undefined) {
  const get = vi.fn(async (path: string) => {
    const custom = answer?.(path);
    if (custom) return custom;
    if (path === '/api/user') return { status: 200, body: { ...upstreamUser(), email: hidden } };
    if (path === '/api/branches') return { status: 200, body: upstreamBranches() };
    if (path.startsWith('/api/timekeeping/live?')) return { status: 200, body: { currentlyWorkingCount: 2, timestamp: now.toISOString(), workingNow: [{ name: hidden }] } };
    if (path.startsWith('/api/timekeeping/review?')) return { status: 200, body: { date: '2026-10-25', issuesCount: 3, summaries: [{ salary: hidden }] } };
    if (path.startsWith('/api/time-off?')) return { status: 200, body: [{ id: 'ZZ TEST leave', tenantId: tenant, branchId: appBranch, note: hidden }] };
    if (path === '/api/payroll/month-status') return { status: 200, body: {
      month: '2026-10', entities: [{ id: randomUUID(), name: 'ZZ TEST Payer', version: 2, status: 'gm-confirmed', bankAccount: hidden }], salary: hidden,
    } };
    throw new Error('Unexpected synthetic app read');
  });
  const close = vi.fn(async () => true);
  const open = vi.fn(async () => ({ get, close }));
  return { get, close, open };
}

async function summary(fixture = sessionFixture(), overrides: Record<string, unknown> = {}) {
  const modulePath = '../src/services/' + 'console-staff.ts';
  const { staffSummaryOf } = await import(/* @vite-ignore */ modulePath) as typeof import('../src/services/console-staff');
  return staffSummaryOf(db, {
    auth, effective, ctx: {}, handoff, token: '', requestId: 'ZZ-TEST-634', timeoutMs: 250,
    now, open: fixture.open, ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.branches.mockResolvedValue([park()]);
  seams.department.mockResolvedValue(false);
});

describe('SCRUM-634 acting-user Staff summary projection', () => {
  it('uses calendar date at the selected park, exact native reads and strips every upstream detail', async () => {
    const f = sessionFixture();
    const result = await summary(f);
    expect(result.source).toBe('ready');
    expect(result.selectedBranchId).toBe(core);
    expect(result.date).toBe('2026-10-25'); // Before the park 06:00 business cutoff, still calendar today.
    expect(result.working).toEqual({ status: 'ready', count: 2, asOf: now.toISOString() });
    expect(result.attendance).toEqual({ status: 'ready', count: 3, asOf: now.toISOString() });
    expect(result.leave).toEqual({ status: 'ready', count: 1, asOf: now.toISOString() });
    expect(result.payroll).toMatchObject({ status: 'ready', month: '2026-10', entities: [{ name: 'ZZ TEST Payer', status: 'gm-confirmed', version: 2 }] });
    expect(f.get.mock.calls.map(c => c[0]).sort()).toEqual([
      '/api/user', '/api/branches', `/api/timekeeping/live?branchId=${appBranch}`,
      `/api/timekeeping/review?date=2026-10-25&branchId=${appBranch}`,
      `/api/time-off?branchId=${appBranch}&dateFrom=2026-10-25&dateTo=2026-10-25`, '/api/payroll/month-status',
    ].sort());
    expect(JSON.stringify(result).includes(hidden)).toBe(false);
    expect(Object.keys(result.payroll.entities[0]!).sort()).toEqual(['id', 'name', 'status', 'version']);
    expect(f.open.mock.calls).toHaveLength(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('preserves legitimate zero counts and an empty leave list', async () => {
    const f = sessionFixture(path => path.startsWith('/api/timekeeping/live?')
      ? { status: 200, body: { currentlyWorkingCount: 0, timestamp: now.toISOString() } }
      : path.startsWith('/api/timekeeping/review?') ? { status: 200, body: { date: '2026-10-25', issuesCount: 0 } }
        : path.startsWith('/api/time-off?') ? { status: 200, body: [] } : undefined);
    const result = await summary(f);
    expect([result.working.count, result.attendance.count, result.leave.count]).toEqual([0, 0, 0]);
  });

  it('does not infer salary authority from the effective role or widen payroll to a branch filter', async () => {
    const f = sessionFixture(path => path === '/api/payroll/month-status' ? { status: 403, body: { message: hidden } } : undefined);
    const result = await summary(f);
    expect(result.payroll).toEqual({ status: 'forbidden', month: null, entities: [] });
    expect(result.working.status).toBe('ready');
    expect(f.get.mock.calls.some(c => c[0] === '/api/payroll/month-status')).toBe(true);
    expect(JSON.stringify(result).includes(hidden)).toBe(false);
  });

  it.each(['working', 'attendance', 'leave'] as const)('keeps a denied %s card distinct from zero', async metric => {
    const prefix = { working: '/api/timekeeping/live?', attendance: '/api/timekeeping/review?', leave: '/api/time-off?' }[metric];
    const f = sessionFixture(path => path.startsWith(prefix) ? { status: 403, body: { message: hidden } } : undefined);
    expect((await summary(f))[metric]).toEqual({ status: 'forbidden', count: null, asOf: null });
  });

  it('withholds malformed counts, mismatched attendance date and foreign leave records without guessing', async () => {
    const f = sessionFixture(path => path.startsWith('/api/timekeeping/live?')
      ? { status: 200, body: { currentlyWorkingCount: -1, timestamp: now.toISOString() } }
      : path.startsWith('/api/timekeeping/review?') ? { status: 200, body: { date: '2026-10-24', issuesCount: 3 } }
        : path.startsWith('/api/time-off?') ? { status: 200, body: [{ id: 'ZZ TEST foreign leave', tenantId: randomUUID(), branchId: appBranch }] } : undefined);
    const result = await summary(f);
    for (const key of ['working', 'attendance', 'leave'] as const) expect(result[key]).toEqual({ status: 'unavailable', count: null, asOf: null });
  });

  it.each([
    { month: '2026-13', entities: [] },
    { month: '2026-10', entities: [{ id: randomUUID(), name: 'ZZ TEST Payer', version: 1, status: 'invented' }] },
    { month: '2026-10', entities: [{ id: randomUUID(), name: 'ZZ TEST Payer', version: 2, status: 'not-started' }] },
  ])('does not project malformed payroll state %#', async body => {
    const f = sessionFixture(path => path === '/api/payroll/month-status' ? { status: 200, body } : undefined);
    expect((await summary(f)).payroll).toEqual({ status: 'unavailable', month: null, entities: [] });
  });

  it.each(['admin:account:read', 'app:oto_app:access'])('requires %s before opening any app session', async missing => {
    const f = sessionFixture();
    await expect(summary(f, { effective: effective.filter(g => g.permission !== missing) })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('does not combine separate branch grants; empty intersections open no app session', async () => {
    seams.branches.mockResolvedValue([park(), park(otherCore, 'ZZ TEST Beta')]);
    const f = sessionFixture();
    const grants = [effective[0]!, { ...effective[1]!, scopeId: otherCore }];
    await expect(summary(f, { effective: grants, branchId: core })).rejects.toMatchObject({ statusCode: 403 });
    const empty = await summary(f, { effective: grants });
    expect(empty.selectedBranchId).toBeNull();
    expect(empty.date).toBeNull();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('allows an own-department app grant only within the account-read branch reach', async () => {
    seams.department.mockResolvedValue(true);
    seams.branches.mockResolvedValue([park(), park(otherCore, 'ZZ TEST Beta')]);
    const f = sessionFixture();
    const result = await summary(f, { effective: [effective[0]!] });
    expect(result.branches.map(b => b.id)).toEqual([core]);
    await expect(summary(f, { effective: [effective[0]!], branchId: otherCore })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('shares404 for foreign, absent and archived parks but403 for an own unreachable park', async () => {
    const archived = randomUUID();
    seams.branches.mockResolvedValue([park(), park(otherCore), { ...park(archived), archivedAt: now }]);
    for (const id of [randomUUID(), archived]) await expect(summary(sessionFixture(), { branchId: id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(summary(sessionFixture(), { branchId: otherCore })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('selects the reachable seat or first sorted reachable branch explicitly', async () => {
    seams.branches.mockResolvedValue([park(otherCore, 'ZZ TEST Beta'), park()]);
    const both = effective.map(g => ({ ...g, scopeType: 'operator' as const, scopeId: auth.operatorId }));
    expect((await summary(sessionFixture(), { effective: both })).selectedBranchId).toBe(core);
    expect((await summary(sessionFixture(), { effective: both, auth: { ...auth, branchId: randomUUID() } })).selectedBranchId).toBe(core);
  });

  it('does not open when no live owned branches remain, or when handoff is unconfigured', async () => {
    const f = sessionFixture();
    expect((await summary(f, { handoff: undefined })).source).toBe('not-configured');
    expect(f.open).not.toHaveBeenCalled();
    seams.branches.mockResolvedValue([]);
    expect((await summary(f)).selectedBranchId).toBeNull();
    expect(f.open).not.toHaveBeenCalled();
  });

  it.each(['missing', 'duplicate', 'foreign-tenant', 'invalid-id'])('refuses %s app branch mappings without headline reads', async kind => {
    const mapped = upstreamBranches()[0]!;
    const rows = kind === 'missing' ? [] : kind === 'duplicate' ? [mapped, { ...mapped, id: randomUUID() }]
      : kind === 'foreign-tenant' ? [{ ...mapped, tenantId: randomUUID() }] : [{ ...mapped, id: 'opaque-invalid-target' }];
    const f = sessionFixture(path => path === '/api/branches' ? { status: 200, body: rows } : undefined);
    expect((await summary(f)).source).toBe('unmapped-branch');
    expect(f.get.mock.calls.every(c => c[0] === '/api/user' || c[0] === '/api/branches')).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('does not accept a foreign platform stamp even from an injected session factory', async () => {
    const f = sessionFixture(path => path === '/api/user' ? { status: 200, body: { ...upstreamUser(), platformUserId: randomUUID() } } : undefined);
    expect((await summary(f)).source).toBe('unavailable');
    expect(f.get.mock.calls.every(c => c[0] === '/api/user' || c[0] === '/api/branches')).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('records not-provisioned without exposing upstream failure details', async () => {
    const f = sessionFixture();
    f.open.mockRejectedValueOnce(Object.assign(new Error(hidden), { code: 'OTO_APP_NOT_PROVISIONED', status: 403 }));
    const result = await summary(f);
    expect(result.source).toBe('not-provisioned');
    expect(JSON.stringify(result).includes(hidden)).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
  });

  it.each([false, true])('clears every headline when app-session cleanup is unconfirmed, throwing=%s', async throws => {
    const f = sessionFixture();
    if (throws) f.close.mockRejectedValueOnce(new Error(hidden));
    else f.close.mockResolvedValueOnce(false);
    const result = await summary(f);
    expect(result.source).toBe('unavailable');
    for (const key of ['working', 'attendance', 'leave'] as const) expect(result[key]).toEqual({ status: 'unavailable', count: null, asOf: null });
    expect(result.payroll).toEqual({ status: 'unavailable', month: null, entities: [] });
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
