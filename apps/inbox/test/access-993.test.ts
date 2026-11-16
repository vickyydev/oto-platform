import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMe } from '@/api/inbox';
import { useInboxAccess } from '@/hooks/useInboxAccess';
import { inboxAccessSignature, inboxFiltersWithinAccess, inboxItemWithinAccess, inboxSourcesWithinAccess, namedViews, type SourceOption } from '@/lib/inboxes';
import { EMPTY_FILTERS } from '@/lib/query';
import { renderHook } from '../../pos/test/support/hooks';

vi.mock('react', () => import('../../pos/test/support/hooks'));
type Access = InboxMe['access'];
const unrestricted: Access = { categories: null, channelAccountIds: null, version: 0 };
const restricted: Access = { categories: ['general'], channelAccountIds: ['allowed'], version: 1 };
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });
describe('SCRUM-993 cached Inbox boundary state', () => {
  it('prunes excluded learned source names, preserves source order and treats explicit empty lists as none', () => {
    const sources: SourceOption[] = [{ id: 'excluded', channel: 'whatsapp', name: 'ZZ TEST secret source' }, { id: 'allowed', channel: 'line', name: 'ZZ TEST visible source' }];
    expect(inboxSourcesWithinAccess(sources, restricted)).toEqual([sources[1]]);
    expect(inboxSourcesWithinAccess(sources, unrestricted)).toEqual(sources);
    expect(inboxSourcesWithinAccess(sources, { ...restricted, categories: [] })).toEqual([]);
    expect(inboxSourcesWithinAccess(sources, { ...restricted, channelAccountIds: [] })).toEqual([]);
  });
  it('drops forbidden filters and thread rows while keeping permitted independent filters', () => {
    const filters = { ...EMPTY_FILTERS, category: 'birthdays' as const, channelAccountId: 'excluded', language: 'en', q: 'ZZ TEST search' };
    expect(inboxFiltersWithinAccess(filters, restricted)).toEqual({ ...filters, category: '', channelAccountId: '' });
    expect(inboxFiltersWithinAccess(filters, unrestricted)).toBe(filters);
    expect(inboxItemWithinAccess({ category: 'birthdays', channelAccountId: 'allowed' }, restricted)).toBe(false);
    expect(inboxItemWithinAccess({ category: 'general', channelAccountId: 'excluded' }, restricted)).toBe(false);
    expect(inboxItemWithinAccess({ category: 'general', channelAccountId: 'allowed' }, restricted)).toBe(true);
  });
  it('hides named category and test-line views under the same limits', () => {
    const me = { teams: [{ kind: 'birthdays' }, { kind: 'gm' }], testLines: [{ id: 'allowed', displayName: 'ZZ TEST allowed' }, { id: 'excluded', displayName: 'ZZ TEST excluded' }], access: restricted } as Pick<InboxMe, 'teams' | 'testLines' | 'access'>;
    expect(namedViews(me).map(view => view.key)).toEqual(['all', 'general', 'line:allowed']);
    expect(namedViews({ ...me, access: { ...restricted, categories: [], channelAccountIds: null } }).map(view => view.key)).toEqual(['all']);
  });
  it('reloads identity once per distinct mismatch even when equivalent objects keep arriving', () => {
    const reload = vi.fn(async () => undefined);
    const hook = renderHook(({ page, identity }: { page: Access; identity: Access }) => useInboxAccess(page, identity, reload), { page: restricted, identity: unrestricted }); cleanup = hook.unmount;
    for (let i = 0; i < 8; i++) hook.rerender({ page: { ...restricted }, identity: { ...unrestricted } });
    expect(reload).toHaveBeenCalledTimes(1); expect(hook.result.current).toEqual(restricted);
    hook.rerender({ page: restricted, identity: restricted });
    expect(reload).toHaveBeenCalledTimes(1);
    hook.rerender({ page: { ...restricted, version: 2, categories: [] }, identity: restricted });
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it('a newer identity policy wins immediately over an old page and survives list reset or out-of-order completion', () => {
    const reload = vi.fn(async () => undefined);
    const hook = renderHook(({ page, identity }: { page: Access; identity: Access }) => useInboxAccess(page, identity, reload), { page: unrestricted, identity: restricted }); cleanup = hook.unmount;
    expect(hook.result.current).toEqual(restricted); expect(reload).not.toHaveBeenCalled();
    hook.rerender({ page: undefined, identity: unrestricted }); expect(hook.result.current).toEqual(restricted);
    hook.rerender({ page: unrestricted, identity: unrestricted }); expect(hook.result.current).toEqual(restricted);
    expect(inboxSourcesWithinAccess([{ id: 'excluded', channel: 'line', name: 'ZZ TEST excluded' }], hook.result.current)).toEqual([]);
  });
  it('normalizes reordered policy values so polling does not erase the selected workspace', () => {
    expect(inboxAccessSignature({ version: 1, categories: ['general', 'gm'], channelAccountIds: ['b', 'a'] }))
      .toBe(inboxAccessSignature({ version: 1, categories: ['gm', 'general'], channelAccountIds: ['a', 'b'] }));
  });
});
