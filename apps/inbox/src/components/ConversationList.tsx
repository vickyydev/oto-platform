import type { ReactNode } from 'react';
import { Archive, CalendarRange, CheckCircle2, Download, Filter, Inbox, Loader2, Search, X } from 'lucide-react';
import type { InboxTab } from '@oto/shared/inbox';
import type { ConversationList as ListPage, ConversationRow, InboxMe } from '@/api/inbox';
import { Avatar, CategoryBadge, ChannelDot, ChipView, EmptyState, PILL, PILL_OFF, PILL_ON, StatusBadge } from '@/components/atoms';
import { PendingControl } from '@/components/writes';
import { sourceLabel, type SourceOption } from '@/lib/inboxes';
import { activeFilterCount, filterPills, type Filters } from '@/lib/query';
import { TAB_ICON } from '@/components/Rail';
import {
  ARCHIVE_RANGES,
  TAB_LABEL,
  WRITES_PENDING_REASON,
  assigneeChip,
  branchLabel,
  canHandle,
  categoryTitle,
  contactName,
  effectiveBranchId,
  initialsOf,
  langLabel,
  listTime,
  primaryOf,
  supportsOf,
  tintFor,
  writeMode,
} from '@/lib/view';

/**
 * The 360 px conversation list (WhatsAppDemo.tsx :1463-1630): the search,
 * "n conversations", the archive filters on the Handled tab, then the rows.
 *
 * At phone width the rail is hidden (as in the prototype, :1406), so its tabs
 * come here as a segmented row and its filters behind a Filters button — the
 * prototype's phone preview had neither, and a phone needs both.
 */
