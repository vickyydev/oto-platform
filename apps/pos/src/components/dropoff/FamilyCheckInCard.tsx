import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckIn, ContactChannel } from '@/types';
import { childNames, familyCheckInActions, familyCheckInNames, remainingMinutes, dueState, formatRemaining } from '@/lib/dropoff';
import { deriveWaStatus, showWaActions } from '@/lib/waConnection';
import { WaChip } from './WaChip';
import { bookedForLabel, boardBookingOf, cancelBookingBlockedBy, type CancellableBooking } from './CancelBookingDialog';
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
  BadgeCheck,
  ShieldCheck,
  Wallet,
  Ban,
} from 'lucide-react';
import { WaActionPanel } from './WaActionPanel';

interface FamilyCheckInCardProps {
  family: CheckIn[];
  onMessage: (checkIn: CheckIn) => void;
  onAssignNanny: (checkIn: CheckIn) => void;
  onCheckIn: (checkIn: CheckIn) => void;
  onCheckOut: (checkIn: CheckIn) => void;
  // Payment-free check-in for booked (already-paid) children — runs only the
  // in-park process, never the till. Receives the booked subset of the family.
  onCheckInBooked: (bookedChildren: CheckIn[]) => void;
  // A child paid for online, whose booking is not redeemed yet: staff go to the
  // booking, which files what the family paid, never to a charge (SCRUM-730).
  onRedeemBooking: (paidOnlineChild: CheckIn) => void;
  onEdit: (checkIn: CheckIn) => void;
  onResend: (checkIn: CheckIn) => void;
  onSimulateConfirm: (checkIn: CheckIn) => void;
  onMarkFailed: (checkIn: CheckIn) => void;
  onSaveAndResend: (checkIn: CheckIn, newPhone: string, newChannel: ContactChannel) => void;
  /** Opens the AuthorizedPickupSheet for this family's registration. */
  onManagePickups: (checkIn: CheckIn) => void;
  /**
   * SCRUM-886 — "Cancel booking" on a waiting, unpaid family, as the till's
   * Add drop-off picker offers it (SCRUM-862): opens the shared confirm.
   */
  onCancelBooking?: (booking: CancellableBooking) => void;
}

const NO_SALE: ReadonlySet<string> = new Set();

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
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

// SCRUM-741 — the board's payment pill, and a Check in named for its children:
// a long name wraps inside the button rather than running out of it.
const PAYMENT_PILL = 'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold';
const NAMED_CHECK_IN = 'min-w-0 whitespace-normal break-words text-center leading-tight';

