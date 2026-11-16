import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../../apps/pos/test/support/hooks';
import { InboxAccessControls } from '../src/roles/InboxAccessControls';
import type { AdminApi } from '../src/api/admin-api';
import type { AccountInboxAccess, InboxAccessPreview } from '../src/api/roles';

vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(), ...await import('../../../apps/pos/test/support/hooks') }));
vi.mock('../src/hooks/use-toast', () => ({ toast: vi.fn() }));
import { toast } from '../src/hooks/use-toast';

const A = '018f0000-0000-7000-8000-000000000001', B = '018f0000-0000-7000-8000-000000000002';
const channel = '018f0000-0000-7000-8000-000000000003';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const value = (accountId = A, version = 0, extra: Partial<AccountInboxAccess> = {}): AccountInboxAccess => ({ accountId, version,
  categories: null, channelAccountIds: null, administrator: false, canManage: true,
  channels: [{ id: channel, channel: 'whatsapp', displayName: 'ZZ TEST source', branchId: null }], ...extra });
type Props = Parameters<typeof InboxAccessControls>[0];
type Element = ReactElement<{ children?: ReactNode; onClick?: (event: { preventDefault: () => void }) => void;
  onChange?: (event: { target: { checked: boolean } }) => void; disabled?: boolean; open?: boolean; checked?: boolean }>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return isValidElement(node) ? text((node as Element).props.children) : '';
}
let get: ReturnType<typeof vi.fn>, post: ReturnType<typeof vi.fn>, put: ReturnType<typeof vi.fn>, onSaved: ReturnType<typeof vi.fn>;
let mounted: ReturnType<typeof renderHook<Props, ReactElement>> | undefined;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const button = (name: string) => elements(mounted!.result.current).find(element => element.props.onClick && text(element.props.children) === name)!;
const click = (name: string) => button(name).props.onClick!({ preventDefault: () => undefined });
const checkbox = (name: string) => {
  const label = elements(mounted!.result.current).find(element => element.type === 'label' && text(element.props.children) === name)!;
  return elements(label.props.children).find(element => element.type === 'input')!;
};
const props = (accountId = A): Props => ({ api: api!, accountId, canAssign: true, onSaved });
let api: AdminApi;
beforeEach(() => {
  vi.clearAllMocks(); onSaved = vi.fn();
  get = vi.fn(async () => value());
  post = vi.fn(async (_path: string, body: { categories: AccountInboxAccess['categories']; channelAccountIds: string[] | null; expectedVersion: number }): Promise<InboxAccessPreview> => ({
    accountId: A, version: body.expectedVersion, before: { categories: null, channelAccountIds: null },
    after: { categories: body.categories, channelAccountIds: body.channelAccountIds }, changed: true }));
  put = vi.fn(async () => value(A, 1, { categories: [] }));
  api = { get, post, put, patch: vi.fn(), delete: vi.fn() } as AdminApi;
});
afterEach(() => { mounted?.unmount(); mounted = undefined; });
async function mount() { mounted = renderHook(InboxAccessControls, props()); await flush(); }
async function reviewedEmptyCategories() {
  checkbox('All categories').props.onChange!({ target: { checked: false } });
  for (const name of ['Birthdays & Events', 'General', 'Marketing', 'GM']) checkbox(name).props.onChange!({ target: { checked: false } });
  click('Review Inbox limits'); await flush();
  expect(button('Save Inbox limits').props.disabled).toBe(false);
}

