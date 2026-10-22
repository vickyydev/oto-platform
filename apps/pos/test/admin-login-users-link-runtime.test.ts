import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { LoginUsersPanel } from '@/components/admin/access/LoginUsersPanel';

const seam = vi.hoisted(() => ({ destination: vi.fn<() => Promise<string>>(), console: true }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  ...await import('./support/hooks'),
}));
vi.mock('@/api/admin-entry', () => ({ adminAccountsDestination: seam.destination }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ can: () => seam.console }) }));

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
function action(tree: React.ReactNode) {
  const node = nodes(tree).find(element => typeof element.props.onClick === 'function');
  if (!node) throw new Error('The Admin entry has no explicit action.');
  return { click: () => (node.props.onClick as () => void)(), disabled: node.props.disabled, label: words(node.props.children as React.ReactNode) };
}
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(complete => { resolve = complete; });
  return { promise, resolve };
}
const destination = 'https://configured.example/#handoff=fixture&to=%2Fpeople%2Faccounts';

describe('the POS Admin entry action', () => {
  const assign = vi.fn();
  beforeEach(() => {
    seam.console = true; seam.destination.mockReset(); assign.mockReset();
    vi.stubGlobal('React', React); vi.stubGlobal('window', { location: { assign } });
  });

  it('does not issue a handoff from mounting and opens only after the explicit action', async () => {
    seam.destination.mockResolvedValue(destination);
    const view = renderHook(() => LoginUsersPanel());
    expect(seam.destination).not.toHaveBeenCalled();
    action(view.result.current).click();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(destination));
    expect(seam.destination).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('suppresses duplicate presses while pending and names the pending action honestly', async () => {
    const pending = deferred(); seam.destination.mockReturnValue(pending.promise);
    const view = renderHook(() => LoginUsersPanel());
    const first = action(view.result.current); first.click(); first.click();
    expect(seam.destination).toHaveBeenCalledTimes(1);
    expect(action(view.result.current).disabled).toBe(true);
    expect(action(view.result.current).label).toContain('Opening Admin…');
    expect(assign).not.toHaveBeenCalled();
    pending.resolve(destination);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    view.unmount();
  });

  it('keeps a real refusal visible and lets a subsequent explicit press retry', async () => {
    seam.destination.mockRejectedValueOnce(new Error('Admin access was refused.')).mockResolvedValueOnce(destination);
    const view = renderHook(() => LoginUsersPanel()); action(view.result.current).click();
    await vi.waitFor(() => {
      expect(words(view.result.current)).toContain('Admin access was refused.');
      expect(action(view.result.current).disabled).toBe(false);
    });
    expect(assign).not.toHaveBeenCalled(); action(view.result.current).click();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(destination));
    expect(seam.destination).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('does not navigate after the panel was left while a handoff request was pending', async () => {
    const pending = deferred(); seam.destination.mockReturnValue(pending.promise);
    const view = renderHook(() => LoginUsersPanel()); action(view.result.current).click(); view.unmount();
    pending.resolve(destination); await pending.promise; await Promise.resolve(); await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();
  });

  it('never renders an issued handoff URL or claim from a navigation exception', async () => {
    const claimMarker = 'synthetic-navigation-claim';
    const issued = `https://configured.example/#handoff=${claimMarker}&to=%2Fpeople%2Faccounts`;
    seam.destination.mockResolvedValue(issued);
    assign.mockImplementationOnce(() => { throw new Error(`Navigation could not use ${issued}`); });
    const view = renderHook(() => LoginUsersPanel()); action(view.result.current).click();
    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledTimes(1);
      expect(action(view.result.current).disabled).toBe(false);
    });
    const alert = nodes(view.result.current).find(element => element.props.role === 'alert');
    expect(alert).toBeDefined();
    expect(words(alert)).toBe('Admin could not be opened.');
    expect(words(alert)).not.toContain(issued);
    expect(words(alert)).not.toContain(claimMarker);
    view.unmount();
  });

  it('withholds the destination action and issues no request without existing Admin app access', () => {
    seam.console = false;
    const view = renderHook(() => LoginUsersPanel());
    expect(words(view.result.current)).toContain('Admin is not on your access.');
    expect(nodes(view.result.current).some(element => typeof element.props.onClick === 'function')).toBe(false);
    expect(seam.destination).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
    view.unmount();
  });
});
