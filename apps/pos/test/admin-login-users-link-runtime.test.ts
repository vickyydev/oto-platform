import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import Admin from '@/pages/Admin';

const seam = vi.hoisted(() => ({
  destination: vi.fn<(search: string) => Promise<string>>(),
  operator: { id: 'actor-a', name: 'ZZ TEST Redirect', role: 'manager' as const } as { id: string; name: string; role: 'manager' } | null,
  can: (_permission: string): boolean => false,
  allowed: true, locked: false, sessionResolved: true, mustChangePassword: false,
  switching: false, branch: { id: 'park-a', apiId: 'park-api-a' },
  location: '/admin', search: '?panel=tax', logout: vi.fn(),
}));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
vi.mock('wouter', () => ({ useSearch: () => seam.search, useLocation: () => [seam.location, vi.fn()], Link: () => null }));
vi.mock('@/api/admin-entry', () => ({ adminDestination: seam.destination }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => seam }));
vi.mock('@/branch/BranchContext', () => ({ useBranch: () => seam }));
vi.mock('@/components/auth/LockScreen', () => ({ LockScreen: function ExistingSignIn() { return null; } }));
vi.mock('@/components/auth/ChangePasswordScreen', () => ({ ChangePasswordScreen: function ExistingPasswordChange() { return null; } }));

function nodes(tree: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as React.ReactNode)];
}
function words(tree: React.ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(words).join(' ');
  return React.isValidElement<{ children?: React.ReactNode }>(tree) ? words(tree.props.children) : '';
}
function retry(tree: React.ReactNode): () => void {
  const node = nodes(tree).find(element => words(element.props.children as React.ReactNode) === 'Try opening Admin again');
  if (typeof node?.props.onClick !== 'function') throw new Error('The failed redirect has no explicit retry.');
  return node.props.onClick as () => void;
}
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(complete => { resolve = complete; });
  return { promise, resolve };
}
function reset() {
  seam.operator = { id: 'actor-a', name: 'ZZ TEST Redirect', role: 'manager' };
  seam.can = permission => permission === 'app:console:access' && seam.allowed;
  seam.allowed = true; seam.locked = false; seam.sessionResolved = true; seam.mustChangePassword = false;
  seam.switching = false; seam.branch = { id: 'park-a', apiId: 'park-api-a' };
  seam.location = '/admin'; seam.search = '?panel=tax'; seam.destination.mockReset(); seam.logout.mockReset();
}
const destination = 'https://configured.example/#handoff=synthetic-redirect&to=%2Fcatalogue%2Ftax';

