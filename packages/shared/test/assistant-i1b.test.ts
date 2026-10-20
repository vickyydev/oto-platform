import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ROUTE_TEMPLATE,
  ASSISTANT_TOOL_NAME,
  ASSISTANT_TOOLS,
  INBOX_ROLE_BUNDLES,
  INBOX_ROLES,
  PERMISSIONS,
  ROLE_BUNDLES,
  SUITE_SCREENS,
  SUITE_SCREEN_KEYS,
  SYSTEM_ROLES,
  buildSuiteScreenPath,
  findAssistantTool,
  findSuiteScreen,
  suiteScreenOffered,
  type Permission,
  type SuiteScreenViewer,
} from '../src/index';

/**
 * SCRUM-591 (internal assistant, round I1, lane b) — the shared half: the
 * tool registry's data, the deep-link map and the two permissions (plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.4, §C, §E.2, R5).
 */

describe('the tool registry, as data (§B.4)', () => {
  it('names each tool once, as a dotted word, with GET templates only', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.name).toMatch(ASSISTANT_TOOL_NAME);
      expect(tool.routes.length).toBeGreaterThan(0);
      for (const r of tool.routes) expect(r, tool.name).toMatch(ASSISTANT_ROUTE_TEMPLATE);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('lists the plan’s seventeen tools, the OTO App ones under oto.*', () => {
    expect(ASSISTANT_TOOLS).toHaveLength(17);
    for (const tool of ASSISTANT_TOOLS) expect(tool.name.startsWith('oto.'), tool.name).toBe(tool.system === 'oto_app');
  });

  it('validates the model’s arguments before any call: unknown keys, bad ids and bad dates are refused', () => {
    const lookup = findAssistantTool('members.lookup')!;
    expect(lookup.input.safeParse({ phone: '081 234 5678' }).success).toBe(true);
    expect(lookup.input.safeParse({ phone: '081 234 5678', url: 'https://x' }).success).toBe(false);
    const occupancy = findAssistantTool('occupancy.now')!;
    expect(occupancy.input.safeParse({ branchId: '../../admin' }).success).toBe(false);
    const attendance = findAssistantTool('oto.attendance')!;
    expect(attendance.input.safeParse({ employeeId: 'a1b2', startDate: '2026-10-01', endDate: '2026-10-20' }).success).toBe(true);
    expect(attendance.input.safeParse({ employeeId: 'a/b', startDate: '2026-10-01', endDate: '2026-10-20' }).success).toBe(false);
    expect(attendance.input.safeParse({ employeeId: 'a1', startDate: 'yesterday', endDate: '2026-10-20' }).success).toBe(false);
  });

  it('lists no tool over the C1–C3 fence gaps (G2)', () => {
    const routes = ASSISTANT_TOOLS.flatMap((t) => [...t.routes]);
    expect(routes.some((r) => r.includes('/api/time-events'))).toBe(false);
    expect(routes.some((r) => r.includes('/api/checklists'))).toBe(false);
    expect(routes.some((r) => /leave-balance|leave_balance/.test(r))).toBe(false);
  });
});

