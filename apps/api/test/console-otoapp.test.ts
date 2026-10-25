import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@oto/db';
import type { AuthContext } from '../src/plugins/session';
import type { HandoffConfig } from '../src/services/handoff';
import type { EffectivePermission } from '../src/services/permissions';

const seams = vi.hoisted(() => ({ mint: vi.fn(), department: vi.fn() }));
vi.mock('../src/services/handoff', () => ({
  appAccessPermission: () => 'app:oto_app:access',
  issueHandoffAudited: seams.mint,
}));
vi.mock('../src/services/access-control', () => ({ holdsAtOwnDepartment: seams.department }));

const origin = 'https://oto.example.test';
const accountId = randomUUID();
const branchId = randomUUID();
const appBranchId = randomUUID();
const auth: AuthContext = {
  accountId, operatorId: randomUUID(), sessionId: randomUUID(), branchId,
  stationId: null, status: 'active', mustChangePassword: false, isPlatformAdmin: false, lockedAt: null,
};
const db = {} as Db;
const handoff: HandoffConfig = { keys: [], origins: new Map([['oto_app', origin]]), ttlSeconds: 60 };
const token = randomBytes(24).toString('hex');
const handoffToken = randomBytes(24).toString('hex');
const appCookie = `connect.sid=${randomBytes(24).toString('hex')}`;
const effective: EffectivePermission[] = [{
  permission: 'app:oto_app:access', scopeType: 'branch', scopeId: branchId, roleName: 'ZZ TEST reader',
}];
const identity = () => ({
  id: 'ZZ TEST app-user', platformUserId: accountId, tenantId: randomUUID(), role: 'manager',
  hasAllBranchesAccess: false, allowedBranchIds: [appBranchId],
  platformRoleMapping: { role: 'manager', permissions: { 'hr:salary:view': true } },
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call { path: string; url: URL; init: RequestInit }
function wire(answer?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { path: `${url.pathname}${url.search}`, url, init: init ?? {} };
    calls.push(call);
    const custom = await answer?.(call);
    if (custom) return custom;
    if (call.path === '/api/auth/handoff') return json({ ok: true }, 200, { 'set-cookie': `${appCookie}; HttpOnly; SameSite=Lax; Path=/` });
    if (call.path === '/api/user') return json(identity());
    if (call.path === '/api/logout') return json({ ok: true });
    if (call.path === '/api/branches') return json([{ id: appBranchId, coreBranchId: branchId }]);
    return json({ currentlyWorkingCount: 2, timestamp: new Date().toISOString() });
  }) as typeof fetch;
  return { calls, fetcher };
}

