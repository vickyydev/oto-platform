import { describe, expect, it } from 'vitest';
import { buildSuiteScreenPath, SUITE_SCREENS, type SuiteScreen } from '@oto/shared';
import type { InboxTab } from '@oto/shared/inbox';
import { inboxSearch, readInboxUrl, viewFromUrl } from '@/lib/url';

/**
 * SCRUM-591 prerequisite P2 — the Inbox's URL state: the tab, the unanswered
 * queue and the open conversation reflect into the query string and come back
 * from it on load, and the deep-link map's Inbox entries are read back through
 * the same reader (the census), so a link the assistant offers always opens
 * what it says.
 */

const ID = '0192f0a0-1234-7abc-8def-0123456789ab';
const AGENT: InboxTab[] = ['mine', 'team', 'handled'];
const RECEPTION: InboxTab[] = ['team', 'handled'];

describe('reflecting the view into the URL', () => {
  it('writes nothing for the plain home', () => {
    expect(inboxSearch({ tab: 'team', unanswered: false, selectedId: null }, 'team')).toBe('');
  });

  it('writes the selected conversation, a non-default tab and the queue', () => {
    expect(inboxSearch({ tab: 'team', unanswered: false, selectedId: ID }, 'team')).toBe(`?c=${ID}`);
    expect(inboxSearch({ tab: 'mine', unanswered: false, selectedId: null }, 'team')).toBe('?tab=mine');
    expect(inboxSearch({ tab: 'team', unanswered: true, selectedId: ID }, 'team')).toBe(`?unanswered=1&c=${ID}`);
    // The archive has no unanswered toggle, so the URL does not claim one.
    expect(inboxSearch({ tab: 'handled', unanswered: true, selectedId: null }, 'team')).toBe('?tab=handled');
  });

  it('round-trips through the reader', () => {
    for (const view of [
      { tab: 'mine' as const, unanswered: true, selectedId: ID },
      { tab: 'handled' as const, unanswered: false, selectedId: ID },
      { tab: 'team' as const, unanswered: false, selectedId: null },
    ]) {
      const back = viewFromUrl(inboxSearch(view, 'team'), AGENT, 'team');
      expect(back).toEqual({ ...view, showChat: view.selectedId !== null });
    }
  });
});

describe('restoring the view on load', () => {
  it('opens a linked conversation straight onto the thread', () => {
    expect(viewFromUrl(`?c=${ID}`, AGENT, 'team')).toEqual({ tab: 'team', unanswered: false, selectedId: ID, showChat: true });
  });

  it('reads the plan spelling of the queue, /?tab=unanswered, as the unanswered filter', () => {
    expect(viewFromUrl('?tab=unanswered', RECEPTION, 'team')).toEqual({
      tab: 'team',
      unanswered: true,
      selectedId: null,
      showChat: false,
    });
  });

  it('gives a tab the viewer does not have as their default', () => {
    expect(viewFromUrl('?tab=mine', RECEPTION, 'team').tab).toBe('team');
    expect(viewFromUrl('?tab=nonsense', AGENT, 'team').tab).toBe('team');
  });

  it.each([
    ['not a uuid', '?c=e-123'],
    ['an injection attempt', `?c=${ID}%26tab%3Dhandled`],
    ['a path', '?c=../admin'],
    ['empty', '?c='],
  ])('degrades a bad id (%s) to the list', (_, search) => {
    const view = viewFromUrl(search, AGENT, 'team');
    expect(view.selectedId).toBeNull();
    expect(view.showChat).toBe(false);
  });

  it('lower-cases an id, as the api writes them', () => {
    expect(readInboxUrl(`?c=${ID.toUpperCase()}`).conversationId).toBe(ID);
  });
});

describe('the deep-link map against the Inbox (census)', () => {
  const inboxScreens = (SUITE_SCREENS as readonly SuiteScreen[]).filter((s) => s.app === 'inbox');

  it('has the two entries P2 unblocks, each on the one screen the Inbox has', () => {
    expect(inboxScreens.map((s) => s.key).sort()).toEqual(['inbox.queue', 'inbox.thread']);
    for (const s of inboxScreens) expect(s.path, s.key).toBe('/');
  });

  it('opens a linked conversation through the same reader', () => {
    const path = buildSuiteScreenPath('inbox.thread', { c: ID })!;
    const view = viewFromUrl(path.slice(path.indexOf('?')), AGENT, 'team');
    expect(view.selectedId).toBe(ID);
    expect(view.showChat).toBe(true);
  });

  it('opens the unanswered queue through the same reader, for every role', () => {
    const path = buildSuiteScreenPath('inbox.queue')!;
    for (const tabs of [AGENT, RECEPTION]) {
      const view = viewFromUrl(path.slice(path.indexOf('?')), tabs, 'team');
      expect(view.unanswered).toBe(true);
      expect(view.tab).toBe('team');
    }
  });
});