describe('SCRUM-993 existing permissions drawer access controls', () => {
  it('reads only on opening and shows branch-manager controls read-only without automatic writes', async () => {
    get.mockResolvedValue(value(A, 0, { canManage: false, categories: ['general'], channelAccountIds: [] }));
    await mount();
    expect(text(mounted!.result.current)).toContain('operator-wide role administrator');
    expect(text(mounted!.result.current)).toContain('Channels: None');
    expect(elements(mounted!.result.current).filter(element => element.type === 'input')).toEqual([]);
    expect(post).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
  it('preserves explicit empty arrays and requires a matching server before/after preview before versioned save', async () => {
    await mount(); await reviewedEmptyCategories();
    expect(post.mock.calls[0]![1]).toEqual({ categories: [], channelAccountIds: null, expectedVersion: 0 });
    expect(text(mounted!.result.current)).toContain('Categories: None');
    click('Save Inbox limits'); await flush();
    expect(put.mock.calls[0]![1]).toEqual({ categories: [], channelAccountIds: null, expectedVersion: 0 });
    expect(onSaved).toHaveBeenCalledTimes(1); expect(toast).toHaveBeenCalledTimes(1);
  });
  it('ignores stale account reads including A to B to A', async () => {
    const old = deferred<AccountInboxAccess>(); get.mockReturnValueOnce(old.promise).mockResolvedValueOnce(value(B)).mockResolvedValueOnce(value(A, 4));
    await mount(); mounted!.rerender(props(B)); await flush(); mounted!.rerender(props(A)); await flush();
    old.resolve(value(A, 1, { categories: [] })); await flush();
    expect(checkbox('All categories').props.checked).toBe(true);
    checkbox('All categories').props.onChange!({ target: { checked: false } }); click('Review Inbox limits'); await flush();
    expect(post.mock.calls[0]![1].expectedVersion).toBe(4);
  });
  it('does not enable saving a mismatched or obsolete preview', async () => {
    const preview = deferred<InboxAccessPreview>(); post.mockReturnValueOnce(preview.promise);
    await mount(); checkbox('All categories').props.onChange!({ target: { checked: false } }); click('Review Inbox limits');
    checkbox('General').props.onChange!({ target: { checked: false } });
    preview.resolve({ accountId: A, version: 0, before: { categories: null, channelAccountIds: null }, after: { categories: [], channelAccountIds: null }, changed: true }); await flush();
    expect(button('Save Inbox limits').props.disabled).toBe(true); click('Save Inbox limits'); await flush(); expect(put).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'] as const)('ignores an old save %s after A to B to A and preserves the latest read', async outcome => {
    const save = deferred<AccountInboxAccess>(); put.mockReturnValueOnce(save.promise);
    await mount(); await reviewedEmptyCategories(); click('Save Inbox limits');
    get.mockResolvedValueOnce(value(B)).mockResolvedValueOnce(value(A, 7));
    mounted!.rerender(props(B)); await flush(); mounted!.rerender(props(A)); await flush();
    if (outcome === 'resolve') save.resolve(value(A, 1, { categories: [] })); else save.reject(new Error('ZZ TEST obsolete failure'));
    await flush(); expect(checkbox('All categories').props.checked).toBe(true);
    expect(text(mounted!.result.current)).not.toContain('obsolete failure'); expect(onSaved).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled();
    checkbox('All categories').props.onChange!({ target: { checked: false } }); click('Review Inbox limits'); await flush();
    expect(post.mock.calls.at(-1)![1].expectedVersion).toBe(7);
  });
  it('does not replace a refreshed view or notify success when an older save completes', async () => {
    const save = deferred<AccountInboxAccess>(); put.mockReturnValueOnce(save.promise);
    await mount(); await reviewedEmptyCategories(); const refresh = button('Refresh limits').props.onClick!; click('Save Inbox limits');
    get.mockResolvedValueOnce(value(A, 8)); refresh({ preventDefault: () => undefined }); await flush();
    save.resolve(value(A, 1, { categories: [] })); await flush();
    expect(checkbox('All categories').props.checked).toBe(true); expect(onSaved).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled();
  });
  it('retains a conflict error until explicit refresh and never automatically overwrites newer limits', async () => {
    put.mockRejectedValueOnce(new Error('Inbox access changed after it was read. Refresh and review.'));
    await mount(); await reviewedEmptyCategories(); click('Save Inbox limits'); await flush();
    expect(text(mounted!.result.current)).toContain('Inbox access changed'); expect(put).toHaveBeenCalledTimes(1); expect(onSaved).not.toHaveBeenCalled();
    get.mockResolvedValueOnce(value(A, 3, { categories: ['general'] })); click('Refresh current limits'); await flush();
    expect(checkbox('General').props.checked).toBe(true); expect(checkbox('GM').props.checked).toBe(false); expect(put).toHaveBeenCalledTimes(1);
  });
});
