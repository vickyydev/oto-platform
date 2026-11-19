import type { InboxCategoryKey, InboxTab } from '@oto/shared/inbox';
import type { ListQuery, Team } from '@/api/inbox';
import { sourceLabel, type SourceOption } from './inboxes';
import { archiveFrom, branchLabel, CATEGORY_DOT, CATEGORY_OPTIONS, LANGUAGE_OPTIONS, type ArchiveRange } from './view';

/**
 * The list's filters as the views column and the list header hold them — the
 * prototype's `filterCategory`, `filterBranch`, `filterLanguage`, `search`,
 * `unansweredOnly`, `archiveRange` and `archiveResolver` (WhatsAppDemo.tsx
 * :1036-1050) — with "all" as the empty string, and the number a
 * conversation came in on (`channelAccountId`, the Channel choice; SCRUM-220
 * named it Source). The filtering itself is the api's (`GET
 * /inbox/conversations`), on the same rules from `@oto/shared/inbox`, so a
 * page of fifty is the right fifty.
 *
 * SCRUM-1016 took the Status filter away: the tabs are the status (Mine and
 * Team hold the open conversations, Handled the closed ones), so a Status
 * chip only ever repeated the tab or emptied the list.
 */
export interface Filters {
  category: InboxCategoryKey | '';
  branchId: string;
  /** The number (channel account) the conversation came in on; '' is every number. */
  channelAccountId: string;
  /**
   * SCRUM-789: `general` is the General inbox — the general questions held
   * out of the park inboxes while the assistant answers them. Since
   * SCRUM-1016 it is one of the Topic choices, "Kept in General"; '' is
   * every conversation.
   */
  inbox: 'general' | '';
  language: string;
  q: string;
  unanswered: boolean;
  /** SCRUM-1016: the Unread quick filter — a customer line after the viewer's own read marker. */
  unread: boolean;
  /**
   * SCRUM-1016: "Hide till notices" — the check-in notice threads, which
   * cannot take a reply, left out of the list and its counts. On by default;
   * the workspace remembers the choice per browser.
   */
  hideNotices: boolean;
  archiveRange: ArchiveRange;
  resolvedBy: 'ai' | 'human' | '';
}

export const EMPTY_FILTERS: Filters = {
  category: '',
  branchId: '',
  channelAccountId: '',
  inbox: '',
  language: '',
  q: '',
  unanswered: false,
  unread: false,
  hideNotices: true,
  // The prototype's archive opens on the last thirty days (:1049).
  archiveRange: '30d',
  resolvedBy: '',
};

// --- The Topic choice ---------------------------------------------------------------

/** The Topic choices: every topic, and the General questions held out of the park inboxes. */
export type TopicChoice = InboxCategoryKey | 'held' | '';

/**
 * SCRUM-1016 folded the SCRUM-789 "General" view into Topic. It is named as
 * the timeline names it ("Kept in General · no park inbox"), so it is never
 * mistaken for the General topic, which also holds every desk's questions.
 */
export const HELD_TOPIC_LABEL = 'Kept in General';
export const HELD_TOPIC_HINT = 'General questions the assistant is answering, held out of the park inboxes';

export function topicOf(f: Pick<Filters, 'category' | 'inbox'>): TopicChoice {
  return f.inbox === 'general' ? 'held' : f.category;
}

/** Choosing a topic: one value at a time, so a topic and the held view never stand together. */
export function topicPatch(choice: TopicChoice): Pick<Filters, 'category' | 'inbox'> {
  return choice === 'held' ? { category: '', inbox: 'general' } : { category: choice, inbox: '' };
}

// --- What is applied --------------------------------------------------------------------

/**
 * How many of the Filters sheet's choices differ from "all" — the phone's
 * Filters button shows it. The quick filters, the search and "Hide till
 * notices" (on unless turned off) are not counted.
 */
export function activeFilterCount(f: Filters): number {
  return [f.category, f.branchId, f.channelAccountId, f.inbox, f.language].filter((v) => v !== '').length;
}

/** One applied filter as a removable pill: its label, and the patch that clears it — exactly that one. */
export interface FilterPill {
  key: 'category' | 'inbox' | 'branchId' | 'channelAccountId' | 'language';
  label: string;
  clear: Partial<Filters>;
  /** The topic's own dot (`CATEGORY_DOT`), so the GM queue reads amber here as in the filters. */
  dot?: string;
}

/**
 * The applied filters as removable pills by the list (UI round 2026-10-22,
 * F1; SCRUM-1016): what the Filters sheet or the views column applied says
 * so on the list itself. The labels are the ones the choices carry
 * (`FilterFields`); a number is named by its display name.
 */
export function filterPills(f: Filters, teams: readonly Team[], sources: readonly SourceOption[] = []): FilterPill[] {
  const label = (options: readonly [string, string][], v: string) => options.find(([k]) => k === v)?.[1] ?? v;
  const out: FilterPill[] = [];
  if (f.inbox !== '') out.push({ key: 'inbox', label: HELD_TOPIC_LABEL, clear: { inbox: '' }, dot: CATEGORY_DOT.general });
  if (f.category !== '') {
    out.push({ key: 'category', label: label(CATEGORY_OPTIONS, f.category), clear: { category: '' }, dot: CATEGORY_DOT[f.category] });
  }
  if (f.branchId !== '') out.push({ key: 'branchId', label: branchLabel(f.branchId, teams), clear: { branchId: '' } });
  if (f.channelAccountId !== '') {
    const source = sources.find((s) => s.id === f.channelAccountId);
    out.push({
      key: 'channelAccountId',
      label: source ? sourceLabel(source.channel, source.name) : 'Channel',
      clear: { channelAccountId: '' },
    });
  }
  if (f.language !== '') out.push({ key: 'language', label: label(LANGUAGE_OPTIONS, f.language), clear: { language: '' } });
  return out;
}

/**
 * The query for one page. The archive's range and "resolved by" apply only on
 * the Handled tab (:1071, :1478), as the route reads them.
 */
export function listQuery(
  tab: InboxTab,
  f: Filters,
  opts: { now?: Date; cursor?: string; limit?: number } = {},
): ListQuery {
  const q: ListQuery = { tab };
  if (f.category) q.category = f.category;
  if (f.branchId) q.branchId = f.branchId;
  if (f.channelAccountId) q.channelAccountId = f.channelAccountId;
  if (f.inbox) q.inbox = f.inbox;
  if (f.language) q.language = f.language;
  const search = f.q.trim();
  if (search) q.q = search;
  if (f.unanswered) q.unanswered = 'true';
  if (f.unread) q.unread = 'true';
  if (f.hideNotices) q.replyable = 'true';
  if (tab === 'handled') {
    const from = archiveFrom(f.archiveRange, opts.now);
    if (from) q.handledFrom = from;
    if (f.resolvedBy) q.resolvedBy = f.resolvedBy;
  }
  if (opts.cursor) q.cursor = opts.cursor;
  if (opts.limit) q.limit = opts.limit;
  return q;
}
