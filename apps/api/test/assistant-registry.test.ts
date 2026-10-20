import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSISTANT_ROUTE_TEMPLATE, ASSISTANT_TOOLS } from '@oto/shared';
import { loadEnv } from '../src/env';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-591 (internal assistant, round I1, lane b) — the `assistant-registry`
 * census (plan docs/progress/plans/internal-assistant-build/PLAN.md §F.3) and
 * the assistant's environment (§E.2).
 *
 * THE WRITE-ACTIONS GATE IN CODE. A tool is an existing GET route called as
 * the person (§B.1). Every platform tool's route must be a route this api
 * registers, a GET, and one a session reaches through its own guard — never
 * `public`, a machine `credential`, `platformWide` or `crossSiteReturn`. No
 * tool of either system may name anything but GET. A tool added over a write
 * route, or over a route that is not there, fails here on the day it is
 * written. (The OTO App's routes are its own; round I4 pins them against its
 * harness.)
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
}, 300_000);
afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const norm = (url: string) => url.replace(/\/$/, '') || '/';

describe('assistant-registry census (§F.3)', () => {
  it('names every tool once, sorted by name (cache-stable, §D.2)', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  it('gives every tool of either system GET route templates only, with no query string', () => {
    for (const tool of ASSISTANT_TOOLS) {
      for (const route of tool.routes) {
        expect(route, `${tool.name}`).toMatch(ASSISTANT_ROUTE_TEMPLATE);
        expect(route.startsWith('GET /'), `${tool.name}: ${route}`).toBe(true);
      }
    }
  });

  it('resolves every platform tool route to a registered, session-guarded GET route', () => {
    const registry = ctx.app.routeRegistry;
    const problems: string[] = [];
    for (const tool of ASSISTANT_TOOLS.filter((t) => t.system === 'platform')) {
      for (const route of tool.routes) {
        const url = route.slice('GET '.length);
        const entry = registry.find((r) => r.method === 'GET' && norm(r.url) === url);
        if (!entry) {
          problems.push(`${tool.name}: ${route} is not a registered GET route`);
          continue;
        }
        const c = entry.config;
        if (c.public) problems.push(`${tool.name}: ${route} is public`);
        if (c.credential) problems.push(`${tool.name}: ${route} takes a machine credential`);
        if (c.platformWide) problems.push(`${tool.name}: ${route} is platform-wide`);
        if (c.crossSiteReturn) problems.push(`${tool.name}: ${route} is a cross-site return`);
        if (!c.permission && !c.auth && !c.dynamicPermission) {
          problems.push(`${tool.name}: ${route} declares no session guard`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('names no tool over the OTO App fence gaps still open, and the own-balance lists on oto.my_leave only (plan "Concerns" C1–C3; G2 approved 2026-10-21)', () => {
    // `/api/time-events` (C2) and `/api/checklists/today` (C3): no tool, as before (attendance covers
    // the clock events). C1, the leave balances, closed in the OTO App at SCRUM-595 (2f8848a0: a staff
    // session reads only its own balance, the branch lists answer only its own row; 92318de6 fenced
    // `/api/time-events` the same way): the two branch lists the rota's own "My Leave Balance" reads
    // may be named by oto.my_leave, which reads the asker's own row — and by no other tool. The
    // per-employee balance routes, the sick-leave list and a colleague's balance stay off limits.
    const OWN_BALANCE_LISTS = ['GET /api/leave-balances', 'GET /api/all-leave-balances'];
    for (const tool of ASSISTANT_TOOLS) {
      for (const route of tool.routes) {
        expect(route, tool.name).not.toMatch(/time-events|checklists/);
        if (/balance/.test(route)) {
          expect(tool.name, route).toBe('oto.my_leave');
          expect(OWN_BALANCE_LISTS, `${tool.name}: ${route}`).toContain(route);
        }
      }
    }
    expect(ASSISTANT_TOOLS.find((t) => t.name === 'oto.my_leave')!.routes).toEqual(['GET /api/my-time-off', ...OWN_BALANCE_LISTS]);
    expect(ASSISTANT_TOOLS.filter((t) => t.system === 'oto_app').map((t) => t.name)).toEqual([
      'oto.attendance',
      'oto.employee_leave',
      'oto.employees.find',
      'oto.my_leave',
      'oto.my_payslips',
      'oto.payroll_summary',
      'oto.rota',
    ]);
  });

  it('is looking at the platform tools the plan lists', () => {
    expect(ASSISTANT_TOOLS.filter((t) => t.system === 'platform').map((t) => t.name)).toEqual([
      'audit.search',
      'branches.list',
      'checkin.board',
      // The test night of 2026-10-21 (W6): the Inbox dashboard, a plain read over GET /inbox/dashboard.
      'inbox.dashboard',
      'inbox.queue',
      'me.whoami',
      'members.get',
      'members.lookup',
      'members.search',
      'occupancy.now',
      'ops.failures',
    ]);
  });
});

describe('the internal assistant environment (§E.2)', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' } as const;

  it('switched on without ANTHROPIC_API_KEY refuses the boot, naming the variable', () => {
    expect(() => loadEnv({ ...base, INTERNAL_AI_ENABLED: 'true' })).toThrow(
      /INTERNAL_AI_ENABLED is true but ANTHROPIC_API_KEY is not set/,
    );
    expect(() => loadEnv({ ...base, INTERNAL_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'k' })).not.toThrow();
  });

  it('defaults: off, Opus at low effort, 20 s a call, 6 tools and 45 s an ask, 40 / 600 asks and 15 M tokens a day, OTO App tools off', () => {
    expect(loadEnv(base)).toMatchObject({
      INTERNAL_AI_ENABLED: 'false',
      INTERNAL_AI_MODEL: 'claude-opus-5-5',
      INTERNAL_AI_EFFORT: 'low',
      INTERNAL_AI_TIMEOUT_MS: 20_000,
      INTERNAL_AI_MAX_TOOL_CALLS: 6,
      INTERNAL_AI_ASK_WALL_MS: 45_000,
      INTERNAL_AI_PERSON_DAILY_CAP: 40,
      INTERNAL_AI_DAILY_ASK_CAP: 600,
      INTERNAL_AI_DAILY_TOKEN_CAP: 15_000_000,
      INTERNAL_AI_OTOAPP_TOOLS: 'false',
    });
  });

  it('a test process is never switched on by a developer’s environment', () => {
    const before = { ...process.env };
    process.env.INTERNAL_AI_ENABLED = 'true';
    process.env.INTERNAL_AI_OTOAPP_TOOLS = 'true';
    try {
      expect(loadEnv(base)).toMatchObject({ INTERNAL_AI_ENABLED: 'false', INTERNAL_AI_OTOAPP_TOOLS: 'false' });
    } finally {
      process.env = before;
    }
  });

  it('refuses a model that is not one word', () => {
    expect(() => loadEnv({ ...base, INTERNAL_AI_MODEL: 'claude opus' })).toThrow();
  });
});
