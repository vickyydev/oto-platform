import type { InboxCategoryKey, InboxStatusKey, InboxTab } from '@oto/shared/inbox';
import type { ListQuery } from '@/api/inbox';
import { archiveFrom, type ArchiveRange } from './view';

/**
 * The list's filters as the rail and the list header hold them — the
 * prototype's `filterCategory`, `filterBranch`, `filterStatus`,
 * `filterLanguage`, `search`, `unansweredOnly`, `archiveRange` and
 * `archiveResolver` (WhatsAppDemo.tsx :1036-1050) — with "all" as the empty
 * string. The filtering itself is the api's (`GET /inbox/conversations`), on
 * the same rules from `@oto/shared/inbox`, so a page of fifty is the right
 * fifty.
 */
export interface Filters {
  category: InboxCategoryKey | '';
  branchId: string;
  status: InboxStatusKey | '';
  language: string;
  q: string;
  unanswered: boolean;
  archiveRange: ArchiveRange;
  resolvedBy: 'ai' | 'human' | '';
}

export const EMPTY_FILTERS: Filters = {
  category: '',
  branchId: '',
  status: '',
  language: '',
  q: '',
  unanswered: false,
  // The prototype's archive opens on the last thirty days (:1049).
  archiveRange: '30d',
  resolvedBy: '',
};

/** How many filters differ from the empty set — the phone's filter button shows it. */
export function activeFilterCount(f: Filters): number {
  return [f.category, f.branchId, f.status, f.language].filter((v) => v !== '').length;
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
  if (f.status) q.status = f.status;
  if (f.language) q.language = f.language;
  const search = f.q.trim();
  if (search) q.q = search;
  if (f.unanswered) q.unanswered = 'true';
  if (tab === 'handled') {
    const from = archiveFrom(f.archiveRange, opts.now);
    if (from) q.handledFrom = from;
    if (f.resolvedBy) q.resolvedBy = f.resolvedBy;
  }
  if (opts.cursor) q.cursor = opts.cursor;
  if (opts.limit) q.limit = opts.limit;
  return q;
}
