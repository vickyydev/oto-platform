import type { ReactNode } from 'react';
import { Archive, CalendarRange, CheckCircle2, Download, Filter, Inbox, Loader2, Search, UserPlus, X } from 'lucide-react';
import type { InboxTab } from '@oto/shared/inbox';
import type { ConversationList as ListPage, ConversationRow, InboxMe } from '@/api/inbox';
import { Avatar, CategoryBadge, ChannelDot, ChipView, EmptyState, PILL, PILL_OFF, PILL_ON, StatusBadge } from '@/components/atoms';
import { PendingControl } from '@/components/writes';
import { NEW_CONTACT_LABEL } from '@/lib/contacts';
import { sourceLabel, type SourceOption } from '@/lib/inboxes';
import { activeFilterCount, filterPills, type Filters } from '@/lib/query';
import {
  conversationRowColour,
  DEPOSIT_SIGNAL_COLOURS,
  DEPOSIT_SIGNAL_LABELS,
  isReadyToBook,
  NEXT_ACTION_COLOURS,
  NEXT_ACTION_LABELS,
  READY_TO_BOOK_LABEL,
} from '@/lib/list-state';
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
  onNewContact,
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
  /** SCRUM-860: "New contact" beside the search, for a viewer the api lets create one; absent otherwise. */
  onNewContact?: () => void;
}) {
  const filterCount = activeFilterCount(filters);
  const hasStrip = strip !== undefined && strip !== null;
  const pills = filterPills(filters, me.teams, sources);
  // SCRUM-996, owner choice 1: the paid chats pinned above the list in their
  // own last-activity order; everything else keeps the list's order below.
  const readyToBook = rows.filter((c) => isReadyToBook(c.depositSignal));
  const rest = readyToBook.length > 0 ? rows.filter((c) => !isReadyToBook(c.depositSignal)) : rows;
  const rowOf = (c: ConversationRow) => (
    <Row key={c.id} c={c} me={me} selected={c.id === selectedId} now={now} onSelect={onSelect} onAskHandle={onAskHandle} />
  );
  return (
    <>
      <div className="border-b border-line px-4 py-3">
        {/* Phone: the rail's tabs. */}
        <div className="mb-2 flex gap-1 rounded-xl border border-line bg-ground p-1 lg:hidden" role="tablist">
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
                  active ? 'bg-ink text-on-ink shadow-sm' : 'text-ink-soft hover:bg-card'
                }`}
              >
                <Icon className="hidden h-3.5 w-3.5 shrink-0 sm:block" />
                <span className="truncate">{TAB_LABEL[t]}</span>
                {count !== undefined && (
                  <span className={`rounded-full px-1.5 text-[10px] ${active ? 'bg-on-ink/20' : 'bg-line'}`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
        {hasStrip && <div className="mb-2 lg:hidden">{strip}</div>}
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              aria-label="Search"
              placeholder="Search customers, intents…"
              className="w-full rounded-lg border border-line bg-card py-2 pl-8 pr-3 text-[13px] placeholder:text-ink-muted focus:border-field focus:outline-none focus:ring-2 focus:ring-field"
            />
          </div>
          {onNewContact && (
            <button
              type="button"
              onClick={onNewContact}
              aria-label={NEW_CONTACT_LABEL}
              title={NEW_CONTACT_LABEL}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-2 text-[12px] font-medium text-ink-soft hover:bg-wash"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenFilters}
            aria-label="Filters"
            className="relative inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-2 text-[12px] font-medium text-ink-soft hover:bg-wash lg:hidden"
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {filterCount > 0 && (
              <span className="rounded-full bg-ink px-1.5 text-[10px] font-semibold text-on-ink">{filterCount}</span>
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
                  p.tint ?? 'bg-band text-ink ring-line'
                }`}
              >
                {p.label}
                <button
                  type="button"
                  aria-label={`Clear ${p.label}`}
                  onClick={() => onFilters(p.clear)}
                  className="rounded-full p-0.5 text-ink-muted transition hover:bg-line hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-ink-muted">
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
                filters.unanswered ? 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30' : 'bg-card text-ink-muted ring-line hover:bg-wash'
              }`}
            >
              Unanswered only
            </button>
          )}
        </div>
        {tab === 'handled' && (
          <div className="mt-3 space-y-2 rounded-lg bg-ground p-2.5 ring-1 ring-line">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
                <Archive className="h-3 w-3" /> Archive filters
              </div>
              <PendingControl
                reason="Export is not built yet"
                label="Export"
                className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-ink-soft"
              >
                <Download className="h-3 w-3" /> Export
              </PendingControl>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-ink-muted">
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
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-ink-muted">
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
          <div className="flex justify-center py-10 text-ink-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Inbox} title="No conversations" subtitle="Try a different tab or filter." />
        ) : (
          <>
            {readyToBook.length > 0 && (
              <section aria-label={READY_TO_BOOK_LABEL} data-testid="ready-to-book" className="border-b-2 border-teal-300 dark:border-teal-700">
                <div className="flex items-center justify-between bg-teal-50 px-4 py-1.5 text-[11px] font-semibold text-teal-900 dark:bg-teal-950 dark:text-teal-100">
                  <span>{READY_TO_BOOK_LABEL}</span>
                  <span className="rounded-full bg-teal-700 px-1.5 text-[10px] text-white dark:bg-teal-300 dark:text-teal-950">{readyToBook.length}</span>
                </div>
                {readyToBook.map(rowOf)}
              </section>
            )}
            {rest.map(rowOf)}
            {page?.nextCursor && (
              <div className="flex justify-center p-3">
                <button
                  type="button"
                  onClick={onMore}
                  disabled={loadingMore}
                  className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-[11px] font-medium text-ink-soft ring-1 ring-line hover:bg-wash"
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
  const nextAction = c.nextAction ?? (c.status === 'handled' ? 'handled' : c.unanswered ? 'staff_reply_needed' : 'waiting_customer');
  // SCRUM-996: the deposit's words, for whoever sees the row; said aloud with the rest of it.
  const deposit = c.depositSignal ?? null;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${name}${c.unread > 0 ? `, ${c.unread} unread for you` : ''}, ${NEXT_ACTION_LABELS[nextAction]}${deposit ? `, ${DEPOSIT_SIGNAL_LABELS[deposit]}` : ''}`}
      onClick={() => onSelect(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(c.id);
        }
      }}
      className={`group relative block w-full cursor-pointer border-b border-line-soft px-4 py-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-700 dark:focus-visible:outline-emerald-300 ${conversationRowColour(selected, c.unread)}`}
    >
      <div className="flex items-start gap-3">
        <div className="relative">
          <Avatar initials={initialsOf(name)} tint={tintFor(c.contact.id)} size={40} />
          <ChannelDot channel={c.channel} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-[13px] font-semibold text-ink">
              {name}
              {/* The number it came in on (SCRUM-220 playbook), not the bare channel. */}
              <span className="font-normal text-ink-soft"> · {sourceLabel(c.channel, c.channelAccountName)}</span>
            </div>
            <div className="shrink-0 text-[11px] text-ink-soft">{listTime(c.lastMessageAt, now)}</div>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-muted">
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
          <div className={`mt-1 truncate text-[12.5px] ${c.unanswered ? 'text-ink' : 'text-ink-soft'}`}>
            {c.lastMessagePreview ?? ' '}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <CategoryBadge category={c.category} title={categoryTitle(c.category, teamName)} />
            <StatusBadge status={c.status} />
            {nextAction !== 'handled' && (
              <span data-next-action={nextAction} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${NEXT_ACTION_COLOURS[nextAction]}`}>
                {NEXT_ACTION_LABELS[nextAction]}
              </span>
            )}
            {deposit && (
              <span data-deposit-signal={deposit} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${DEPOSIT_SIGNAL_COLOURS[deposit]}`}>
                {DEPOSIT_SIGNAL_LABELS[deposit]}
              </span>
            )}
            {c.unread > 0 && (
              <span aria-label={`${c.unread} unread messages for you`} className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-indigo-700 px-1 text-[11px] font-semibold text-white dark:bg-indigo-300 dark:text-indigo-950">
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
