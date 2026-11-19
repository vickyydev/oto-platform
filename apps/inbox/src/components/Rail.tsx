import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { InboxTab } from '@oto/shared/inbox';
import type { ConversationList, InboxMe } from '@/api/inbox';
import { FilterChip } from '@/components/atoms';
import { channelChoices, sourceLabel, toggleChip, topicChoices, type ChipDim, type SourceOption } from '@/lib/inboxes';
import { HELD_TOPIC_HINT, HELD_TOPIC_LABEL, topicOf, topicPatch, type Filters, type TopicChoice } from '@/lib/query';
import { CATEGORY_DOT, CATEGORY_LABEL, CHANNEL_LABEL, CHANNEL_TINT, LANGUAGE_OPTIONS, TAB_LABEL, branchOptions } from '@/lib/view';

type TabCounts = ConversationList['tabCounts'];
type TopicCounts = NonNullable<ConversationList['topicCounts']>;

/** The prototype counts the working tabs, not the archive (:1434). */
const countOf = (counts: TabCounts | null | undefined, t: InboxTab) => (t !== 'handled' ? counts?.[t] : undefined);

// --- Mine / Team / Handled: one switch --------------------------------------------------

/**
 * The scope switch on a phone and a tablet (Main.dc.html): Mine, Team and
 * Handled in one segmented band, each with its count; the one place the tab
 * is chosen below 1024 px (SCRUM-1016 removed the header's Handled button and
 * the tiles that did the same). A tab list: the arrow keys, Home and End move
 * between the tabs and choose them.
 */