async function open(fetcher: typeof fetch, overrides: Record<string, unknown> = {}) {
  // The computed import lets the missing transport fail each behavioural pin,
  // rather than prevent the baseline suite from collecting its assertions.
  const modulePath = '../src/services/' + 'console-otoapp.ts';
  const { openConsoleOtoApp } = await import(/* @vite-ignore */ modulePath) as {
    openConsoleOtoApp(input: {
      db: Db; ctx: { requestId: string }; handoff: HandoffConfig; auth: AuthContext;
      effective: EffectivePermission[]; token: string; requestId: string;
      timeoutMs: number; fetch: typeof fetch; branchId: string;
    }): Promise<{ get(path: string): Promise<{ status: number; body: unknown }>; close(): Promise<boolean> }>;
  };
  return openConsoleOtoApp({
    db, ctx: { requestId: 'ZZ-TEST-634' }, handoff, auth, effective, token,
    requestId: 'ZZ-TEST-634', timeoutMs: 250, fetch: fetcher, branchId, ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.department.mockResolvedValue(false);
  seams.mint.mockResolvedValue({ origin, token: handoffToken });
});

describe('SCRUM-634 Console acting-user OTO App transport', () => {
  it('uses the caller audited handoff, origin-less exchange and private cookie, without projecting role/salary', async () => {
    const http = wire();
    const session = await open(http.fetcher);
    expect(seams.mint).toHaveBeenCalledTimes(1);
    const mint = seams.mint.mock.calls[0]!;
    expect(mint[0] === db && mint[2] === handoff).toBe(true);
    const opts = mint[3] as Record<string, unknown>;
    expect(opts).toMatchObject({ accountId, sessionId: auth.sessionId, operatorId: auth.operatorId, audience: 'oto_app', branchId });
    expect(opts.sessionToken === token).toBe(true);
    expect(opts.after).toEqual({ purpose: 'console.staff_summary' });
    const me = await session.get('/api/user');
    expect((me.body as { platformRoleMapping: unknown }).platformRoleMapping).toEqual(identity().platformRoleMapping);
    expect(await session.get('/api/branches')).toMatchObject({ status: 200 });
    expect(await session.close()).toBe(true);
    expect(await session.close()).toBe(true);
    expect(http.calls.map(c => [c.init.method, c.path])).toEqual([
      ['POST', '/api/auth/handoff'], ['GET', '/api/user'], ['GET', '/api/user'], ['GET', '/api/branches'], ['POST', '/api/logout'],
    ]);
    expect(http.calls.every(c => c.url.origin === origin && c.init.redirect === 'manual')).toBe(true);
    const exchange = http.calls[0]!;
    expect(new Headers(exchange.init.headers).has('origin')).toBe(false);
    expect((JSON.parse(String(exchange.init.body)) as { token: string }).token === handoffToken).toBe(true);
    expect(http.calls.slice(1).every(c => new Headers(c.init.headers).get('cookie') === appCookie)).toBe(true);
    expect(http.calls.every(c => !new Headers(c.init.headers).has('authorization'))).toBe(true);
    expect(Object.keys(session).sort()).toEqual(['close', 'get']);
  });

  it('checks the selected core branch instead of a different session seat', async () => {
    const http = wire();
    const session = await open(http.fetcher, { auth: { ...auth, branchId: randomUUID() } });
    expect(await session.close()).toBe(true);
  });

  it('accepts an own-department app grant without inventing a branch grant', async () => {
    seams.department.mockResolvedValue(true);
    const http = wire();
    const session = await open(http.fetcher, { effective: [] });
    expect(seams.department).toHaveBeenCalledWith(db, [], 'app:oto_app:access', auth.operatorId);
    expect(await session.close()).toBe(true);
  });

  it('refuses an app grant for another branch before mint or HTTP', async () => {
    const http = wire();
    await expect(open(http.fetcher, { effective: [{ ...effective[0], scopeId: randomUUID() }] })).rejects.toMatchObject({ status: 403 });
    expect(seams.mint).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(0);
  });

  it('refuses an unconfigured app before mint or HTTP', async () => {
    const http = wire();
    await expect(open(http.fetcher, { handoff: { ...handoff, origins: new Map() } })).rejects.toMatchObject({ status: 503, code: 'OTO_APP_NOT_CONFIGURED' });
    expect(seams.mint).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(0);
  });

  it('sanitizes access-lookup errors and does not mint or contact the app', async () => {
    const privateDetail = randomBytes(20).toString('hex');
    seams.department.mockRejectedValue(new Error(privateDetail));
    const http = wire();
    let error: unknown;
    try { await open(http.fetcher); } catch (e) { error = e; }
    expect(error).toMatchObject({ status: 503 });
    expect(String(error).includes(privateDetail)).toBe(false);
    expect(JSON.stringify(error).includes(privateDetail)).toBe(false);
    expect(seams.mint).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(0);
  });

  it('does not follow an unexpected origin returned by the mint', async () => {
    seams.mint.mockResolvedValue({ origin: 'https://foreign.example.test', token: handoffToken });
    const http = wire();
    await expect(open(http.fetcher)).rejects.toMatchObject({ status: 503 });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    [401, 'signed_out'], [403, 'not_provisioned'], [403, 'disabled'],
  ])('sanitizes handoff refusal %i/%s without returning upstream text', async (status, reason) => {
    const privateMessage = randomBytes(20).toString('hex');
    const http = wire(c => c.path === '/api/auth/handoff' ? json({ reason, message: privateMessage }, status) : undefined);
    let error: unknown;
    try { await open(http.fetcher); } catch (e) { error = e; }
    expect(error).toMatchObject({ status });
    expect(JSON.stringify(error).includes(privateMessage)).toBe(false);
    expect(String(error).includes(privateMessage)).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it('rejects a missing app cookie before identity or summary reads', async () => {
    const http = wire(c => c.path === '/api/auth/handoff' ? json({ ok: true }) : undefined);
    await expect(open(http.fetcher)).rejects.toMatchObject({ status: 503 });
    expect(http.calls.map(c => c.path)).toEqual(['/api/auth/handoff']);
  });

  it.each(['malformed', 'oversized', 'stalled'])('logs out an acknowledged auth session despite a %s handoff body', async kind => {
    const privateDetail = randomBytes(20).toString('hex');
    const headers = { 'set-cookie': `${appCookie}; HttpOnly; SameSite=Lax; Path=/` };
    const http = wire(c => {
      if (c.path !== '/api/auth/handoff') return undefined;
      if (kind === 'malformed') return new Response(privateDetail, { status: 200, headers });
      if (kind === 'oversized') return json({ ok: true }, 200, { ...headers, 'content-length': String(1024 * 1024 + 1) });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      }), { status: 200, headers });
    });
    let error: unknown;
    try { await open(http.fetcher, { timeoutMs: 20 }); } catch (e) { error = e; }
    expect(error).toMatchObject({ status: 503, code: 'OTO_APP_UNAVAILABLE' });
    expect(String(error).includes(privateDetail)).toBe(false);
    expect(JSON.stringify(error).includes(privateDetail)).toBe(false);
    expect(http.calls.map(c => [c.init.method, c.path])).toEqual([
      ['POST', '/api/auth/handoff'], ['POST', '/api/logout'],
    ]);
    expect(new Headers(http.calls.at(-1)?.init.headers).get('cookie') === appCookie).toBe(true);
  });

  it.each([null, randomUUID()])('closes a session whose platform stamp is missing or foreign', async stamp => {
    const http = wire(c => c.path === '/api/user' ? json({ ...identity(), platformUserId: stamp }) : undefined);
    await expect(open(http.fetcher)).rejects.toMatchObject({ status: 403 });
    expect(http.calls.map(c => c.path)).toEqual(['/api/auth/handoff', '/api/user', '/api/logout']);
  });

  it('attempts logout after malformed bootstrap JSON and exposes only a static error', async () => {
    const privateMessage = randomBytes(20).toString('hex');
    const http = wire(c => c.path === '/api/user' ? new Response(privateMessage) : undefined);
    let error: unknown;
    try { await open(http.fetcher); } catch (e) { error = e; }
    expect(error).toMatchObject({ status: 503 });
    expect(String(error).includes(privateMessage)).toBe(false);
    expect(http.calls.at(-1)?.path).toBe('/api/logout');
  });

  it('preserves native plain-text bootstrap refusals and still logs out', async () => {
    const http = wire(c => c.path === '/api/user' ? new Response('Unauthorized', { status: 401 }) : undefined);
    await expect(open(http.fetcher)).rejects.toMatchObject({ status: 401, code: 'OTO_APP_FORBIDDEN' });
    expect(http.calls.map(c => c.path)).toEqual(['/api/auth/handoff', '/api/user', '/api/logout']);
  });

  it('preserves app GET permission refusals for per-card handling', async () => {
    const http = wire(c => c.path === '/api/payroll/month-status' ? json({ message: 'Not permitted' }, 403) : undefined);
    const session = await open(http.fetcher);
    try { expect(await session.get('/api/payroll/month-status')).toMatchObject({ status: 403 }); }
    finally { expect(await session.close()).toBe(true); }
  });

  it.each([
    '/api/user', '/api/branches', `/api/timekeeping/live?branchId=${appBranchId}`,
    `/api/timekeeping/review?date=2026-10-25&branchId=${appBranchId}`,
    `/api/time-off?branchId=${appBranchId}&dateFrom=2026-10-25&dateTo=2026-10-25`,
    '/api/payroll/month-status',
  ])('allows only the declared GET grammar: %s', async path => {
    const http = wire();
    const session = await open(http.fetcher);
    try { expect((await session.get(path)).status).toBe(200); }
    finally { expect(await session.close()).toBe(true); }
    expect(http.calls.at(-2)?.init.method).toBe('GET');
    expect(http.calls.at(-2)?.init.body).toBeUndefined();
  });

  it('refuses unknown paths, external URLs and expanded query targets before HTTP', async () => {
    const http = wire();
    const session = await open(http.fetcher);
    const paths = [
      'https://foreign.example.test/api/user', '//foreign.example.test/api/user', '/api/employees',
      '/api/user?x=1', '/api/timekeeping/live', '/api/payroll/setup', '/api/payroll/month-status?month=2026-10',
      `/api/timekeeping/live?branchId=${appBranchId}&branchId=${randomUUID()}`,
      `/api/timekeeping/review?date=2026-02-30&branchId=${appBranchId}`,
      `/api/time-off?branchId=${appBranchId}&dateFrom=2026-10-25&dateTo=2026-10-26`,
      `/api/timekeeping/live?branchId=${appBranchId}#ignored`, '/api/../api/user', '/api/branches/',
      '/api/timekeeping/live?branchId=not-a-uuid', '/api/users%2f..%2fuser',
      `/API/TIMEKEEPING/LIVE?branchId=${appBranchId}`, `/api/timekeeping/live?BRANCHID=${appBranchId}`,
    ];
    try {
      const before = http.calls.length;
      for (const path of paths) await expect(session.get(path)).rejects.toMatchObject({ code: 'OTO_APP_INVALID_TARGET' });
      expect(http.calls).toHaveLength(before);
    } finally { expect(await session.close()).toBe(true); }
  });

  it.each([302, 307])('does not follow an app %i redirect', async status => {
    const http = wire(c => c.path === '/api/branches' ? new Response(null, { status, headers: { location: 'https://foreign.example.test/' } }) : undefined);
    const session = await open(http.fetcher);
    try { await expect(session.get('/api/branches')).rejects.toMatchObject({ status: 503 }); }
    finally { expect(await session.close()).toBe(true); }
    expect(http.calls.every(c => c.url.origin === origin)).toBe(true);
  });

  it.each(['declared', 'streamed'])('bounds %s JSON bodies before parsing', async kind => {
    let cancelled = false;
    const http = wire(c => {
      if (c.path !== '/api/branches') return undefined;
      if (kind === 'declared') return json([], 200, { 'content-length': String(1024 * 1024 + 1) });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      });
      return new Response(stream);
    });
    const session = await open(http.fetcher);
    try { await expect(session.get('/api/branches')).rejects.toMatchObject({ status: 503 }); }
    finally { expect(await session.close()).toBe(true); }
    if (kind === 'streamed') expect(cancelled).toBe(true);
  });

  it('bounds a stalled GET and still allows its finally logout', async () => {
    const http = wire(c => {
      if (c.path !== '/api/branches') return undefined;
      return new Promise<Response>((_, reject) => {
        const abort = () => reject(new Error('ZZ TEST private transport detail'));
        if (c.init.signal?.aborted) abort();
        else c.init.signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const session = await open(http.fetcher, { timeoutMs: 20 });
    try { await expect(session.get('/api/branches')).rejects.toMatchObject({ status: 503 }); }
    finally { expect(await session.close()).toBe(true); }
  });

  it('sanitizes rejected fetch errors without leaking their URL, body or credentials', async () => {
    const privateDetail = randomBytes(20).toString('hex');
    const http = wire(c => {
      if (c.path === '/api/branches') throw new Error(privateDetail);
      return undefined;
    });
    const session = await open(http.fetcher);
    try {
      let error: unknown;
      try { await session.get('/api/branches'); } catch (e) { error = e; }
      expect(error).toMatchObject({ status: 503 });
      expect(String(error).includes(privateDetail)).toBe(false);
      expect(JSON.stringify(error).includes(privateDetail)).toBe(false);
    } finally { expect(await session.close()).toBe(true); }
  });

  it.each([false, true])('reports unconfirmed logout honestly, throwing=%s, without another logout', async throws => {
    const http = wire(c => {
      if (c.path !== '/api/logout') return undefined;
      if (throws) throw new Error('ZZ TEST unavailable');
      return json({ ok: false }, 500);
    });
    const session = await open(http.fetcher);
    expect(await session.close()).toBe(false);
    expect(await session.close()).toBe(false);
    expect(http.calls.filter(c => c.path === '/api/logout')).toHaveLength(1);
    const before = http.calls.length;
    await expect(session.get('/api/user')).rejects.toMatchObject({ code: 'OTO_APP_CLOSED' });
    expect(http.calls).toHaveLength(before);
  });
});