describe('the deep-link map (§C)', () => {
  it('keys each screen once, the Inbox in since P2', () => {
    expect(new Set(SUITE_SCREEN_KEYS).size).toBe(SUITE_SCREEN_KEYS.length);
    expect(SUITE_SCREEN_KEYS.filter((k) => k.startsWith('inbox.'))).toEqual(['inbox.thread', 'inbox.queue']);
    for (const s of SUITE_SCREENS) {
      expect(s.key.split('.')[0], s.key).toBe(s.app === 'oto_app' ? 'oto' : s.app);
      expect(s.path.startsWith('/'), s.key).toBe(true);
      expect(s.path.includes('?'), s.key).toBe(false);
      for (const p of s.params.filter((x) => x.in === 'path')) expect(s.path, s.key).toContain(`:${p.name}`);
    }
  });

  it('builds a path from checked parameters only', () => {
    expect(buildSuiteScreenPath('oto.employee.time', { id: 'e-123' })).toBe('/employees/e-123?tab=time');
    expect(buildSuiteScreenPath('oto.timekeeping.employee', { employeeId: 'e1', date: '2026-10-20' })).toBe(
      '/timekeeping-review/employee/e1?date=2026-10-20',
    );
    expect(buildSuiteScreenPath('oto.timekeeping.employee', { employeeId: 'e1' })).toBe('/timekeeping-review/employee/e1');
    expect(buildSuiteScreenPath('oto.payroll.month', { month: '2026-09', tab: 'preview' })).toBe(
      '/payroll/month-end?month=2026-09&tab=preview',
    );
    expect(buildSuiteScreenPath('console.health')).toBe('/health');
    // Refused: unknown key, a missing required parameter, a wrong shape, an
    // unknown parameter, a path escape.
    expect(buildSuiteScreenPath('console.secrets')).toBeNull();
    expect(buildSuiteScreenPath('oto.employee.time')).toBeNull();
    expect(buildSuiteScreenPath('oto.payroll.month', { month: '2026-13' })).toBeNull();
    expect(buildSuiteScreenPath('oto.payroll.month', { month: '2026-09', tab: 'edit' })).toBeNull();
    expect(buildSuiteScreenPath('console.health', { next: 'https://evil.example' })).toBeNull();
    expect(buildSuiteScreenPath('oto.employee.time', { id: '../admin' })).toBeNull();
  });

  it('links an Inbox conversation by its uuid only, and the queue by its filter (P2)', () => {
    const id = '0192f0a0-1234-7abc-8def-0123456789ab';
    expect(buildSuiteScreenPath('inbox.thread', { c: id })).toBe(`/?c=${id}`);
    expect(buildSuiteScreenPath('inbox.queue')).toBe('/?unanswered=1');
    expect(buildSuiteScreenPath('inbox.thread')).toBeNull();
    expect(buildSuiteScreenPath('inbox.thread', { c: 'e-123' })).toBeNull();
    expect(buildSuiteScreenPath('inbox.thread', { c: `${id}&tab=handled` })).toBeNull();
    const thread = findSuiteScreen('inbox.thread')!;
    expect(suiteScreenOffered(thread, viewer(['inbox:conversation:read']))).toBe(false); // no Inbox tile
    expect(suiteScreenOffered(thread, viewer(['app:inbox:access']))).toBe(false);
    expect(suiteScreenOffered(thread, viewer(['app:inbox:access', 'inbox:conversation:read']))).toBe(true);
  });

  const viewer = (perms: Permission[], otoApp?: SuiteScreenViewer['otoApp']): SuiteScreenViewer => ({
    has: (p) => perms.includes(p),
    otoApp,
  });

  it("offers a screen only past its app's tile and its own gate", () => {
    const health = findSuiteScreen('console.health')!;
    expect(suiteScreenOffered(health, viewer(['admin:health:read']))).toBe(false); // no console tile
    expect(suiteScreenOffered(health, viewer(['app:console:access', 'admin:health:read']))).toBe(true);
    expect(suiteScreenOffered(health, viewer(['app:console:access']))).toBe(false);
    expect(suiteScreenOffered(findSuiteScreen('launcher.account')!, viewer([]))).toBe(true);
  });

  it('withholds an OTO App role- or salary-gated screen unless the OTO App said who the asker is (Q2)', () => {
    const tile: Permission[] = ['app:oto_app:access'];
    const payroll = findSuiteScreen('oto.payroll.month')!;
    const review = findSuiteScreen('oto.timekeeping.employee')!;
    const rota = findSuiteScreen('oto.rota')!;
    expect(suiteScreenOffered(rota, viewer(tile))).toBe(true);
    expect(suiteScreenOffered(review, viewer(tile))).toBe(false);
    expect(suiteScreenOffered(review, viewer(tile, { role: 'manager', permissions: [] }))).toBe(true);
    expect(suiteScreenOffered(review, viewer(tile, { role: 'staff', permissions: [] }))).toBe(false);
    expect(suiteScreenOffered(payroll, viewer(tile, { role: 'manager', permissions: [] }))).toBe(false);
    expect(suiteScreenOffered(payroll, viewer(tile, { role: 'admin', permissions: ['hr.view_salary'] }))).toBe(true);
    expect(suiteScreenOffered(rota, viewer([]))).toBe(false); // no OTO App tile
  });
});

describe('the two permissions (§E.2, R5)', () => {
  it('declares both', () => {
    expect(PERMISSIONS).toContain('assistant:ask:use');
    expect(PERMISSIONS).toContain('assistant:log:review');
  });

  it('puts the ask in every staff bundle and every inbox role', () => {
    for (const r of SYSTEM_ROLES) expect(ROLE_BUNDLES[r], r).toContain('assistant:ask:use');
    for (const r of INBOX_ROLES) expect(INBOX_ROLE_BUNDLES[r], r).toContain('assistant:ask:use');
  });

  it('gives the log review to the operator and platform administrators only (G3)', () => {
    const holders = SYSTEM_ROLES.filter((r) => ROLE_BUNDLES[r].includes('assistant:log:review'));
    expect(holders.sort()).toEqual(['operator_admin', 'platform_admin']);
    for (const r of INBOX_ROLES) expect(INBOX_ROLE_BUNDLES[r], r).not.toContain('assistant:log:review');
  });
});