export function ConversationList({
  me,
  tab,
  strip,
  page,
  rows,
  loading,
  loadingMore,
  error,
  filters,
  search,
  selectedId,
  now,
  sources = [],
  onSearch,
  onFilters,
  onTab,
  onOpenFilters,
  onSelect,
  onAskHandle,
  onMore,
}: {
  me: InboxMe;
  tab: InboxTab;
  /** The phone's compact dashboard line (F3), rendered under the tabs; the lg dashboard is the header's card grid. */
  strip?: ReactNode;
  page: ListPage | null;
  rows: ConversationRow[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  filters: Filters;
  search: string;
  selectedId: string | null;
  now: Date;
  /** The numbers known so far, so the Source pill names its number (SCRUM-220 playbook). */
  sources?: readonly SourceOption[];
  onSearch: (q: string) => void;
  onFilters: (next: Partial<Filters>) => void;
  onTab: (t: InboxTab) => void;
  onOpenFilters: () => void;
  onSelect: (id: string) => void;
  /** The row's hover "Mark handled" (:1610-1620): opens the confirmation. */
  onAskHandle: (id: string) => void;
  onMore: () => void;
}) {
  const filterCount = activeFilterCount(filters);
  const hasStrip = strip !== undefined && strip !== null;
  const pills = filterPills(filters, me.teams, sources);
  return (
    <>
      <div className="border-b border-slate-200 dark:border-slate-800 px-4 py-3">
        {/* Phone: the rail's tabs. */}
        <div className="mb-2 flex gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-1 lg:hidden" role="tablist">
          {me.tabs.map((t) => {
            const Icon = TAB_ICON[t];
            const active = t === tab;
            const count = t !== 'handled' ? page?.tabCounts[t] : undefined;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTab(t)}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-[12px] font-medium transition ${
                  active ? 'bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="hidden h-3.5 w-3.5 shrink-0 sm:block" />
                <span className="truncate">{TAB_LABEL[t]}</span>
                {count !== undefined && (
                  <span className={`rounded-full px-1.5 text-[10px] ${active ? 'bg-white/20 dark:bg-slate-900/15' : 'bg-slate-200 dark:bg-slate-700'}`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
        {hasStrip && <div className="mb-2 lg:hidden">{strip}</div>}
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              aria-label="Search"
              placeholder="Search customers, intents…"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-2 pl-8 pr-3 text-[13px] placeholder:text-slate-400 focus:border-slate-300 dark:focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:focus:ring-slate-600"
            />
          </div>
          <button
            type="button"
            onClick={onOpenFilters}
            aria-label="Filters"
            className="relative inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-[12px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 lg:hidden"
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {filterCount > 0 && (
              <span className="rounded-full bg-slate-900 px-1.5 text-[10px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900">{filterCount}</span>
            )}
          </button>
        </div>
        {/* The applied filters as removable pills (UI round 2026-10-22, F1):
            below lg the chips are behind the Filters button, so what is
            applied says so here; at lg the rail's chips stay as they are. A
            topic's pill wears its colour, as its badge does (SCRUM-220). */}
        {pills.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {pills.map((p) => (
              <span
                key={p.key}
                className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-[11px] font-medium ring-1 ${
                  p.tint ?? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 ring-slate-200 dark:ring-slate-700'
                }`}
              >
                {p.label}
                <button
                  type="button"
                  aria-label={`Clear ${p.label}`}
                  onClick={() => onFilters(p.clear)}
                  className="rounded-full p-0.5 text-slate-400 transition hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span>
            {rows.length}
            {page?.nextCursor ? '+' : ''} conversation{rows.length === 1 ? '' : 's'}
          </span>
          {/* The unanswered toggle. The prototype's is the dashboard card
              (:1367-1375), which stays; this one is for a reader without the
              dashboard, and on a phone, where the card is far above. When the
              phone strip (F3) renders, its rose chip is the phone's toggle,
              so this pill steps back to lg and up (SCRUM-652 polish): one
              unanswered control per width. */}
          {tab !== 'handled' && (
            <button
              type="button"
              aria-pressed={filters.unanswered}
              onClick={() => onFilters({ unanswered: !filters.unanswered })}
              className={`${hasStrip ? 'hidden lg:inline-flex ' : ''}rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 transition ${
                filters.unanswered ? 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 ring-slate-200 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              Unanswered only
            </button>
          )}
        </div>
        {tab === 'handled' && (
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 p-2.5 ring-1 ring-slate-200 dark:ring-slate-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                <Archive className="h-3 w-3" /> Archive filters
              </div>
              <PendingControl
                reason="Export is not built yet"
                label="Export"
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300"
              >
                <Download className="h-3 w-3" /> Export
              </PendingControl>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-slate-500 dark:text-slate-400">
                <CalendarRange className="h-3 w-3" /> Handled in the last
              </div>
              <div className="flex flex-wrap gap-1">
                {ARCHIVE_RANGES.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={filters.archiveRange === k}
                    onClick={() => onFilters({ archiveRange: k })}
                    className={`${PILL} ${filters.archiveRange === k ? PILL_ON : PILL_OFF}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-slate-500 dark:text-slate-400">
                <CheckCircle2 className="h-3 w-3" /> Resolved by
              </div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ['', 'Anyone'],
                    ['ai', 'AI'],
                    ['human', 'Human'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k || 'all'}
                    type="button"
                    aria-pressed={filters.resolvedBy === k}
                    onClick={() => onFilters({ resolvedBy: k })}
                    className={`${PILL} ${filters.resolvedBy === k ? PILL_ON : PILL_OFF}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {error ? (
          <div className="m-4 rounded-lg bg-rose-50 dark:bg-rose-500/15 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300 ring-1 ring-rose-200 dark:ring-rose-500/30">{error}</div>
        ) : loading && rows.length === 0 ? (
          <div className="flex justify-center py-10 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Inbox} title="No conversations" subtitle="Try a different tab or filter." />
        ) : (
          <>
            {rows.map((c) => (
              <Row
                key={c.id}
                c={c}
                me={me}
                selected={c.id === selectedId}
                now={now}
                onSelect={onSelect}
                onAskHandle={onAskHandle}
              />
            ))}
            {page?.nextCursor && (
              <div className="flex justify-center p-3">
                <button
                  type="button"
                  onClick={onMore}
                  disabled={loadingMore}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white dark:bg-slate-900 px-3 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
                  More conversations
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * One row (:1556-1625, screenshot 3): a 40 px avatar with the channel dot;
 * name · the number it came in on, and time; intent · language · branch; the one-line preview; category
 * and status pills with the unread count; then the assignee chips.
 */
function Row({
  c,
  me,
  selected,
  now,
  onSelect,
  onAskHandle,
}: {
  c: ConversationRow;
  me: InboxMe;
  selected: boolean;
  now: Date;
  onSelect: (id: string) => void;
  onAskHandle: (id: string) => void;
}) {
  const name = contactName(c.contact);
  const primary = primaryOf(c);
  const supports = supportsOf(c);
  const pendingWrites = writeMode(me) === 'disabled';
  const handleHere = canHandle(c, me);
  const teamName = me.teams.find((t) => t.id === c.teamId)?.name ?? null;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(c.id);
        }
      }}
      className={`group relative block w-full cursor-pointer border-b border-slate-100 dark:border-slate-800 px-4 py-3 text-left transition ${
        selected ? 'bg-slate-50 dark:bg-slate-950/60' : 'hover:bg-slate-50/60 dark:hover:bg-slate-800/60'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="relative">
          <Avatar initials={initialsOf(name)} tint={tintFor(c.contact.id)} size={40} />
          <ChannelDot channel={c.channel} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">
              {name}
              {/* The number it came in on (SCRUM-220 playbook), not the bare channel. */}
              <span className="font-normal text-slate-400"> · {sourceLabel(c.channel, c.channelAccountName)}</span>
            </div>
            <div className="shrink-0 text-[11px] text-slate-400">{listTime(c.lastMessageAt, now)}</div>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            {c.intent && (
              <>
                <span className="truncate">{c.intent}</span>
                <span>·</span>
              </>
            )}
            <span className="uppercase tracking-wide">{langLabel(c.language)}</span>
            <span>·</span>
            <span className="truncate">{branchLabel(effectiveBranchId(c, me.teams), me.teams)}</span>
          </div>
          <div className={`mt-1 truncate text-[12.5px] ${c.unanswered ? 'text-slate-800 dark:text-slate-200' : 'text-slate-600 dark:text-slate-300'}`}>
            {c.lastMessagePreview ?? ' '}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <CategoryBadge category={c.category} title={categoryTitle(c.category, teamName)} />
            <StatusBadge status={c.status} />
            {c.unanswered && (
              <span className="inline-flex items-center rounded-full bg-rose-50 dark:bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300 ring-1 ring-rose-200 dark:ring-rose-500/30">
                Unanswered
              </span>
            )}
            {c.unread > 0 && c.status !== 'handled' && (
              <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[11px] font-semibold text-white">
                {c.unread}
              </span>
            )}
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5">
            {primary ? (
              <ChipView chip={assigneeChip(primary, me)} />
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 ring-1 ring-amber-200 dark:ring-amber-500/30">
                Unassigned
              </span>
            )}
            {supports.map((s) => (
              <ChipView key={s.assignmentId} chip={assigneeChip(s, me)} withName={false} />
            ))}
            {handleHere && pendingWrites && (
              <span className="ml-auto hidden opacity-0 transition group-hover:opacity-100 sm:inline-flex">
                <PendingControl
                  reason={WRITES_PENDING_REASON}
                  label="Mark handled"
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-200 dark:ring-emerald-500/30"
                >
                  <CheckCircle2 className="h-3 w-3" /> Mark handled
                </PendingControl>
              </span>
            )}
            {handleHere && !pendingWrites && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAskHandle(c.id);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 dark:bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 opacity-0 ring-1 ring-emerald-200 dark:ring-emerald-500/30 transition hover:bg-emerald-100 dark:hover:bg-emerald-500/25 group-hover:opacity-100 focus:opacity-100"
                title="Mark this conversation as handled"
              >
                <CheckCircle2 className="h-3 w-3" /> Mark handled
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