describe('the one-release POS Admin redirect lifecycle', () => {
  const replace = vi.fn();
  beforeEach(() => { reset(); replace.mockReset(); vi.stubGlobal('React', React); vi.stubGlobal('window', { location: { replace } }); });

  it('automatically opens the bookmarked page once and replaces the old address without a station prerequisite', async () => {
    seam.destination.mockResolvedValue(destination);
    const view = renderHook(() => Admin());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(destination));
    expect(seam.destination).toHaveBeenCalledExactlyOnceWith('?panel=tax');
    view.rerender(); view.rerender(); await Promise.resolve();
    expect(seam.destination).toHaveBeenCalledTimes(1);
    expect(words(view.result.current)).not.toContain(destination);
    view.unmount();
  });

  it('keeps one in-flight request across pending rerenders', async () => {
    const pending = deferred(); seam.destination.mockReturnValue(pending.promise);
    const view = renderHook(() => Admin());
    await vi.waitFor(() => expect(seam.destination).toHaveBeenCalledTimes(1));
    view.rerender(); view.rerender();
    expect(words(view.result.current)).toContain('Opening your Admin page…');
    expect(seam.destination).toHaveBeenCalledTimes(1); expect(replace).not.toHaveBeenCalled();
    pending.resolve(destination); await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    view.unmount();
  });

  it('does not issue before session resolution, sign-in, unlock, password change, app access or park selection', async () => {
    const changes = [() => { seam.sessionResolved = false; }, () => { seam.operator = null; },
      () => { seam.locked = true; }, () => { seam.mustChangePassword = true; },
      () => { seam.allowed = false; }, () => { seam.switching = true; }, () => { seam.location = '/stock'; }];
    for (const change of changes) {
      reset(); change(); const view = renderHook(() => Admin());
      await Promise.resolve(); await Promise.resolve();
      expect(seam.destination).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled(); view.unmount();
    }
  });

  it('retains the existing sign-in/unlock and temporary-password components', () => {
    for (const locked of [false, true]) {
      reset(); seam.operator = locked ? seam.operator : null; seam.locked = locked;
      const view = renderHook(() => Admin());
      expect(nodes(view.result.current).some(node => typeof node.type === 'function' && node.type.name === 'ExistingSignIn')).toBe(true);
      view.unmount();
    }
    reset(); seam.mustChangePassword = true;
    const view = renderHook(() => Admin());
    expect(nodes(view.result.current).some(node => typeof node.type === 'function' && node.type.name === 'ExistingPasswordChange')).toBe(true);
    view.unmount();
  });

  it('does not loop after a refusal and retries only from one deliberate press', async () => {
    const pending = deferred();
    seam.destination.mockRejectedValueOnce(Object.assign(new Error('Private server detail'), { status: 403 })).mockReturnValueOnce(pending.promise);
    const view = renderHook(() => Admin());
    await vi.waitFor(() => expect(words(view.result.current)).toContain('This account cannot open Admin.'));
    view.rerender(); view.rerender(); await Promise.resolve(); expect(seam.destination).toHaveBeenCalledTimes(1);
    const press = retry(view.result.current); press(); press();
    await vi.waitFor(() => expect(seam.destination).toHaveBeenCalledTimes(2));
    expect(replace).not.toHaveBeenCalled(); pending.resolve(destination);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(destination)); view.unmount();
  });

  it('never exposes issued URLs or claims through request failures or navigation exceptions', async () => {
    seam.destination.mockRejectedValueOnce(new Error(`Unavailable ${destination}`)).mockResolvedValueOnce(destination);
    replace.mockImplementationOnce(() => { throw new Error(`Navigation ${destination}`); });
    const view = renderHook(() => Admin());
    await vi.waitFor(() => expect(nodes(view.result.current).some(node => node.props.role === 'alert')).toBe(true));
    expect(words(view.result.current)).not.toContain(destination); expect(words(view.result.current)).not.toContain('synthetic-redirect');
    retry(view.result.current)();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(words(view.result.current)).not.toContain(destination); expect(words(view.result.current)).not.toContain('synthetic-redirect');
    view.unmount();
  });

  it('invalidates old replies on every render-updated actor, authority, lock, park and address boundary', async () => {
    const changes = [() => { seam.operator = { id: 'actor-b', name: 'ZZ TEST Other', role: 'manager' }; },
      () => { seam.can = permission => permission === 'app:console:access'; }, () => { seam.allowed = false; },
      () => { seam.locked = true; }, () => { seam.mustChangePassword = true; }, () => { seam.sessionResolved = false; },
      () => { seam.operator = null; }, () => { seam.branch = { ...seam.branch, id: 'park-b' }; },
      () => { seam.branch = { ...seam.branch, apiId: 'park-api-b' }; }, () => { seam.switching = true; },
      () => { seam.location = '/stock'; }, () => { seam.search = '?panel=menu'; }];
    for (const change of changes) {
      reset(); const old = deferred(); seam.destination.mockReturnValueOnce(old.promise).mockReturnValue(new Promise(() => undefined));
      const view = renderHook(() => Admin()); await vi.waitFor(() => expect(seam.destination).toHaveBeenCalledTimes(1));
      change(); view.rerender(); old.resolve(destination);
      await old.promise; await Promise.resolve(); await Promise.resolve();
      expect(replace).not.toHaveBeenCalled(); view.unmount();
    }
  });

  it('does not revive an old reply when actor, park, permission or query leaves and returns to the same value', async () => {
    const changes = [() => { const original = seam.operator; seam.operator = { id: 'actor-b', name: 'ZZ TEST Other', role: 'manager' }; return () => { seam.operator = original; }; },
      () => { const original = seam.branch; seam.branch = { id: 'park-b', apiId: 'park-api-b' }; return () => { seam.branch = original; }; },
      () => { seam.allowed = false; return () => { seam.allowed = true; }; },
      () => { seam.search = '?panel=menu'; return () => { seam.search = '?panel=tax'; }; }];
    for (const change of changes) {
      reset(); const old = deferred(); seam.destination.mockReturnValueOnce(old.promise).mockReturnValue(new Promise(() => undefined));
      const view = renderHook(() => Admin()); await vi.waitFor(() => expect(seam.destination).toHaveBeenCalledTimes(1));
      const restore = change(); view.rerender(); restore(); view.rerender(); old.resolve(destination);
      await old.promise; await Promise.resolve(); await Promise.resolve();
      expect(replace).not.toHaveBeenCalled(); view.unmount();
    }
  });

  it('rejects an old retry handler after access or location changed', async () => {
    seam.destination.mockRejectedValue(new Error('No connection'));
    const view = renderHook(() => Admin()); await vi.waitFor(() => expect(nodes(view.result.current).some(node => node.props.role === 'alert')).toBe(true));
    const press = retry(view.result.current); seam.allowed = false; view.rerender(); press();
    await Promise.resolve(); expect(seam.destination).toHaveBeenCalledTimes(1); expect(replace).not.toHaveBeenCalled(); view.unmount();
  });

  it('discards a late success after unmount and suppresses dispatch from an abandoned initial lifetime', async () => {
    const pending = deferred(); seam.destination.mockReturnValue(pending.promise);
    const abandoned = renderHook(() => Admin()); abandoned.unmount();
    const view = renderHook(() => Admin()); await vi.waitFor(() => expect(seam.destination).toHaveBeenCalledTimes(1));
    view.unmount(); pending.resolve(destination); await pending.promise; await Promise.resolve(); await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
  });
});
