import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMe } from '@/api/inbox';
import { useInboxAccess } from '@/hooks/useInboxAccess';
import { channelChoices, inboxAccessSignature, inboxFiltersWithinAccess, inboxItemWithinAccess, inboxMeWithinAccess, inboxSourcesWithinAccess, topicChoices, type SourceOption } from '@/lib/inboxes';
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
  // SCRUM-1016: the named views became Topic and Channel choices (General is
  // "Kept in General", a test line its own Channel choice), under the same limits.
  it('hides Topic choices and test-line Channel choices under the same limits', () => {
    const me = { testLines: [{ id: 'allowed', channel: 'whatsapp', displayName: 'ZZ TEST allowed' }, { id: 'excluded', channel: 'whatsapp', displayName: 'ZZ TEST excluded' }], access: restricted } as Pick<InboxMe, 'testLines' | 'access'>;
    expect(topicChoices(restricted)).toEqual(['general', 'held']);
    expect(topicChoices(unrestricted)).toEqual(['birthdays', 'general', 'marketing', 'gm', 'held']);
    expect(topicChoices({ ...restricted, categories: ['birthdays'] })).toEqual(['birthdays']);
    expect(topicChoices({ ...restricted, categories: [] })).toEqual([]);
    expect(channelChoices([], me).map(choice => choice.id)).toEqual(['allowed']);
    expect(channelChoices([], { ...me, access: { ...restricted, categories: [], channelAccountIds: null } })).toEqual([]);
  });
  it('removes stale simulator/contact choices immediately and waits for matching server identity before restoring contact creation', () => {
    const lines = [{ id: 'allowed', channel: 'whatsapp', displayName: 'ZZ TEST allowed', branchId: null }, { id: 'excluded', channel: 'line', displayName: 'ZZ TEST excluded', branchId: null }];
    const me = { access: unrestricted, teams: [{ kind: 'birthdays' }, { kind: 'reception' }], testLines: lines,
      simulator: { channelAccounts: lines }, contactChannels: lines, defaultReceptionBranchId: 'park' } as InboxMe;
    const pending = inboxMeWithinAccess(me, restricted);
    expect(pending.simulator!.channelAccounts.map(line => line.id)).toEqual(['allowed']);
    expect(pending.testLines!.map(line => line.id)).toEqual(['allowed']); expect(pending.teams.map(team => team.kind)).toEqual(['reception']);
    expect(pending.contactChannels).toEqual([]);
    expect(inboxMeWithinAccess({ ...me, access: restricted }, restricted).contactChannels!.map(line => line.id)).toEqual(['allowed']);
    expect(inboxMeWithinAccess(me, { ...restricted, categories: [] })).toMatchObject({ teams: [], testLines: [], simulator: { channelAccounts: [] }, contactChannels: [], defaultReceptionBranchId: null });
  });
  it('reloads identity once per distinct mismatch even when equivalent objects keep arriving', () => {
    const reload = vi.fn(async () => undefined);
    const hook = renderHook<{ page: Access; identity: Access }, Access>(({ page, identity }) => useInboxAccess(page, identity, reload), { page: restricted, identity: unrestricted }); cleanup = hook.unmount;
    for (let i = 0; i < 8; i++) hook.rerender({ page: { ...restricted }, identity: { ...unrestricted } });
    expect(reload).toHaveBeenCalledTimes(1); expect(hook.result.current).toEqual(restricted);
    hook.rerender({ page: restricted, identity: restricted });
    expect(reload).toHaveBeenCalledTimes(1);
    hook.rerender({ page: { ...restricted, version: 2, categories: [] }, identity: restricted });
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it('a newer identity policy wins immediately over an old page and survives list reset or out-of-order completion', () => {
    const reload = vi.fn(async () => undefined);
    const hook = renderHook<{ page: Access; identity: Access }, Access>(({ page, identity }) => useInboxAccess(page, identity, reload), { page: unrestricted, identity: restricted }); cleanup = hook.unmount;
    expect(hook.result.current).toEqual(restricted); expect(reload).not.toHaveBeenCalled();
    hook.rerender({ page: undefined, identity: unrestricted }); expect(hook.result.current).toEqual(restricted);
    hook.rerender({ page: unrestricted, identity: unrestricted }); expect(hook.result.current).toEqual(restricted);
    expect(inboxSourcesWithinAccess([{ id: 'excluded', channel: 'line', name: 'ZZ TEST excluded' }], hook.result.current)).toEqual([]);
  });
  it('normalizes reordered policy values so polling does not erase the selected workspace', () => {
    expect(inboxAccessSignature({ version: 1, categories: ['general', 'gm'], channelAccountIds: ['b', 'a'] }))
      .toBe(inboxAccessSignature({ version: 1, categories: ['gm', 'general'], channelAccountIds: ['a', 'b'] }));
  });
  it('equal-version administrator revocation cannot restore stale unrestricted cache and reload remains bounded', () => {
    const reload = vi.fn(async () => undefined), oldAdmin = { ...unrestricted, version: 1 };
    const hook = renderHook<{ page: Access; identity: Access }, Access>(({ page, identity }) => useInboxAccess(page, identity, reload), { page: oldAdmin, identity: oldAdmin }); cleanup = hook.unmount;
    hook.rerender({ page: oldAdmin, identity: restricted });
    expect(hook.result.current).toEqual(restricted);
    for (let i = 0; i < 6; i++) hook.rerender({ page: { ...oldAdmin }, identity: { ...restricted } });
    expect(hook.result.current).toEqual(restricted); expect(reload).toHaveBeenCalledTimes(1);
    hook.rerender({ page: undefined, identity: restricted }); expect(hook.result.current).toEqual(restricted);
    hook.rerender({ page: restricted, identity: restricted }); expect(hook.result.current).toEqual(restricted);
    // An explicit grant can expand again when both fresh server reads agree.
    hook.rerender({ page: oldAdmin, identity: restricted }); expect(hook.result.current).toEqual(restricted);
    hook.rerender({ page: oldAdmin, identity: { ...oldAdmin } }); expect(hook.result.current).toEqual(restricted);
    hook.rerender({ page: { ...oldAdmin }, identity: { ...oldAdmin } }); expect(hook.result.current).toEqual(oldAdmin);
  });
});
