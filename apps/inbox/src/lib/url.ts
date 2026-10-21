import { INBOX_TABS, type InboxTab } from '@oto/shared/inbox';
import { ARCHIVE_RANGES, type ArchiveRange } from './view';

/**
 * The Inbox's URL state (SCRUM-591, prerequisite P2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §C) — pure, so the
 * unit tests read the real thing (test/url.test.ts).
 *
 * The Inbox has no router and needs none: it is one screen. What a link must
 * be able to say lives in the query string of that one screen:
 *
 *   /?c=<conversation id>        that conversation, open
 *   /?tab=mine|team|handled      that tab (left out when it is the viewer's default)
 *   /?unanswered=1               the unanswered queue: the list's unanswered toggle on
 *   /?tab=handled&range=7d&by=ai the archive's filters (test night 2026-10-21, U11)
 *   /?settings=templates|assistant  a settings page, in place of the workspace (U11)
 *   /?settings=assistant&section=numbers|knowledge|examples  that assistant tab
 *       (UI round 2026-10-22, F2; its own param since the SCRUM-652 polish — the
 *       first release spelt it `tab=`, which is still read under
 *       settings=assistant for one release so saved links keep working)
 *
 * The plan's own spelling of the queue, `/?tab=unanswered`, is read too, as the
 * same thing: unanswered is a filter on the list, not a fourth tab.
 *
 * Everything else the workspace holds — the other filters, the search box,
 * the open dialogs — stays out of the URL on purpose. A link is "this
 * conversation", "this queue" or "this page", not a saved screen.
 */
export type SettingsPage = 'templates' | 'assistant';
/** The assistant page's tabs (owner UI round 2026-10-22, F2): `?settings=assistant&section=…`. */
export type AssistantTab = 'numbers' | 'knowledge' | 'examples';
export type ResolvedBy = 'ai' | 'human';

export interface InboxUrlState {
  tab: InboxTab | null;
  conversationId: string | null;
  unanswered: boolean;
  settings: SettingsPage | null;
  /** The assistant page's tab, from `section=` (legacy links spelt it `tab=`; read for one release). */
  assistantTab: AssistantTab | null;
  archiveRange: ArchiveRange | null;
  resolvedBy: ResolvedBy | null;
}

/** A conversation id is a UUID; anything else is not worth asking the api about. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isTab = (v: string | null): v is InboxTab => v !== null && (INBOX_TABS as readonly string[]).includes(v);
const isSettings = (v: string | null): v is SettingsPage => v === 'templates' || v === 'assistant';
const isAssistantTab = (v: string | null): v is AssistantTab => v === 'numbers' || v === 'knowledge' || v === 'examples';
const isRange = (v: string | null): v is ArchiveRange => v !== null && ARCHIVE_RANGES.some(([k]) => k === v);
const isResolvedBy = (v: string | null): v is ResolvedBy => v === 'ai' || v === 'human';

/** What a query string asks for, with anything malformed dropped. */
export function readInboxUrl(search: string): InboxUrlState {
  const q = new URLSearchParams(search);
  const rawTab = q.get('tab');
  const rawId = q.get('c');
  const rawUnanswered = q.get('unanswered');
  const rawSettings = q.get('settings');
  const rawSection = q.get('section');
  const rawRange = q.get('range');
  const rawBy = q.get('by');
  return {
    tab: isTab(rawTab) ? rawTab : null,
    conversationId: rawId !== null && UUID.test(rawId) ? rawId.toLowerCase() : null,
    unanswered: rawTab === 'unanswered' || rawUnanswered === '1' || rawUnanswered === 'true',
    settings: isSettings(rawSettings) ? rawSettings : null,
    // `section=` is the assistant tab's own param (SCRUM-652 polish). The old
    // spelling reused `tab=`; it is read for one release, and only under
    // settings=assistant, so a plain `tab=` stays the inbox tab's.
    assistantTab: isAssistantTab(rawSection)
      ? rawSection
      : rawSettings === 'assistant' && isAssistantTab(rawTab)
        ? rawTab
        : null,
    archiveRange: isRange(rawRange) ? rawRange : null,
    resolvedBy: isResolvedBy(rawBy) ? rawBy : null,
  };
}