export function ScopeTabs({
  tabs,
  tab,
  counts,
  onTab,
}: {
  tabs: readonly InboxTab[];
  tab: InboxTab;
  counts: TabCounts | null;
  onTab: (t: InboxTab) => void;
}) {
  const refs = useRef<Partial<Record<InboxTab, HTMLButtonElement | null>>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.indexOf(tab);
    const to =
      e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length]!;
    onTab(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Which conversations"
      onKeyDown={onKeyDown}
      className="grid gap-1 rounded-[14px] bg-band p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((t) => {
        const active = t === tab;
        const count = countOf(counts, t);
        return (
          <button
            key={t}
            ref={(el) => {
              refs.current[t] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onTab(t)}
            className={`flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-[10px] px-2 text-[14px] transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-coral ${
              active ? 'bg-segment font-bold text-ink shadow-[0_1px_2px_var(--oto-shadow)]' : 'font-semibold text-ink-soft hover:bg-wash'
            }`}
          >
            <span className="truncate">{TAB_LABEL[t]}</span>
            {count !== undefined && <span className={`text-[12px] font-bold ${active ? 'text-coral-ink' : ''}`}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The same switch at the top of the desktop's views column (Desktop.dc.html). */
function ScopeNav({ tabs, tab, counts, onTab }: { tabs: readonly InboxTab[]; tab: InboxTab; counts: TabCounts | null; onTab: (t: InboxTab) => void }) {
  return (
    <nav aria-label="Which conversations" className="flex flex-col gap-0.5">
      {tabs.map((t) => {
        const active = t === tab;
        const count = countOf(counts, t);
        return (
          <button
            key={t}
            type="button"
            onClick={() => onTab(t)}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-10 items-center justify-between gap-2 rounded-[10px] px-3 text-left text-[14px] text-ink transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-coral ${
              active ? 'bg-band font-bold' : 'font-medium hover:bg-wash'
            }`}
          >
            {TAB_LABEL[t]}
            {count !== undefined && <span className={`text-[12.5px] ${active ? 'text-coral-ink' : 'text-ink-muted'}`}>{count}</span>}
          </button>
        );
      })}
    </nav>
  );
}

// --- The filters, each once ----------------------------------------------------------------

/** One filter choice, by where it shows: a pill in the sheet, a line in the views column. */
interface Choice {
  /** `dim:value` for the markup tests; `dim:all` for a row's "all". */
  key: string;
  label: string;
  pressed: boolean;
  onPress: () => void;
  dot?: string;
  title?: string;
  count?: number;
}

/** A line of the desktop's views column (Desktop.dc.html): its dot, its words, its count. */
function ColumnChoice({ c }: { c: Choice }) {
  return (
    <button
      type="button"
      data-chip={c.key}
      aria-pressed={c.pressed}
      onClick={c.onPress}
      title={c.title ?? c.label}
      className={`flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-[10px] px-3 text-left text-[14px] text-ink transition hover:bg-wash focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-coral ${
        c.pressed ? 'bg-wash font-bold' : ''
      }`}
    >
      {c.dot && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${c.dot}`} />}
      <span className="min-w-0 flex-1 truncate">{c.label}</span>
      {c.count !== undefined && <span className="shrink-0 text-[12.5px] font-normal text-ink-muted">{c.count}</span>}
    </button>
  );
}

function Group({ label, title, layout, children }: { label: string; title: string; layout: 'sheet' | 'column'; children: ReactNode }) {
  return layout === 'sheet' ? (
    <div role="group" aria-label={label}>
      <h3 className="mb-2.5 text-[13px] font-bold text-ink-soft">{title}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  ) : (
    <div role="group" aria-label={label} className="flex flex-col gap-0.5">
      <h3 className="mb-1 px-3 text-[12px] font-bold text-ink-muted">{title}</h3>
      {children}
    </div>
  );
}

/**
 * The filters in one place (SCRUM-1016, Filters.dc.html): Topic, Park,
 * Channel, Language — each row once, in the phone's sheet (`sheet`) or the
 * desktop's views column (`column`), never both on one screen. Each row
 * starts with its "all"; a press chooses, a second press goes back to all;
 * rows combine (`toggleChip`).
 *
 * Topic holds every topic and "Kept in General" (the SCRUM-789 General view,
 * folded in). Channel holds every number known so far and each WhatsApp test
 * line (SCRUM-908). The SCRUM-993 limits decide which topics and numbers are
 * offered. The column shows each topic's count when the list read sends them.
 */
export function FilterFields({
  me,
  filters,
  onChange,
  sources = [],
  layout = 'sheet',
  topicCounts,
}: {
  me: InboxMe;
  filters: Filters;
  onChange: (next: Partial<Filters>) => void;
  /** The numbers known so far (the rows read, the simulator's, the assistant's list). */
  sources?: readonly SourceOption[];
  layout?: 'sheet' | 'column';
  /** Each topic's count for this list (`topicCounts`); shown in the column only. */
  topicCounts?: TopicCounts;
}) {
  const render = (c: Choice) =>
    layout === 'sheet' ? (
      <FilterChip key={c.key} chipKey={c.key} label={c.label} pressed={c.pressed} onClick={c.onPress} dot={c.dot} title={c.title} />
    ) : (
      <ColumnChoice key={c.key} c={c} />
    );
  const counted = layout === 'column' ? topicCounts : undefined;

  // Topic: one choice of category or the held view, inside the limits.
  const topic = topicOf(filters);
  const pickTopic = (choice: TopicChoice) => onChange(topicPatch(topic === choice ? '' : choice));
  const topics: Choice[] = [
    {
      key: 'category:all',
      label: 'All topics',
      pressed: topic === '',
      onPress: () => onChange(topicPatch('')),
      count: counted ? counted.birthdays + counted.general + counted.marketing + counted.gm : undefined,
    },
    ...topicChoices(me.access).map((k): Choice =>
      k === 'held'
        ? { key: 'inbox:general', label: HELD_TOPIC_LABEL, pressed: topic === 'held', onPress: () => pickTopic('held'), dot: CATEGORY_DOT.general, title: HELD_TOPIC_HINT, count: counted?.heldInGeneral }
        : { key: `category:${k}`, label: CATEGORY_LABEL[k], pressed: topic === k, onPress: () => pickTopic(k), dot: CATEGORY_DOT[k], count: counted?.[k] },
    ),
  ];

  const row = (dim: ChipDim, all: string, options: { value: string; label: string; dot?: string; title?: string }[]): Choice[] => [
    { key: `${dim}:all`, label: all, pressed: filters[dim] === '', onPress: () => onChange({ [dim]: '' } as Partial<Filters>) },
    ...options.map((o): Choice => ({
      key: `${dim}:${o.value}`,
      label: o.label,
      pressed: filters[dim] === o.value,
      onPress: () => onChange(toggleChip(filters, dim, o.value)),
      dot: o.dot,
      title: o.title,
    })),
  ];
  const parks = branchOptions(me.teams);
  const channels = channelChoices(sources, me);

  return (
    <div className={layout === 'sheet' ? 'flex flex-col gap-5' : 'flex flex-col gap-[18px]'}>
      <Group label="Filter by topic" title="Topic" layout={layout}>
        {topics.map(render)}
      </Group>
      {/* "Filter by park", apart from the chat's branch select ("Conversation branch", test night U12). */}
      {parks.length > 0 && (
        <Group label="Filter by park" title="Park" layout={layout}>
          {row('branchId', 'All parks', parks.map((b) => ({ value: b.id, label: b.label }))).map(render)}
        </Group>
      )}
      {channels.length > 0 && (
        <Group label="Filter by channel" title="Channel" layout={layout}>
          {row(
            'channelAccountId',
            'All channels',
            channels.map((s) => {
              const label = sourceLabel(s.channel, s.name);
              return { value: s.id, label, dot: CHANNEL_TINT[s.channel], title: s.name ? `${label} · ${CHANNEL_LABEL[s.channel]}` : label };
            }),
          ).map(render)}
        </Group>
      )}
      <Group label="Filter by language" title="Language" layout={layout}>
        {row('language', 'Any', LANGUAGE_OPTIONS.map(([value, label]) => ({ value, label }))).map(render)}
      </Group>
    </div>
  );
}

export const HIDE_NOTICES_LABEL = 'Hide till notices';
export const HIDE_NOTICES_HINT = 'Check-in messages sent by the till. They cannot take a reply.';

/**
 * "Hide till notices" (SCRUM-1016): on by default, so a manager's list is
 * the customers' chats, not the till's check-in notices; the workspace
 * remembers it per browser. The api leaves the notices out of the list and
 * its counts while it is on (`replyable=true`).
 */
export function HideNoticesSwitch({ on, onChange, compact = false }: { on: boolean; onChange: (on: boolean) => void; compact?: boolean }) {
  const input = (
    <input
      type="checkbox"
      role="switch"
      data-switch="hide-notices"
      checked={on}
      onChange={(e) => onChange(e.target.checked)}
      className={`shrink-0 accent-coral ${compact ? 'h-[18px] w-[18px]' : 'h-[22px] w-[22px]'}`}
    />
  );
  return compact ? (
    <label title={HIDE_NOTICES_HINT} className="flex min-h-10 cursor-pointer items-center gap-2.5 px-3 text-[13px] text-ink-soft">
      {input}
      {HIDE_NOTICES_LABEL}
    </label>
  ) : (
    <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-line bg-card px-3.5 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-ink">{HIDE_NOTICES_LABEL}</span>
        <span className="text-[12.5px] text-ink-muted">{HIDE_NOTICES_HINT}</span>
      </span>
      {input}
    </label>
  );
}

/**
 * The desktop's views column (Desktop.dc.html, from 1024 px): the scope
 * switch with its counts, then every filter once with the topics' counts,
 * then "Hide till notices". It scrolls on its own; the page never does.
 */
export function Rail({
  me,
  tab,
  counts,
  topicCounts,
  filters,
  sources = [],
  onTab,
  onFilters,
}: {
  me: InboxMe;
  tab: InboxTab;
  counts: TabCounts | null;
  topicCounts?: TopicCounts;
  filters: Filters;
  sources?: readonly SourceOption[];
  onTab: (t: InboxTab) => void;
  onFilters: (next: Partial<Filters>) => void;
}) {
  return (
    <aside aria-label="Views" className="hidden min-h-0 flex-col border-r border-line bg-ground lg:flex">
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-3 py-4">
        <ScopeNav tabs={me.tabs} tab={tab} counts={counts} onTab={onTab} />
        <FilterFields me={me} filters={filters} onChange={onFilters} sources={sources} layout="column" topicCounts={topicCounts} />
        <div className="mt-auto">
          <HideNoticesSwitch compact on={filters.hideNotices} onChange={(hideNotices) => onFilters({ hideNotices })} />
        </div>
      </div>
    </aside>
  );
}
