import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard as DashboardData, InboxMe } from '@/api/inbox';
import { StatsRow } from '@/components/StatsRow';
import { Workspace } from '@/components/Workspace';
import { renderHook } from '../../pos/test/support/hooks';

const calls = vi.hoisted(() => ({ dashboard: vi.fn(), conversations: vi.fn(), reload: vi.fn(async () => undefined) }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('../../pos/test/support/hooks') }));
vi.mock('@/api/inbox', async original => ({ ...await original<typeof import('@/api/inbox')>(), inboxApi: {
  dashboard: calls.dashboard, conversations: calls.conversations,
} }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({ signOut: vi.fn(), reload: calls.reload }) }));
vi.mock('@/lib/theme', async original => ({ ...await original<typeof import('@/lib/theme')>(), useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));

function deferred<T>() {
  let resolve!: (answer: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const me: InboxMe = { accountId: '018f0000-0000-7000-8000-000000000001', name: 'ZZ TEST viewer', roles: ['owner'], tabs: ['team', 'handled'],
  teams: [], people: [], defaultReceptionBranchId: null, simulator: null, access: { categories: null, channelAccountIds: null, version: 0 },
  capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: false, ai: false } };
const counts = (active: number): DashboardData => ({ scope: 'all', newToday: 0, unanswered: 0, handledToday: 0, active,
  averageFirstResponseSeconds: null, population: 'active', byCategory: { birthdays: active, general: 0, marketing: 0, gm: 0 },
  day: '2026-11-17', beosThisWeek: 0, weekStart: '2026-11-16' });
type Element = ReactElement<{ children?: ReactNode; data?: DashboardData | null }>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children)];
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  vi.stubGlobal('window', { location: new URL('https://inbox.example.invalid/'),
    history: { state: null, pushState: vi.fn(), replaceState: vi.fn() },
    matchMedia: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), setInterval, clearInterval, setTimeout, clearTimeout });
  calls.conversations.mockResolvedValue({ conversations: [], nextCursor: null, tabCounts: { team: 0, handled: 0 }, access: me.access });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SCRUM-993 actual workspace request ordering', () => {
  it('cannot restore pre-revocation dashboard counts when their delayed request finishes after fresh policy metadata', async () => {
    const old = deferred<DashboardData>(), fresh = deferred<DashboardData>();
    calls.dashboard.mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
    const hook = renderHook(Workspace, { me }); cleanup = hook.unmount; await flush();
    const restricted: InboxMe = { ...me, access: { categories: ['general'], channelAccountIds: null, version: 1 } };
    // Keep the shared tab array stable: the policy change itself must fence
    // the old request and request new counts, without an unrelated view change.
    hook.rerender({ me: restricted }); await flush();
    old.resolve(counts(42)); await flush();
    // SCRUM-1016: the counts are the statistics row's, in the app bar.
    expect(elements(hook.result.current).find(element => element.type === StatsRow)!.props.data).toBeNull();
    expect(calls.dashboard).toHaveBeenCalledTimes(2);
    fresh.resolve({ ...counts(0), byCategory: { general: 0, birthdays: 0, marketing: 0, gm: 0 } }); await flush();
    expect(elements(hook.result.current).find(element => element.type === StatsRow)!.props.data?.active).toBe(0);
  });
});