/** The view a URL opens for this viewer: a tab they do not have is their default. */
export interface InboxUrlView {
  tab: InboxTab;
  unanswered: boolean;
  selectedId: string | null;
  /** On a phone, a linked conversation opens straight onto the thread. */
  showChat: boolean;
  /** A settings page the viewer may open; null for the workspace. */
  settings: SettingsPage | null;
  /** The assistant page's tab; null off that page, and for its default (the first the viewer may see). */
  assistantTab: AssistantTab | null;
  /** The archive's filters, when the link names them. */
  archiveRange: ArchiveRange | null;
  resolvedBy: ResolvedBy | null;
  /**
   * The address named nothing: a plain landing, where the workspace decides
   * the tab for itself (`landingTab`) rather than the link.
   */
  plain: boolean;
}

/** Which settings pages this viewer may open (`/inbox/me` capabilities). */
export interface SettingsAllowed {
  templates: boolean;
  assistant: boolean;
}

const ALL_SETTINGS: SettingsAllowed = { templates: true, assistant: true };

export function viewFromUrl(
  search: string,
  tabs: readonly InboxTab[],
  fallback: InboxTab,
  allowed: SettingsAllowed = ALL_SETTINGS,
): InboxUrlView {
  const url = readInboxUrl(search);
  const tab = url.tab !== null && tabs.includes(url.tab) ? url.tab : fallback;
  // The queue is the open conversations; the archive has no "unanswered".
  const unanswered = url.unanswered && tab !== 'handled';
  const settings = url.settings !== null && allowed[url.settings] ? url.settings : null;
  // The assistant's tab belongs to the assistant page.
  const assistantTab = settings === 'assistant' ? url.assistantTab : null;
  // The archive's filters belong to the archive.
  const archiveRange = tab === 'handled' ? url.archiveRange : null;
  const resolvedBy = tab === 'handled' ? url.resolvedBy : null;
  const plain =
    url.tab === null && url.conversationId === null && !url.unanswered && url.settings === null;
  return {
    tab,
    unanswered,
    selectedId: url.conversationId,
    showChat: url.conversationId !== null,
    settings,
    assistantTab,
    archiveRange,
    resolvedBy,
    plain,
  };
}

/** What `inboxSearch` writes; the archive's filters and the settings page are optional so a plain view needs no more than before. */
export interface InboxUrlInput {
  tab: InboxTab;
  unanswered: boolean;
  selectedId: string | null;
  settings?: SettingsPage | null;
  /** Written as `section=`, only with `settings: 'assistant'`; null (the page's default tab) writes nothing. */
  assistantTab?: AssistantTab | null;
  /** Written only on the archive, and only off its default (30 days). */
  archiveRange?: ArchiveRange;
  resolvedBy?: ResolvedBy | '';
}

/** The archive's default range (`EMPTY_FILTERS.archiveRange`): the plain archive address names no range. */
export const DEFAULT_ARCHIVE_RANGE: ArchiveRange = '30d';

/**
 * The query string for a view, '' when it is the plain home. The order is
 * fixed so the same view always writes the same address — which is how the
 * workspace knows it has nothing to write.
 */
export function inboxSearch(view: InboxUrlInput, fallback: InboxTab): string {
  const q = new URLSearchParams();
  if (view.tab !== fallback) q.set('tab', view.tab);
  if (view.tab === 'handled') {
    if (view.archiveRange && view.archiveRange !== DEFAULT_ARCHIVE_RANGE) q.set('range', view.archiveRange);
    if (view.resolvedBy) q.set('by', view.resolvedBy);
  }
  if (view.unanswered && view.tab !== 'handled') q.set('unanswered', '1');
  if (view.selectedId) q.set('c', view.selectedId);
  if (view.settings) q.set('settings', view.settings);
  // The assistant page's tab has its own param (SCRUM-652 polish), so the
  // inbox tab keeps `tab=` and survives Back off the page.
  if (view.settings === 'assistant' && view.assistantTab) q.set('section', view.assistantTab);
  const s = q.toString();
  return s ? `?${s}` : '';
}
