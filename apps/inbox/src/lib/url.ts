import { INBOX_TABS, type InboxTab } from '@oto/shared/inbox';

/**
 * The Inbox's URL state (SCRUM-591, prerequisite P2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §C) — pure, so the
 * unit tests read the real thing (test/url.test.ts).
 *
 * The Inbox has no router and needs none: it is one screen. What a link must
 * be able to say lives in the query string of that one screen:
 *
 *   /?c=<conversation id>     that conversation, open
 *   /?tab=mine|team|handled   that tab (left out when it is the viewer's default)
 *   /?unanswered=1            the unanswered queue: the list's unanswered toggle on
 *
 * The plan's own spelling of the queue, `/?tab=unanswered`, is read too, as the
 * same thing: unanswered is a filter on the list, not a fourth tab.
 *
 * Everything else the workspace holds — the other filters, the search box,
 * the open dialogs, the settings page — stays out of the URL on purpose. A
 * link is "this conversation" or "this queue", not a saved screen.
 */
export interface InboxUrlState {
  tab: InboxTab | null;
  conversationId: string | null;
  unanswered: boolean;
}

/** A conversation id is a UUID; anything else is not worth asking the api about. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isTab = (v: string | null): v is InboxTab => v !== null && (INBOX_TABS as readonly string[]).includes(v);

/** What a query string asks for, with anything malformed dropped. */
export function readInboxUrl(search: string): InboxUrlState {
  const q = new URLSearchParams(search);
  const rawTab = q.get('tab');
  const rawId = q.get('c');
  const rawUnanswered = q.get('unanswered');
  return {
    tab: isTab(rawTab) ? rawTab : null,
    conversationId: rawId !== null && UUID.test(rawId) ? rawId.toLowerCase() : null,
    unanswered: rawTab === 'unanswered' || rawUnanswered === '1' || rawUnanswered === 'true',
  };
}

/** The view a URL opens for this viewer: a tab they do not have is their default. */
export interface InboxUrlView {
  tab: InboxTab;
  unanswered: boolean;
  selectedId: string | null;
  /** On a phone, a linked conversation opens straight onto the thread. */
  showChat: boolean;
}

export function viewFromUrl(search: string, tabs: readonly InboxTab[], fallback: InboxTab): InboxUrlView {
  const url = readInboxUrl(search);
  const tab = url.tab !== null && tabs.includes(url.tab) ? url.tab : fallback;
  // The queue is the open conversations; the archive has no "unanswered".
  const unanswered = url.unanswered && tab !== 'handled';
  return { tab, unanswered, selectedId: url.conversationId, showChat: url.conversationId !== null };
}

/**
 * The query string for a view, '' when it is the plain home. The order is
 * fixed so the same view always writes the same address — which is how the
 * workspace knows it has nothing to write.
 */
export function inboxSearch(view: { tab: InboxTab; unanswered: boolean; selectedId: string | null }, fallback: InboxTab): string {
  const q = new URLSearchParams();
  if (view.tab !== fallback) q.set('tab', view.tab);
  if (view.unanswered && view.tab !== 'handled') q.set('unanswered', '1');
  if (view.selectedId) q.set('c', view.selectedId);
  const s = q.toString();
  return s ? `?${s}` : '';
}
