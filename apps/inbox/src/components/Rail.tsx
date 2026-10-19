import { Activity, Archive, Filter, Globe2, Inbox, MapPin, Tag, Users, type LucideIcon } from 'lucide-react';
import type { InboxTab } from '@oto/shared/inbox';
import type { ConversationList, InboxMe } from '@/api/inbox';
import { Avatar, Eyebrow, FilterSelect } from '@/components/atoms';
import type { Filters } from '@/lib/query';
import { LANGUAGE_OPTIONS, TAB_LABEL, branchOptions, initialsOf, tintFor } from '@/lib/view';

export const TAB_ICON: Record<InboxTab, LucideIcon> = { mine: Inbox, team: Users, handled: Archive };

/**
 * Who the rail says is reading (the prototype's "Viewing as", :1407-1416):
 * the owner view, else the teams they are in, else a staff member who sees
 * only what they are put on.
 */
export function viewerRoleLabel(me: Pick<InboxMe, 'roles' | 'teams'>): string {
  if (me.roles.includes('owner')) return 'Owner';
  const teams = me.teams.filter((t) => t.member).map((t) => t.name);
  return teams.length > 0 ? teams.join(' · ') : 'Staff';
}

/** The filter selects (:1447-1458), shared by the rail and the phone's filter dialog. */
export function FilterFields({
  me,
  filters,
  onChange,
}: {
  me: InboxMe;
  filters: Filters;
  onChange: (next: Partial<Filters>) => void;
}) {
  return (
    <>
      <FilterSelect
        icon={Tag}
        label="Category"
        value={filters.category}
        onChange={(v) => onChange({ category: v as Filters['category'] })}
        options={[
          ['', 'All categories'],
          ['birthdays', 'Birthdays & Events'],
          ['general', 'General'],
          ['marketing', 'Marketing'],
        ]}
      />
      <FilterSelect
        icon={MapPin}
        label="Branch"
        value={filters.branchId}
        onChange={(v) => onChange({ branchId: v })}
        options={[['', 'All branches'], ...branchOptions(me.teams).map((b): [string, string] => [b.id, b.label])]}
      />
      <FilterSelect
        icon={Activity}
        label="Status"
        value={filters.status}
        onChange={(v) => onChange({ status: v as Filters['status'] })}
        options={[
          ['', 'All statuses'],
          ['active', 'Active'],
          ['handled', 'Handled'],
        ]}
      />
      <FilterSelect
        icon={Globe2}
        label="Language"
        value={filters.language}
        onChange={(v) => onChange({ language: v })}
        options={[['', 'All languages'], ...LANGUAGE_OPTIONS]}
      />
    </>
  );
}

/** The 220 px left rail on `slate-50` (:1406-1460): viewer, tabs with counts, filters. */
export function Rail({
  me,
  tab,
  counts,
  filters,
  onTab,
  onFilters,
}: {
  me: InboxMe;
  tab: InboxTab;
  counts: ConversationList['tabCounts'] | null;
  filters: Filters;
  onTab: (t: InboxTab) => void;
  onFilters: (next: Partial<Filters>) => void;
}) {
  const name = me.name ?? 'You';
  return (
    <aside className="hidden min-h-0 flex-col border-r border-slate-200 bg-slate-50/60 lg:flex">
      <div className="border-b border-slate-200 px-4 py-3">
        <Eyebrow>Viewing as</Eyebrow>
        <div className="mt-1 flex items-center gap-2">
          <Avatar
            initials={initialsOf(name)}
            tint={me.roles.includes('owner') ? 'bg-slate-900 text-white' : tintFor(me.accountId)}
            size={28}
          />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-slate-900">{name}</div>
            <div className="truncate text-[11px] text-slate-500">{viewerRoleLabel(me)}</div>
          </div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="Tabs">
        {me.tabs.map((t) => {
          const Icon = TAB_ICON[t];
          const active = tab === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => onTab(t)}
              aria-current={active ? 'page' : undefined}
              className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${
                active ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/70'
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${active ? 'text-slate-900' : 'text-slate-400'}`} />
                {TAB_LABEL[t]}
              </span>
              {/* The prototype counts the working tabs, not the archive (:1434). */}
              {t !== 'handled' && counts?.[t] !== undefined && (
                <span
                  className={`rounded-full px-1.5 text-[10px] font-semibold ${
                    active ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {counts[t]}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="border-t border-slate-200 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          <Filter className="h-3 w-3" /> Filters
        </div>
        <FilterFields me={me} filters={filters} onChange={onFilters} />
      </div>
    </aside>
  );
}
