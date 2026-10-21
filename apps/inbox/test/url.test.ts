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
/** What a view carries when the address names no settings page, no archive filter, and is not a plain landing. */
const REST = { settings: null, assistantTab: null, archiveRange: null, resolvedBy: null, plain: false } as const;

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
      const search = inboxSearch(view, 'team');
      const back = viewFromUrl(search, AGENT, 'team');
      // The plain home names nothing, so it comes back as a plain landing.
      expect(back).toEqual({ ...view, showChat: view.selectedId !== null, ...REST, plain: search === '' });
    }
  });
});

describe('the settings pages and the archive filters in the address (test night 2026-10-21, U11)', () => {
  it('writes a settings page, and reads it back only for a viewer who may open it', () => {
    expect(inboxSearch({ tab: 'team', unanswered: false, selectedId: null, settings: 'assistant' }, 'team')).toBe('?settings=assistant');
    expect(inboxSearch({ tab: 'mine', unanswered: false, selectedId: ID, settings: 'templates' }, 'team')).toBe(
      `?tab=mine&c=${ID}&settings=templates`,
    );
    expect(viewFromUrl('?settings=assistant', AGENT, 'team').settings).toBe('assistant');
    expect(viewFromUrl('?settings=templates', AGENT, 'team', { templates: true, assistant: false }).settings).toBe('templates');
    expect(viewFromUrl('?settings=assistant', AGENT, 'team', { templates: true, assistant: false }).settings).toBeNull();
    expect(viewFromUrl('?settings=nonsense', AGENT, 'team').settings).toBeNull();
  });

  it('writes the archive filters on the Handled tab only, leaving the default range out', () => {
    expect(inboxSearch({ tab: 'handled', unanswered: false, selectedId: null, archiveRange: '7d', resolvedBy: 'ai' }, 'team')).toBe(
      '?tab=handled&range=7d&by=ai',
    );
    expect(inboxSearch({ tab: 'handled', unanswered: false, selectedId: null, archiveRange: '30d', resolvedBy: '' }, 'team')).toBe(
      '?tab=handled',
    );
    expect(inboxSearch({ tab: 'team', unanswered: false, selectedId: null, archiveRange: '7d', resolvedBy: 'ai' }, 'team')).toBe('');
  });

  it('reads the archive filters back, on the archive only, dropping anything malformed', () => {
    expect(viewFromUrl('?tab=handled&range=7d&by=human', AGENT, 'team')).toEqual({
      tab: 'handled',
      unanswered: false,
      selectedId: null,
      showChat: false,
      settings: null,
      assistantTab: null,
      archiveRange: '7d',
      resolvedBy: 'human',
      plain: false,
    });
    expect(viewFromUrl('?range=7d&by=ai', AGENT, 'team')).toMatchObject({ tab: 'team', archiveRange: null, resolvedBy: null });
    expect(viewFromUrl('?tab=handled&range=99d&by=robot', AGENT, 'team')).toMatchObject({ archiveRange: null, resolvedBy: null });
  });

  it('round-trips the archive view', () => {
    const view = { tab: 'handled' as const, unanswered: false, selectedId: ID, archiveRange: '90d' as const, resolvedBy: 'ai' as const };
    expect(viewFromUrl(inboxSearch(view, 'team'), AGENT, 'team')).toEqual({
      tab: 'handled',
      unanswered: false,
      selectedId: ID,
      showChat: true,
      settings: null,
      assistantTab: null,
      archiveRange: '90d',
      resolvedBy: 'ai',
      plain: false,
    });
  });
});

describe("the assistant page's tab in the address (owner UI round 2026-10-22, F2)", () => {
  it('writes the tab only on the assistant page, reusing tab=', () => {
    expect(inboxSearch({ tab: 'team', unanswered: false, selectedId: null, settings: 'assistant', assistantTab: 'knowledge' }, 'team')).toBe(
      '?tab=knowledge&settings=assistant',
    );
    // The default tab (null) writes nothing, like the other defaults.
    expect(inboxSearch({ tab: 'team', unanswered: false, selectedId: null, settings: 'assistant', assistantTab: null }, 'team')).toBe(
      '?settings=assistant',
    );
    // Off the assistant page the assistant tab is not written.
    expect(inboxSearch({ tab: 'team', unanswered: false, selectedId: null, settings: 'templates', assistantTab: 'examples' }, 'team')).toBe(
      '?settings=templates',
    );
  });

  it('reads it back on the assistant page only, dropping anything malformed', () => {
    expect(viewFromUrl('?settings=assistant&tab=numbers', AGENT, 'team').assistantTab).toBe('numbers');
    expect(viewFromUrl('?settings=assistant&tab=examples', AGENT, 'team').assistantTab).toBe('examples');
    expect(viewFromUrl('?settings=assistant', AGENT, 'team').assistantTab).toBeNull();
    expect(viewFromUrl('?settings=assistant&tab=nonsense', AGENT, 'team').assistantTab).toBeNull();
    expect(viewFromUrl('?tab=knowledge', AGENT, 'team').assistantTab).toBeNull();
    // A viewer who may not open the page gets neither the page nor its tab.
    expect(viewFromUrl('?settings=assistant&tab=numbers', AGENT, 'team', { templates: true, assistant: false })).toMatchObject({
      settings: null,
      assistantTab: null,
    });
    // The assistant tab never collides with the inbox tabs: the inbox tab falls back.
    expect(viewFromUrl('?settings=assistant&tab=knowledge', AGENT, 'team').tab).toBe('team');
  });

  it('round-trips', () => {
    for (const assistantTab of ['numbers', 'knowledge', 'examples'] as const) {
      const search = inboxSearch({ tab: 'team', unanswered: false, selectedId: null, settings: 'assistant', assistantTab }, 'team');
      const back = viewFromUrl(search, AGENT, 'team');
      expect(back.settings).toBe('assistant');
      expect(back.assistantTab).toBe(assistantTab);
    }
  });
});

describe('a plain landing (test night U8)', () => {
  it('is an address that names nothing — the workspace then picks the tab itself', () => {
    expect(viewFromUrl('', AGENT, 'team').plain).toBe(true);
    expect(viewFromUrl('?', AGENT, 'team').plain).toBe(true);
    expect(viewFromUrl('?tab=team', AGENT, 'team').plain).toBe(false);
    expect(viewFromUrl('?unanswered=1', AGENT, 'team').plain).toBe(false);
    expect(viewFromUrl(`?c=${ID}`, AGENT, 'team').plain).toBe(false);
    expect(viewFromUrl('?settings=templates', AGENT, 'team').plain).toBe(false);
  });
});

describe('restoring the view on load', () => {
  it('opens a linked conversation straight onto the thread', () => {
    expect(viewFromUrl(`?c=${ID}`, AGENT, 'team')).toEqual({ tab: 'team', unanswered: false, selectedId: ID, showChat: true, ...REST });
  });

  it('reads the plan spelling of the queue, /?tab=unanswered, as the unanswered filter', () => {
    expect(viewFromUrl('?tab=unanswered', RECEPTION, 'team')).toEqual({
      tab: 'team',
      unanswered: true,
      selectedId: null,
      showChat: false,
      ...REST,
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
