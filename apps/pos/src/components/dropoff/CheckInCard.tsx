import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckIn, ContactChannel } from '@/types';
import { remainingMinutes, dueState, formatRemaining } from '@/lib/dropoff';
import { deriveWaStatus, showWaActions } from '@/lib/waConnection';
import { WaChip } from './WaChip';
import { WaActionPanel } from './WaActionPanel';
import {
  MessageCircle,
  UserPlus,
  LogIn,
  LogOut,
  Pencil,
  AlertTriangle,
  Clock,
  CalendarClock,
  Baby,
  Users,
} from 'lucide-react';

interface CheckInCardProps {
  checkIn: CheckIn;
  // Other children registered on the SAME parent web-form (same registrationId).
  // Empty for a single-child booking; drives the "booking of N kids" indicator.
  siblings: CheckIn[];
  onMessage: (checkIn: CheckIn) => void;
  onAssignNanny: (checkIn: CheckIn) => void;
  onCheckIn: (checkIn: CheckIn) => void;
  onCheckOut: (checkIn: CheckIn) => void;
  onMarkArrived: (checkIn: CheckIn) => void;
  onEdit: (checkIn: CheckIn) => void;
  onResend: (checkIn: CheckIn) => void;
  onSimulateConfirm: (checkIn: CheckIn) => void;
  onMarkFailed: (checkIn: CheckIn) => void;
  onSaveAndResend: (checkIn: CheckIn, newPhone: string, newChannel: ContactChannel) => void;
}

// Live elapsed duration since an ISO timestamp, formatted "40m" / "1h 05m".
function useElapsed(sinceISO?: string): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sinceISO) return;
    const id = window.setInterval(() => tick((t) => t + 1), 1000);
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
  iso
    ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '';

export function CheckInCard({
  checkIn,
  siblings,
  onMessage,
  onAssignNanny,
  onCheckIn,
  onCheckOut,
  onMarkArrived,
  onEdit,
  onResend,
  onSimulateConfirm,
  onMarkFailed,
  onSaveAndResend,
}: CheckInCardProps) {
  const elapsed = useElapsed(checkIn.status === 'in_park' ? checkIn.checkedInAt : undefined);
  const isNanny = checkIn.serviceType === 'nanny';

  const remaining = checkIn.status === 'in_park' ? remainingMinutes(checkIn) : null;
  const due = dueState(remaining);
  const timerTone =
    due === 'overdue'
      ? 'text-red-400'
      : due === 'due_soon'
        ? 'text-amber-400'
        : 'text-emerald-400';

  // Effective WA status + whether to offer the action panel — shared with the
  // mobile shell via lib/waConnection so both surfaces stay in lockstep.
  const waStatus = deriveWaStatus(checkIn);
  const waActions = showWaActions(waStatus);

  return (
    <Card className="p-4 flex flex-col gap-3 bg-card/50">
      {/* Top: identity */}
      <div className="flex items-start gap-3">
        <div className="w-14 h-14 rounded-2xl overflow-hidden bg-muted shrink-0 flex items-center justify-center">
          {checkIn.childPhotoUrl ? (
            <img
              src={checkIn.childPhotoUrl}
              alt={checkIn.childName}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-xl font-black text-muted-foreground">
              {checkIn.childName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold leading-tight truncate">{checkIn.childName}</span>
            <span className="text-[10px] font-bold rounded-full px-2 py-0.5 bg-muted text-muted-foreground shrink-0">
              {checkIn.childAge} yrs
            </span>
            <span
              className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0 ${
                isNanny
                  ? 'bg-sky-500/15 text-sky-400'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {isNanny ? 'Nanny' : 'Drop-Off'}
            </span>
          </div>
          <div className="text-sm text-muted-foreground truncate mt-0.5">
            {checkIn.parentName}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate">
            {checkIn.phone}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onEdit(checkIn)}
          aria-label="Edit registration"
          className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Pencil className="w-4 h-4" />
        </button>
      </div>

      {/* Sibling booking: same parent web-form registered more than one child */}
      {siblings.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-violet-500/10 px-2.5 py-2 text-xs">
          <span className="flex items-center gap-1.5 font-bold text-violet-300">
            <Users className="w-3.5 h-3.5 shrink-0" />
            Booking of {siblings.length + 1} kids
          </span>
          <span className="text-violet-200/80 leading-snug">
            With{' '}
            {siblings
              .map((s) => `${s.childName} · ${s.childAge} yrs`)
              .join(', ')}
          </span>
        </div>
      )}

      {/* Nanny / allergies / status / WA connection meta */}
      <div className="flex flex-col gap-1.5 text-xs">
        {checkIn.assignedNannyName && (
          <span className="flex items-center gap-1.5 text-sky-400 font-semibold">
            <Baby className="w-3.5 h-3.5" />
            Nanny: {checkIn.assignedNannyName}
          </span>
        )}
        {checkIn.allergiesMedical && (
          <span className="flex items-start gap-1.5 text-amber-400 font-medium">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {checkIn.allergiesMedical}
          </span>
        )}
        {checkIn.status === 'in_park' && (
          <span className={`flex items-center gap-1.5 font-bold tabular-nums ${timerTone}`}>
            {due === 'overdue' ? (
              <AlertTriangle className="w-3.5 h-3.5" />
            ) : (
              <Clock className="w-3.5 h-3.5" />
            )}
            {remaining != null ? formatRemaining(remaining) : `In park · ${elapsed}`}
          </span>
        )}
        {checkIn.status === 'out' && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <LogOut className="w-3.5 h-3.5" />
            Checked out · {fmtTime(checkIn.checkedOutAt)}
          </span>
        )}
        {checkIn.status === 'registered' && checkIn.scheduledFor && (
          <span className="flex items-center gap-1.5 text-violet-400 font-semibold">
            <CalendarClock className="w-3.5 h-3.5" />
            Scheduled · {fmtTime(checkIn.scheduledFor)}
          </span>
        )}
        {/* WA connection chip — only for WhatsApp contacts with a phone number */}
        <WaChip status={waStatus} channel={checkIn.contactMethod} />
      </div>

      {/* WA action panel: shown for pending / failed / unverified connections */}
      {waActions && waStatus && (
        <WaActionPanel
          checkIn={checkIn}
          waStatus={waStatus}
          onResend={onResend}
          onSimulateConfirm={onSimulateConfirm}
          onMarkFailed={onMarkFailed}
          onSaveAndResend={onSaveAndResend}
          variant="compact"
        />
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="h-11 flex-1 min-w-[120px] gap-1.5"
          onClick={() => onMessage(checkIn)}
        >
          <MessageCircle className="w-4 h-4" />
          Message
        </Button>

        {checkIn.status !== 'out' && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onAssignNanny(checkIn)}
          >
            <UserPlus className="w-4 h-4" />
            {checkIn.assignedNannyName ? 'Change Nanny' : 'Assign Nanny'}
          </Button>
        )}

        {checkIn.status === 'registered' && checkIn.scheduledFor && (
          <Button
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onMarkArrived(checkIn)}
          >
            <LogIn className="w-4 h-4" />
            Mark Arrived
          </Button>
        )}

        {checkIn.status === 'registered' && !checkIn.scheduledFor && (
          <Button
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onCheckIn(checkIn)}
          >
            <LogIn className="w-4 h-4" />
            Check in
          </Button>
        )}

        {checkIn.status === 'in_park' && (
          <Button
            variant="destructive"
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onCheckOut(checkIn)}
          >
            <LogOut className="w-4 h-4" />
            Check Out
          </Button>
        )}
      </div>
    </Card>
  );
}
