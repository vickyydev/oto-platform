import { useEffect, useState } from 'react';
import { CheckIn } from '@/types';
import { remainingMinutes, dueState, formatRemaining } from '@/lib/dropoff';
import { deriveWaStatus } from '@/lib/waConnection';
import { WaChip } from '@/components/dropoff/WaChip';
import { AlertTriangle, Clock, Users, CalendarClock, LogOut } from 'lucide-react';

interface MobileChildCardProps {
  family: CheckIn[];
  onTap: (family: CheckIn[]) => void;
}

function useElapsed(sinceISO?: string): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sinceISO) return;
    const id = window.setInterval(() => tick((t) => t + 1), 1_000);
    return () => window.clearInterval(id);
  }, [sinceISO]);
  if (!sinceISO) return '';
  const ms = Date.now() - new Date(sinceISO).getTime();
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

const fmtTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

function ChildStatusLine({ child }: { child: CheckIn }) {
  const elapsed = useElapsed(child.status === 'in_park' ? child.checkedInAt : undefined);
  const remaining = child.status === 'in_park' ? remainingMinutes(child) : null;
  const due = dueState(remaining);
  const timerColor =
    due === 'overdue' ? 'text-red-400' : due === 'due_soon' ? 'text-amber-400' : 'text-emerald-400';

  if (child.status === 'in_park') {
    return (
      <span className={`flex items-center gap-1 text-[10px] font-bold tabular-nums ${timerColor}`}>
        {due === 'overdue' ? <AlertTriangle className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
        {remaining != null ? formatRemaining(remaining) : `${elapsed} in park`}
      </span>
    );
  }
  if (child.status === 'out') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <LogOut className="w-2.5 h-2.5" />
        Out · {fmtTime(child.checkedOutAt)}
      </span>
    );
  }
  if (child.scheduledFor) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-violet-400">
        <CalendarClock className="w-2.5 h-2.5" />
        Scheduled · {fmtTime(child.scheduledFor)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-amber-300 font-semibold">
      <Clock className="w-2.5 h-2.5" />
      No arrival time set
    </span>
  );
}

function SharedStatusFooter({ family }: { family: CheckIn[] }) {
  const rep = family[0];
  const elapsed = useElapsed(rep.status === 'in_park' ? rep.checkedInAt : undefined);
  const remaining = rep.status === 'in_park' ? remainingMinutes(rep) : null;
  const due = dueState(remaining);

  const worstDue = family.reduce<'overdue' | 'due_soon' | 'ok'>((acc, c) => {
    const d = dueState(remainingMinutes(c));
    if (acc === 'overdue' || d === 'overdue') return 'overdue';
    if (acc === 'due_soon' || d === 'due_soon') return 'due_soon';
    return 'ok';
  }, 'ok');

  const timerColor =
    worstDue === 'overdue' ? 'text-red-400'
      : worstDue === 'due_soon' ? 'text-amber-400'
        : 'text-emerald-400';

  if (rep.status === 'in_park') {
    return (
      <span className={`flex items-center gap-1 ${timerColor}`}>
        {worstDue === 'overdue' ? <AlertTriangle className="w-3 h-3 shrink-0" /> : <Clock className="w-3 h-3 shrink-0" />}
        {remaining != null ? formatRemaining(remaining) : `${elapsed} in park`}
      </span>
    );
  }
  if (rep.status === 'out') {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <LogOut className="w-3 h-3" />
        Out · {fmtTime(rep.checkedOutAt)}
      </span>
    );
  }
  if (rep.scheduledFor) {
    return (
      <span className="flex items-center gap-1 text-violet-400">
        <CalendarClock className="w-3 h-3" />
        Scheduled · {fmtTime(rep.scheduledFor)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-amber-300">
      <Clock className="w-3 h-3" />
      No arrival time set
    </span>
  );
}

function ChildPip({
  child,
  showStatus,
}: {
  child: CheckIn;
  showStatus: boolean;
}) {
  const isNanny = child.serviceType === 'nanny';
  return (
    <div className="flex items-start gap-1.5">
      <div className="w-7 h-7 rounded-full overflow-hidden bg-muted shrink-0 flex items-center justify-center mt-0.5">
        {child.childPhotoUrl ? (
          <img src={child.childPhotoUrl} alt={child.childName} className="w-full h-full object-cover" />
        ) : (
          <span className="text-[11px] font-black text-muted-foreground">
            {child.childName.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs font-bold truncate">{child.childName}</span>
          <span className="text-[10px] text-muted-foreground">{child.childAge} yrs</span>
          <span
            className={`text-[10px] font-bold uppercase rounded-full px-1.5 py-px shrink-0 ${
              isNanny ? 'bg-sky-500/15 text-sky-400' : 'bg-muted text-muted-foreground'
            }`}
          >
            {isNanny ? 'Nanny' : 'Drop-Off'}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-0.5">
          {child.allergiesMedical && (
            <span className="flex items-center gap-0.5 text-amber-400 text-[10px] font-medium">
              <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
              Allergy
            </span>
          )}
          {showStatus && <ChildStatusLine child={child} />}
        </div>
      </div>
    </div>
  );
}

export function MobileChildCard({ family, onTap }: MobileChildCardProps) {
  const rep = family[0];
  const isMulti = family.length > 1;
  const waStatus = deriveWaStatus(rep);

  const allSameStatus = family.every((c) => c.status === family[0].status);
  const showPerChildStatus = !allSameStatus;

  const worstDue = family.reduce<'overdue' | 'due_soon' | 'ok'>((acc, c) => {
    const d = dueState(remainingMinutes(c));
    if (acc === 'overdue' || d === 'overdue') return 'overdue';
    if (acc === 'due_soon' || d === 'due_soon') return 'due_soon';
    return 'ok';
  }, 'ok');

  const cardBorder =
    worstDue === 'overdue' ? 'border-red-500/40 bg-red-500/5'
      : worstDue === 'due_soon' ? 'border-amber-500/40 bg-amber-500/5'
        : 'border-border bg-card/50';

  return (
    <button
      type="button"
      onClick={() => onTap(family)}
      className={`w-full text-left rounded-2xl border p-4 flex flex-col gap-2 active:scale-[0.98] transition-transform ${cardBorder}`}
    >
      {/* Family header row */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold truncate">{rep.parentName}</span>
            {isMulti && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-violet-300 bg-violet-500/10 rounded-full px-1.5 py-0.5 shrink-0">
                <Users className="w-3 h-3" />
                {family.length} kids
              </span>
            )}
          </div>
          {waStatus && (
            <div className="mt-0.5">
              <WaChip status={waStatus} channel={rep.contactMethod} />
            </div>
          )}
        </div>

        {/* Chevron */}
        <svg
          className="w-4 h-4 text-muted-foreground shrink-0 mt-1"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>

      {/* Children rows — each with photo, name, age, badge, allergy, and per-child status when mixed */}
      <div className="flex flex-col gap-2">
        {family.map((child) => (
          <ChildPip key={child.id} child={child} showStatus={showPerChildStatus} />
        ))}
      </div>

      {/* Shared status footer — shown when all children have the same status */}
      {allSameStatus && (
        <div className="text-xs font-bold tabular-nums flex items-center gap-1">
          <SharedStatusFooter family={family} />
        </div>
      )}
    </button>
  );
}