function StatusBadge({ child }: { child: CheckIn }) {
  const elapsed = useElapsed(child.status === 'in_park' ? child.checkedInAt : undefined);
  const remaining = child.status === 'in_park' ? remainingMinutes(child) : null;
  const due = dueState(remaining);
  const timerTone =
    due === 'overdue' ? 'text-red-400' : due === 'due_soon' ? 'text-amber-400' : 'text-emerald-400';

  if (child.status === 'in_park') {
    return (
      <span className={`flex items-center gap-1 font-bold tabular-nums text-xs ${timerTone}`}>
        {due === 'overdue' ? <AlertTriangle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
        {remaining != null ? formatRemaining(remaining) : `In park · ${elapsed}`}
      </span>
    );
  }
  if (child.status === 'out') {
    return (
      <span className="flex items-center gap-1 text-muted-foreground text-xs">
        <LogOut className="w-3 h-3" />
        Out · {fmtTime(child.checkedOutAt)}
      </span>
    );
  }
  if (child.scheduledFor) {
    const overdue = new Date(child.scheduledFor).getTime() < Date.now();
    return (
      <span
        className={`flex items-center gap-1 font-semibold text-xs ${
          overdue ? 'text-red-400' : 'text-violet-400'
        }`}
      >
        {overdue ? <AlertTriangle className="w-3 h-3" /> : <CalendarClock className="w-3 h-3" />}
        {overdue ? 'Overdue' : 'Scheduled'} · {fmtTime(child.scheduledFor)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-amber-300 text-xs font-semibold">
      <Clock className="w-3 h-3" />
      No arrival time set
    </span>
  );
}

function ChildRow({
  child,
  showStatusBadge,
  onEdit,
  onAssignNanny,
}: {
  child: CheckIn;
  showStatusBadge: boolean;
  onEdit: (c: CheckIn) => void;
  onAssignNanny: (c: CheckIn) => void;
}) {
  const isNanny = child.serviceType === 'nanny';

  return (
    <div className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
      <div className="w-10 h-10 rounded-xl overflow-hidden bg-muted shrink-0 flex items-center justify-center mt-0.5">
        {child.childPhotoUrl ? (
          <img src={child.childPhotoUrl} alt={child.childName} className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-black text-muted-foreground">
            {child.childName.charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-sm leading-tight truncate">{child.childName}</span>
          <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground shrink-0">
            {child.childAge} yrs
          </span>
          <span
            className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 shrink-0 ${
              isNanny ? 'bg-sky-500/15 text-sky-400' : 'bg-muted text-muted-foreground'
            }`}
          >
            {isNanny ? 'Nanny' : 'Drop-Off'}
          </span>
        </div>

        <div className="flex flex-col gap-0.5 mt-0.5">
          {child.assignedNannyName && (
            <span className="flex items-center gap-1 text-sky-400 font-semibold text-xs">
              <Baby className="w-3 h-3" />
              {child.assignedNannyName}
            </span>
          )}
          {child.allergiesMedical && (
            <span className="flex items-start gap-1 text-amber-400 font-medium text-xs">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              {child.allergiesMedical}
            </span>
          )}
          {showStatusBadge && <StatusBadge child={child} />}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-1">
        {isNanny && child.status !== 'out' && (
          <button
            type="button"
            onClick={() => onAssignNanny(child)}
            aria-label={`Assign nanny to ${child.childName}`}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
          >
            <UserPlus className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onEdit(child)}
          aria-label={`Edit ${child.childName}`}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function FamilyCheckInCard({
  family,
  onMessage,
  onAssignNanny,
  onCheckIn,
  onCheckOut,
  onCheckInBooked,
  onRedeemBooking,
  onEdit,
  onResend,
  onSimulateConfirm,
  onMarkFailed,
  onSaveAndResend,
  onManagePickups,
  onCancelBooking,
}: FamilyCheckInCardProps) {
  const rep = family[0];
  const isMulti = family.length > 1;

  const waStatus = deriveWaStatus(rep);
  const waActions = showWaActions(waStatus);

  const allSameStatus = family.every((c) => c.status === family[0].status);

  const { toRedeem, booked: scheduledChildren, walkUp } = familyCheckInActions(family);
  const anyRegistered = walkUp.length > 0;
  const anyScheduled = scheduledChildren.length > 0;
  const anyToRedeem = toRedeem.length > 0;
  const anyInPark = family.some((c) => c.status === 'in_park');

  const registeredChild = walkUp[0] ?? rep;
  const inParkChild = family.find((c) => c.status === 'in_park') ?? rep;

  // SCRUM-741 — more than one Check in: each names the children it checks in,
  // and a family with a child paid for and one still to pay says which is which.
  const names = familyCheckInNames(family);
  const namedCheckIns = [anyToRedeem, anyScheduled, anyRegistered].filter(Boolean).length > 1;
  const checkInLabel = (children: readonly CheckIn[]) =>
    namedCheckIns ? <span className={NAMED_CHECK_IN}>Check in {childNames(children)}</span> : 'Check in';

  // SCRUM-886 — the picker's Cancel booking, with its refusals: hidden when
  // every waiting child is paid, disabled with the reason while one is paid or
  // a sibling is already checked in. The board holds no sale of its own.
  const cancellable = onCancelBooking ? boardBookingOf(family) : null;
  const cancelBlock = cancellable ? cancelBookingBlockedBy(cancellable, NO_SALE) : null;
  const bookedFor = bookedForLabel(family);

  return (
    <Card className="p-4 flex flex-col gap-3 bg-card/50">
      {/* Family header: parent info + child count */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold leading-tight truncate">{rep.parentName}</span>
            {isMulti && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-violet-300 bg-violet-500/10 rounded-full px-2 py-0.5 shrink-0">
                <Users className="w-3 h-3" />
                {family.length} children
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">{rep.phone}</div>
          {bookedFor && (
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400 mt-0.5">
              <CalendarClock className="w-3 h-3" />
              {bookedFor}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-2 gap-1 text-muted-foreground hover:text-primary"
            onClick={() => onManagePickups(rep)}
            title="Manage authorized pickups"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 px-3 gap-1.5"
            onClick={() => onMessage(rep)}
          >
            <MessageCircle className="w-3.5 h-3.5" />
            Message
          </Button>
        </div>
      </div>

      {/* WA connection: shown once at family level */}
      <div className="flex items-center gap-2">
        <WaChip status={waStatus} channel={rep.contactMethod} />
      </div>

      {waActions && waStatus && (
        <WaActionPanel
          checkIn={rep}
          waStatus={waStatus}
          onResend={onResend}
          onSimulateConfirm={onSimulateConfirm}
          onMarkFailed={onMarkFailed}
          onSaveAndResend={onSaveAndResend}
          variant="compact"
        />
      )}

      {/* Children list — dividers only for multi-child families */}
      <div className={isMulti ? 'divide-y divide-border rounded-lg bg-muted/30 px-3 py-1' : ''}>
        {family.map((child) => (
          <ChildRow
            key={child.id}
            child={child}
            showStatusBadge={!allSameStatus}
            onEdit={onEdit}
            onAssignNanny={onAssignNanny}
          />
        ))}
      </div>

      {/* Shared status line when all children have the same status */}
      {allSameStatus && (
        <div className="flex flex-col gap-1 text-xs">
          <StatusBadge child={rep} />
        </div>
      )}

      {/* Booked & paid online — no payment is taken at check-in. */}
      {(anyScheduled || anyToRedeem) && !names.split && (
        <div className="flex items-center gap-1.5 self-start rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-400">
          <BadgeCheck className="w-3.5 h-3.5" />
          Booked &amp; paid · no payment needed
        </div>
      )}

      {/* SCRUM-741 — a child paid for and a sibling still to pay: by name. */}
      {names.split && (
        <div className="flex flex-wrap items-center gap-1.5">
          <div className={`${PAYMENT_PILL} bg-emerald-500/15 text-emerald-400`}>
            <BadgeCheck className="w-3.5 h-3.5 shrink-0" />
            Booked &amp; paid · {childNames(names.split.paid)}
          </div>
          <div className={`${PAYMENT_PILL} bg-amber-500/15 text-amber-600 dark:text-amber-400`}>
            <Wallet className="w-3.5 h-3.5 shrink-0" />
            To pay · {childNames(names.split.toPay)}
          </div>
        </div>
      )}

      {/* Family-level action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        {anyToRedeem && (
          <Button
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onRedeemBooking(toRedeem[0])}
          >
            <LogIn className="w-4 h-4" />
            {checkInLabel(names.redeem)}
          </Button>
        )}

        {anyScheduled && (
          <Button
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onCheckInBooked(scheduledChildren)}
          >
            <LogIn className="w-4 h-4" />
            {checkInLabel(scheduledChildren)}
          </Button>
        )}

        {anyRegistered && (
          <Button
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onCheckIn(registeredChild)}
          >
            <LogIn className="w-4 h-4" />
            {checkInLabel(walkUp)}
          </Button>
        )}

        {anyInPark && (
          <Button
            variant="destructive"
            size="sm"
            className="h-11 flex-1 min-w-[120px] gap-1.5"
            onClick={() => onCheckOut(inParkChild)}
          >
            <LogOut className="w-4 h-4" />
            Check Out
          </Button>
        )}

        {cancellable && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 gap-1.5"
            disabled={cancelBlock !== null}
            onClick={() => onCancelBooking?.(cancellable)}
          >
            <Ban className="w-4 h-4" />
            Cancel booking
          </Button>
        )}
      </div>
      {cancelBlock && <p className="text-xs text-muted-foreground">{cancelBlock}</p>}
    </Card>
  );
}
