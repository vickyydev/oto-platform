import type { ReactNode } from 'react';
import {
  Activity,
  Archive,
  Briefcase,
  Filter,
  Globe2,
  Inbox,
  Layers,
  MapPin,
  MessageCircle,
  MessagesSquare,
  PartyPopper,
  Tag,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { InboxTab } from '@oto/shared/inbox';
import type { ConversationList, InboxMe } from '@/api/inbox';
import { Avatar, Eyebrow, FilterChip } from '@/components/atoms';
import { applyView, currentView, namedViews, sourceLabel, toggleChip, type ChipDim, type NamedView, type SourceOption } from '@/lib/inboxes';
import type { Filters } from '@/lib/query';
import {
  CATEGORY_BAR,
  CATEGORY_OPTIONS,
  CHANNEL_LABEL,
  CHANNEL_TINT,
  LANGUAGE_OPTIONS,
  STATUS_DOT,
  STATUS_OPTIONS,
  TAB_LABEL,
  branchOptions,
  initialsOf,
  tintFor,
} from '@/lib/view';

export const TAB_ICON: Record<InboxTab, LucideIcon> = { mine: Inbox, team: Users, handled: Archive };

/**
 * Who the rail says is reading (the prototype's "Viewing as", :1407-1416):
 * the owner view, else the teams they are in, else a staff member who sees
 * only what they are put on.
 */
export function viewerRoleLabel(me: Pick<InboxMe, 'roles' | 'teams'>): string {
  // 'Owner view' names the view, not the person (SCRUM-652 polish): the GM
  // reads under it too.
  if (me.roles.includes('owner')) return 'Owner view';
  const teams = me.teams.filter((t) => t.member).map((t) => t.name);
  return teams.length > 0 ? teams.join(' · ') : 'Staff';
}

/** The row button the rail's tabs are (:1418-1438), shared by the named views. */
const RAIL_ITEM = 'mb-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition';
const RAIL_ITEM_ON = 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700';
const RAIL_ITEM_OFF = 'text-slate-600 dark:text-slate-300 hover:bg-white/70 dark:hover:bg-slate-800/70';

/** The rail's section heading: the Filters eyebrow (:1442-1444). */
function RailHeading({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
      <Icon className="h-3 w-3" /> {children}
    </div>
  );
}

/** One row of chips under its small label, in the archive filters' layout (`ConversationList`, "Handled in the last"). */
function ChipRow({ icon: Icon, title, label, children }: { icon: LucideIcon; title: string; label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="mb-2.5 last:mb-0">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-slate-500 dark:text-slate-400">
        <Icon className="h-3 w-3" /> {title}
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

/**
 * The filters as rows of toggle chips (SCRUM-220 playbook, in place of the
 * prototype's four selects, :1447-1458), shared by the rail and the phone's
 * filter dialog: Branch, Source (each number by its display name, Instagram
 * and Facebook among them), Topic, Status, Language. A press adds a chip, a
 * second press removes it; rows combine. One chip per row is on at a time —
 * the list filters one value per row (`toggleChip`).
 */
export function FilterFields({
  me,
  filters,
  onChange,
  sources = [],
}: {
  me: InboxMe;
  filters: Filters;
  onChange: (next: Partial<Filters>) => void;
  /** The numbers known so far (`GET /inbox/ai/channel-accounts`, and the rows read); no row while there are none. */
  sources?: readonly SourceOption[];
}) {
  const chip = (dim: ChipDim, value: string, label: string, dot?: string, title?: string) => (
    <FilterChip
      key={`${dim}:${value}`}
      chipKey={`${dim}:${value}`}
      label={label}
      pressed={filters[dim] === value}
      onClick={() => onChange(toggleChip(filters, dim, value))}
      dot={dot}
      title={title}
    />
  );
  const branches = branchOptions(me.teams);
  return (
    <>
      {/* "Filter by branch", not "Branch": the strip's branch select is "Conversation branch" (test night U12). */}
      {branches.length > 0 && (
        <ChipRow icon={MapPin} title="Branch" label="Filter by branch">
          {branches.map((b) => chip('branchId', b.id, b.label))}
        </ChipRow>
      )}
      {sources.length > 0 && (
        <ChipRow icon={MessageCircle} title="Source" label="Filter by source">
          {sources.map((s) => {
            const label = sourceLabel(s.channel, s.name);
            return chip('channelAccountId', s.id, label, CHANNEL_TINT[s.channel], s.name ? `${label} · ${CHANNEL_LABEL[s.channel]}` : label);
          })}
        </ChipRow>
      )}
      <ChipRow icon={Tag} title="Topic" label="Filter by topic">
        {CATEGORY_OPTIONS.map(([k, label]) => chip('category', k, label, CATEGORY_BAR[k]))}
      </ChipRow>
      <ChipRow icon={Activity} title="Status" label="Filter by status">
        {STATUS_OPTIONS.map(([k, label]) => chip('status', k, label, STATUS_DOT[k]))}
      </ChipRow>
      <ChipRow icon={Globe2} title="Language" label="Filter by language">
        {LANGUAGE_OPTIONS.map(([k, label]) => chip('language', k, label))}
      </ChipRow>
    </>
  );
}

const VIEW_ICON: Record<NamedView['kind'], LucideIcon> = { all: MessagesSquare, category: Tag, branch: MapPin };
const CATEGORY_VIEW_ICON: Record<string, LucideIcon> = { birthdays: PartyPopper, gm: Briefcase };

/**
 * The playbook's named inboxes (SCRUM-220), above the filters: All
 * conversations, Birthdays & Events, GM, one per park. Each is a saved set of
 * chips — opening one sets them — and the one marked is read back off the
 * chips (`currentView`): a chip changed by hand lands on All, marked
 * "Filtered". No counts: nothing the shell already reads counts unread or
 * unanswered per view, and the playbook build adds no polling for it.
 */
export function InboxViews({
  me,
  filters,
  onChange,
}: {
  me: Pick<InboxMe, 'teams'>;
  filters: Filters;
  onChange: (next: Partial<Filters>) => void;
}) {
  const views = namedViews(me);
  const at = currentView(filters, views);
  return (
    <nav aria-label="Inbox views">
      {views.map((v) => {
        const Icon = CATEGORY_VIEW_ICON[v.key] ?? VIEW_ICON[v.kind];
        const active = at.key === v.key;
        return (
          <button
            key={v.key}
            type="button"
            data-view={v.key}
            aria-current={active ? 'true' : undefined}
            onClick={() => onChange(applyView(v))}
            title={active && at.modified ? 'Filtered by hand — press to clear the filters' : undefined}
            className={`${RAIL_ITEM} ${active ? RAIL_ITEM_ON : RAIL_ITEM_OFF}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400'}`} />
              <span className="truncate">{v.label}</span>
            </span>
            {active && at.modified && (
              <span className="shrink-0 text-[10px] font-medium italic text-slate-400">Filtered</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** The 220 px left rail on `slate-50` (:1406-1460): viewer, tabs with counts, the named inboxes, the filter chips. */
export function Rail({
  me,
  tab,
  counts,
  filters,
  sources = [],
  onTab,
  onFilters,
}: {
  me: InboxMe;
  tab: InboxTab;
  counts: ConversationList['tabCounts'] | null;
  filters: Filters;
  sources?: readonly SourceOption[];
  onTab: (t: InboxTab) => void;
  onFilters: (next: Partial<Filters>) => void;
}) {
  const name = me.name ?? 'You';
  return (
    <aside className="hidden min-h-0 flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 lg:flex">
      <div className="border-b border-slate-200 dark:border-slate-800 px-4 py-3">
        <Eyebrow>Viewing as</Eyebrow>
        <div className="mt-1 flex items-center gap-2">
          <Avatar
            initials={initialsOf(name)}
            tint={me.roles.includes('owner') ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : tintFor(me.accountId)}
            size={28}
          />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">{name}</div>
            <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">{viewerRoleLabel(me)}</div>
          </div>
        </div>
      </div>
      <nav className="shrink-0 px-2 py-2" aria-label="Tabs">
        {me.tabs.map((t) => {
          const Icon = TAB_ICON[t];
          const active = tab === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => onTab(t)}
              aria-current={active ? 'page' : undefined}
              className={`${RAIL_ITEM} ${active ? RAIL_ITEM_ON : RAIL_ITEM_OFF}`}
            >
              <span className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${active ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400'}`} />
                {TAB_LABEL[t]}
              </span>
              {/* The prototype counts the working tabs, not the archive (:1434). */}
              {t !== 'handled' && counts?.[t] !== undefined && (
                <span
                  className={`rounded-full px-1.5 text-[10px] font-semibold ${
                    active ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {counts[t]}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {/* The named inboxes and the chips scroll together under the tabs: the
          chips run longer than the prototype's four selects. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-t border-slate-200 dark:border-slate-800 px-2 py-2">
          <div className="px-1">
            <RailHeading icon={Layers}>Inboxes</RailHeading>
          </div>
          <InboxViews me={me} filters={filters} onChange={onFilters} />
        </div>
        <div className="border-t border-slate-200 dark:border-slate-800 p-3">
          <RailHeading icon={Filter}>Filters</RailHeading>
          <FilterFields me={me} filters={filters} onChange={onFilters} sources={sources} />
        </div>
      </div>
    </aside>
  );
}
