import { Activity, CheckCircle2, Clock3, MessageSquare, MessageSquareWarning } from 'lucide-react';
import type { Dashboard as DashboardData } from '@/api/inbox';
import { CategoryMixCard, MetricCard } from '@/components/atoms';
import { durationLabel, responseScopeLabel } from '@/lib/view';

/**
 * The manager dashboard: the 3 × 2 grid of screenshot 1, on the IT Brief's
 * figures (plan §3.3 `GET /inbox/dashboard`). "Unassigned" and "Needs manager"
 * are gone with the statuses that made them (nobody is ever unowned), so
 * their places hold Unanswered — clickable, it filters the list, as the
 * prototype's card does (:1367-1375) — and Active. The BEO card waits on the
 * event orders (owner Q23).
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
  const v = (n: number | undefined) => (n === undefined ? '—' : n);
  // Whose average it is (test night U9): the api's `scope`; an api without one leaves the card as before.
  const scope = data ? responseScopeLabel(data.scope) : null;
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-busy={data === null}>
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
