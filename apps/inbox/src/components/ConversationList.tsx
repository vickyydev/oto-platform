import type { ReactNode } from 'react';
import { Inbox, Loader2, SlidersHorizontal, X } from 'lucide-react';
import type { InboxTab } from '@oto/shared/inbox';
import type { ConversationList as ListPage, ConversationRow, InboxMe } from '@/api/inbox';
import { Avatar, ChannelDot, EmptyState, PILL, PILL_OFF, PILL_ON } from '@/components/atoms';
import { ScopeTabs } from '@/components/Rail';
import { PendingControl } from '@/components/writes';
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
import {
  ARCHIVE_RANGES,
  CATEGORY_SHORT,
  TAB_LABEL,
  branchOptions,
  contactName,
  effectiveBranchId,
  initialsOf,
  listTime,
  tintFor,
} from '@/lib/view';

export const UNREAD_FILTER_LABEL = 'Unread';
/** The row's badge for a thread of the till's check-in notices (`canReply` false), shown when they are not hidden. */
export const TILL_NOTICE_LABEL = 'Till notice';

/** "12 conversations", "50+ conversations": the rows read, "+" while the next page waits. */
function countLabel(n: number, more: boolean): string {
  return `${n}${more ? '+' : ''} conversation${n === 1 && !more ? '' : 's'}`;
}

