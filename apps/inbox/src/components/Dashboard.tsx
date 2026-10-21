import { Activity, CheckCircle2, Clock3, MessageSquare, MessageSquareWarning } from 'lucide-react';
import type { Dashboard as DashboardData } from '@/api/inbox';
import { CategoryMixCard, MetricCard } from '@/components/atoms';
import { durationLabel, responseScopeLabel } from '@/lib/view';

const v = (n: number | undefined) => (n === undefined ? '—' : n);

/**
 * The manager dashboard: the 3 × 2 grid of screenshot 1, on the IT Brief's
 * figures (plan §3.3 `GET /inbox/dashboard`). "Unassigned" and "Needs manager"
 * are gone with the statuses that made them (nobody is ever unowned), so
 * their places hold Unanswered — clickable, it filters the list, as the
 * prototype's card does (:1367-1375) — and Active. The BEO card waits on the
 * event orders (owner Q23).
 *
 * The grid is for lg and up: below that it pushed the list off the screen
 * (owner UI round 2026-10-22, F3), so the phone gets `DashboardStrip` — one
 * compact line in the list header — instead.
 */
export function Dashboard({
  data,
  error,
  unansweredOnly,
  onToggleUnanswered,
}: {
  data: DashboardData | null;
  error: string | null;
  unansweredOnly: boolean;
  onToggleUnanswered: () => void;
}) {
  if (error) {
    return <p className="mt-5 rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 ring-1 ring-rose-200">{error}</p>;
  }
  // Whose average it is (test night U9): the api's `scope`; an api without one leaves the card as before.
  const scope = data ? responseScopeLabel(data.scope) : null;
  return (
    <div className="mt-5 hidden grid-cols-2 gap-3 sm:grid-cols-3 lg:grid" aria-busy={data === null}>
      <MetricCard icon={MessageSquare} label="New today" value={v(data?.newToday)} tint="text-blue-600 bg-blue-50" />
      <MetricCard
        icon={MessageSquareWarning}
        label="Unanswered"
        value={v(data?.unanswered)}
        tint="text-rose-600 bg-rose-50"
        active={unansweredOnly}
        onClick={onToggleUnanswered}
        hint={unansweredOnly ? 'Click to clear filter' : 'Click to filter list'}
      />
      <MetricCard icon={Activity} label="Active" value={v(data?.active)} tint="text-blue-600 bg-blue-50" />
      <MetricCard icon={CheckCircle2} label="Handled today" value={v(data?.handledToday)} tint="text-emerald-600 bg-emerald-50" />
      <MetricCard
        icon={Clock3}
        label="Avg response"
        value={data ? durationLabel(data.averageFirstResponseSeconds) : '—'}
        tint="text-slate-700 bg-slate-100"
        hint={scope ?? undefined}
      />
      <CategoryMixCard data={data?.byCategory ?? { birthdays: 0, general: 0, marketing: 0 }} />
    </div>
  );
}

/**
 * The dashboard below lg (owner UI round 2026-10-22, F3): one compact line in
 * the list header area — the unanswered count as a tappable rose chip with the
 * card's toggle behaviour, the active count and the average response — so the
 * list is on screen without scrolling. Rendered only for viewers with the
 * dashboard capability; the card grid above stays for lg and up.
 */
export function DashboardStrip({
  data,
  error,
  unansweredOnly,
  onToggleUnanswered,
}: {
  data: DashboardData | null;
  error: string | null;
  unansweredOnly: boolean;
  onToggleUnanswered: () => void;
}) {
  if (error) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 lg:hidden" aria-busy={data === null}>
      <button
        type="button"
        onClick={onToggleUnanswered}
        aria-pressed={unansweredOnly}
        title={unansweredOnly ? 'Showing unanswered only — tap to clear' : 'Tap to show unanswered only'}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 transition ${
          unansweredOnly ? 'bg-rose-600 text-white ring-rose-600' : 'bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100'
        }`}
      >
        <MessageSquareWarning className="h-3 w-3" />
        Unanswered {v(data?.unanswered)}
      </button>
      <span>
        Active <span className="font-semibold text-slate-700">{v(data?.active)}</span>
      </span>
      <span aria-hidden>·</span>
      <span>
        Avg response <span className="font-semibold text-slate-700">{data ? durationLabel(data.averageFirstResponseSeconds) : '—'}</span>
      </span>
    </div>
  );
}