/**
 * The conversation list (WhatsAppDemo.tsx :1463-1630), as SCRUM-1016 drew
 * it (Main.dc.html, Desktop.dc.html). Below 1024 px its head holds the scope
 * switch (Mine, Team, Handled), the statistics row, the Unread quick filter
 * and the Filters button; from 1024 px the views column holds the switch and
 * the filters, and the head names the tab. Under both: the applied filters
 * as removable pills, and on Handled the archive's range and "Resolved by".
 * The search and New contact are in the app bar; "Needs reply" is the
 * statistics row's figure, its only control.
 *
 * The body: "Ready to book" pinned on top (SCRUM-996, owner choice 1), then
 * every other row in last-activity order, then "More conversations".
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
  selectedId,
  now,
  sources = [],
  onFilters,
  onTab,
  onOpenFilters,
  onSelect,
  onMore,
}: {
  me: InboxMe;
  tab: InboxTab;
  /** The statistics row below 1024 px (SCRUM-1016), under the scope switch; at 1024 and up the figures sit in the app bar. */
  strip?: ReactNode;
  page: ListPage | null;
  rows: ConversationRow[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  filters: Filters;
  selectedId: string | null;
  now: Date;
  /** The numbers known so far, so the Channel pill names its number (SCRUM-220 playbook). */
  sources?: readonly SourceOption[];
  onFilters: (next: Partial<Filters>) => void;
  onTab: (t: InboxTab) => void;
  onOpenFilters: () => void;
  onSelect: (id: string) => void;
  onMore: () => void;
}) {
  const filterCount = activeFilterCount(filters);
  const hasStrip = strip !== undefined && strip !== null;
  const pills = filterPills(filters, me.teams, sources);
  // SCRUM-996, owner choice 1: the paid chats pinned above the list in their
  // own last-activity order; everything else keeps the list's order below.
  const readyToBook = rows.filter((c) => isReadyToBook(c.depositSignal));
  const rest = readyToBook.length > 0 ? rows.filter((c) => !isReadyToBook(c.depositSignal)) : rows;
  const rowOf = (ready: boolean) => (c: ConversationRow) => (
    <Row key={c.id} c={c} me={me} ready={ready} selected={c.id === selectedId} now={now} onSelect={onSelect} />
  );
  return (
    <>
      <div className="flex shrink-0 flex-col gap-3 px-4 pb-2 pt-1 md:pt-3 lg:pt-3.5">
        {/* Below 1024 px: the one scope switch, then the day's figures. */}
        <div className="lg:hidden">
          <ScopeTabs tabs={me.tabs} tab={tab} counts={page?.tabCounts ?? null} onTab={onTab} />
        </div>
        {hasStrip && <div className="lg:hidden">{strip}</div>}
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="mr-auto hidden text-[18px] font-extrabold tracking-[-0.02em] text-ink lg:block">{TAB_LABEL[tab]}</h2>
          <button
            type="button"
            aria-pressed={filters.unread}
            onClick={() => onFilters({ unread: !filters.unread })}
            className={`${PILL} ${filters.unread ? PILL_ON : PILL_OFF} md:min-h-9`}
          >
            {UNREAD_FILTER_LABEL}
          </button>
          <span className="flex-1 lg:hidden" />
          <button
            type="button"
            onClick={onOpenFilters}
            aria-label="Filters"
            className={`${PILL} ${PILL_OFF} gap-1.5 px-3 md:min-h-9 lg:hidden`}
          >
            <SlidersHorizontal aria-hidden className="h-[18px] w-[18px]" />
            Filters
            {filterCount > 0 && (
              <span className="min-w-5 rounded-full bg-ink px-1.5 text-center text-[11.5px] font-bold text-on-ink">{filterCount}</span>
            )}
          </button>
        </div>
        {/* What is applied, by the list (UI round 2026-10-22, F1): one pill
            each, removable; a topic's pill carries its dot. */}
        {pills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {pills.map((p) => (
              <span
                key={p.key}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line bg-card py-0.5 pl-3 pr-0.5 text-[12.5px] font-semibold text-ink"
              >
                {p.dot && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${p.dot}`} />}
                <span className="truncate">{p.label}</span>
                <button
                  type="button"
                  aria-label={`Clear ${p.label}`}
                  onClick={() => onFilters(p.clear)}
                  className="-my-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:bg-wash hover:text-ink md:my-0 md:h-8 md:w-8"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        {tab === 'handled' && <HandledBar filters={filters} onFilters={onFilters} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {error ? (
          <div role="alert" className="m-4 rounded-xl bg-needs px-3 py-2 text-[13px] text-needs-ink">
            {error}
          </div>
        ) : loading && rows.length === 0 ? (
          <div role="status" aria-label="Reading the conversations" className="flex justify-center py-10 text-ink-muted">
            <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Inbox} title="No conversations" subtitle="Try a different tab or filter." />
        ) : (
          <>
            {readyToBook.length > 0 && (
              <section aria-label={READY_TO_BOOK_LABEL} data-testid="ready-to-book">
                <h3 className="flex items-center gap-2 px-4 pb-1.5 pt-2 text-[12px] font-bold text-money-ink">
                  {READY_TO_BOOK_LABEL}
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-money-ink px-1.5 text-[11.5px] text-money">
                    {readyToBook.length}
                  </span>
                </h3>
                <div className="border-y border-money-line">{readyToBook.map(rowOf(true))}</div>
              </section>
            )}
            <h3 className="px-4 pb-1.5 pt-3.5 text-[12px] font-bold text-ink-muted">
              {countLabel(rows.length, Boolean(page?.nextCursor))} · newest first
            </h3>
            {rest.map(rowOf(false))}
            {page?.nextCursor && (
              <div className="flex justify-center p-3">
                <button
                  type="button"
                  onClick={onMore}
                  disabled={loadingMore}
                  className={`${PILL} ${PILL_OFF} gap-1.5`}
                >
                  {loadingMore && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
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
 * The archive's own choices on the Handled tab (the prototype's archive
 * filters, :1478-1510), in one tidy bar: how far back, who resolved it, and
 * the Export that is not built yet.
 */
function HandledBar({ filters, onFilters }: { filters: Filters; onFilters: (next: Partial<Filters>) => void }) {
  const choice = (pressed: boolean, label: string, onClick: () => void, key: string) => (
    <button key={key} type="button" aria-pressed={pressed} onClick={onClick} className={`${PILL} ${pressed ? PILL_ON : PILL_OFF} md:min-h-9`}>
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-card p-3">
      <div role="group" aria-label="Handled in the last" className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[12px] font-bold text-ink-muted">Handled in the last</h3>
          <PendingControl
            reason="Export is not built yet"
            label="Export"
            className="inline-flex min-h-9 items-center rounded-full border border-line px-3 text-[12.5px] font-semibold text-ink-muted"
          >
            Export
          </PendingControl>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ARCHIVE_RANGES.map(([k, label]) => choice(filters.archiveRange === k, label, () => onFilters({ archiveRange: k }), k))}
        </div>
      </div>
      <div role="group" aria-label="Resolved by" className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-bold text-ink-muted">Resolved by</h3>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['', 'Anyone'],
              ['ai', 'AI'],
              ['human', 'Human'],
            ] as const
          ).map(([k, label]) => choice(filters.resolvedBy === k, label, () => onFilters({ resolvedBy: k }), k || 'all'))}
        </div>
      </div>
    </div>
  );
}

/** "General · Central Floresta", "Marketing": the topic, and the park when it has one. */
function rowMeta(c: ConversationRow, me: InboxMe): string {
  const branchId = effectiveBranchId(c, me.teams);
  const park = branchId ? branchOptions(me.teams).find((b) => b.id === branchId)?.label : undefined;
  return park ? `${CATEGORY_SHORT[c.category]} · ${park}` : CATEGORY_SHORT[c.category];
}

/**
 * One row (SCRUM-1016, Main.dc.html): the contact's face with the channel's
 * dot; the name and the time; one line of the last message; then ONE badge
 * for what happens next — the deposit's words when there is a deposit
 * (SCRUM-996), else the next action (SCRUM-992), "Till notice" on a thread
 * that cannot take a reply — with the topic and the park as quiet text, and
 * the viewer's own unread count. An unread row is heavier; the selected one
 * stands on the band's ground inside a 2 px ring. The category, status and
 * assignee chips and the hover "Mark handled" are gone from the row: the
 * chat carries them, Mark as handled with its confirmation.
 */
function Row({
  c,
  me,
  ready,
  selected,
  now,
  onSelect,
}: {
  c: ConversationRow;
  me: InboxMe;
  ready: boolean;
  selected: boolean;
  now: Date;
  onSelect: (id: string) => void;
}) {
  const name = contactName(c.contact);
  const nextAction = c.nextAction ?? (c.status === 'handled' ? 'handled' : c.unanswered ? 'staff_reply_needed' : 'waiting_customer');
  // SCRUM-996: the deposit's words, for whoever sees the row; said aloud with the rest of it.
  const deposit = c.depositSignal ?? null;
  const unread = c.unread > 0;
  const meta = rowMeta(c, me);
  const time = listTime(c.lastMessageAt, now);
  const source = sourceLabel(c.channel, c.channelAccountName);
  const badge = deposit
    ? { words: DEPOSIT_SIGNAL_LABELS[deposit], colour: DEPOSIT_SIGNAL_COLOURS[deposit] }
    : !c.canReply
      ? { words: TILL_NOTICE_LABEL, colour: NEXT_ACTION_COLOURS.waiting_customer }
      : nextAction !== 'handled'
        ? { words: NEXT_ACTION_LABELS[nextAction], colour: NEXT_ACTION_COLOURS[nextAction] }
        : null;
  const said = [
    name,
    ...(unread ? [`${c.unread} unread for you`] : []),
    NEXT_ACTION_LABELS[nextAction],
    ...(deposit ? [DEPOSIT_SIGNAL_LABELS[deposit]] : []),
    meta,
    `on ${source}`,
    time,
  ].join(', ');
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      aria-label={said}
      data-next-action={nextAction}
      onClick={() => onSelect(c.id)}
      className={`flex w-full min-w-0 gap-3 border-b px-4 py-3 text-left transition last:border-b-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-coral ${
        ready ? 'border-money-line' : 'border-line-soft'
      } ${conversationRowColour(selected, ready)}`}
    >
      {/* `self-start`: the face keeps its own height, so the channel dot sits on
          its corner, not at the foot of the row it would otherwise stretch to. */}
      <span className="relative shrink-0 self-start" data-face>
        <Avatar initials={initialsOf(name)} tint={tintFor(c.contact.id)} />
        <ChannelDot channel={c.channel} ring={ready ? 'ring-money' : selected ? 'ring-band' : 'ring-ground'} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-2">
          {/* The name and the line at a tight leading, as Main.dc.html sets them (a row of about 92 px). */}
          <span className={`min-w-0 flex-1 truncate text-[15px] leading-tight text-ink ${unread ? 'font-extrabold' : 'font-semibold'}`}>{name}</span>
          <span className={`shrink-0 text-[12px] ${ready ? 'text-ink-soft' : 'text-ink-muted'}`}>{time}</span>
        </span>
        <span className={`truncate text-[13.5px] leading-tight ${unread ? 'text-ink' : 'text-ink-soft'}`}>{c.lastMessagePreview ?? ' '}</span>
        <span className="mt-[3px] flex min-w-0 items-center gap-2">
          {badge && (
            <span
              {...(deposit ? { 'data-deposit-signal': deposit } : {})}
              className={`inline-flex h-6 shrink-0 items-center rounded-lg px-2 text-[12px] font-semibold ${badge.colour}`}
            >
              {badge.words}
            </span>
          )}
          <span className={`min-w-0 flex-1 truncate text-[12px] ${ready ? 'text-ink-soft' : 'text-ink-muted'}`}>{meta}</span>
          {unread && (
            <span
              aria-label={`${c.unread} unread messages for you`}
              className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-coral px-1.5 text-[11.5px] font-bold text-on-coral"
            >
              {c.unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
