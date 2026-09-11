import { CheckIn, ContactChannel } from '@/types';
import { CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import { remainingMinutes, dueState, formatRemaining } from '@/lib/dropoff';
import { deriveWaStatus, showWaActions } from '@/lib/waConnection';
import { WaChip } from '@/components/dropoff/WaChip';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ArrowLeft,
  Baby,
  MessageCircle,
  UserPlus,
  LogIn,
  LogOut,
  Pencil,
  AlertTriangle,
  Clock,
  Users,
  CalendarClock,
  ShieldCheck,
} from 'lucide-react';
import { WaActionPanel } from '@/components/dropoff/WaActionPanel';

interface MobileChildDetailProps {
  family: CheckIn[];
  onBack: () => void;
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
  /** Opens the AuthorizedPickupSheet for this family's registration. */
  onManagePickups: (checkIn: CheckIn) => void;
}

const fmtTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

function ChildSection({
  child,
  showStatusBlock,
  onEdit,
  onAssignNanny,
}: {
  child: CheckIn;
  showStatusBlock: boolean;
  onEdit: (c: CheckIn) => void;
  onAssignNanny: (c: CheckIn) => void;
}) {
  const isNanny = child.serviceType === 'nanny';
  const remaining = child.status === 'in_park' ? remainingMinutes(child) : null;
  const due = dueState(remaining);
  const timerBg =
    due === 'overdue'
      ? 'text-red-400 bg-red-500/10 border-red-500/30'
      : due === 'due_soon'
        ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
        : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';

  return (
    <div className="rounded-2xl bg-card/50 border border-border p-4 space-y-3">
      {/* Identity row */}
      <div className="flex items-start gap-3">
        <div className="w-14 h-14 rounded-2xl overflow-hidden bg-muted shrink-0 flex items-center justify-center">
          {child.childPhotoUrl ? (
            <img src={child.childPhotoUrl} alt={child.childName} className="w-full h-full object-cover" />
          ) : (
            <span className="text-2xl font-black text-muted-foreground">
              {child.childName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-black truncate">{child.childName}</h3>
            <span className="text-xs font-bold rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
              {child.childAge} yrs
            </span>
            <span
              className={`text-xs font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${
                isNanny ? 'bg-sky-500/15 text-sky-400' : 'bg-muted text-muted-foreground'
              }`}
            >
              {isNanny ? 'Nanny' : 'Drop-Off'}
            </span>
          </div>

          {child.assignedNannyName && (
            <div className="flex items-center gap-1 mt-1 text-sky-400 text-xs font-semibold">
              <Baby className="w-3 h-3" />
              {child.assignedNannyName}
            </div>
          )}
        </div>

        {/* Per-child edit + assign nanny */}
        <div className="flex items-center gap-1 shrink-0">
          {isNanny && child.status !== 'out' && (
            <button
              type="button"
              onClick={() => onAssignNanny(child)}
              aria-label={`Assign nanny to ${child.childName}`}
              className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
            >
              <UserPlus className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onEdit(child)}
            aria-label={`Edit ${child.childName}`}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Allergy / medical */}
      {child.allergiesMedical && (
        <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-3 py-2 flex items-start gap-2 text-amber-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-amber-400 mb-0.5">
              Staff only · Allergy / medical
            </div>
            <div className="text-sm font-semibold leading-snug">{child.allergiesMedical}</div>
          </div>
        </div>
      )}

      {/* Food */}
      <div className="rounded-xl bg-muted/50 border border-border px-3 py-2 text-sm flex items-center justify-between">
        <span className="text-muted-foreground font-semibold">May order food</span>
        <span className={`font-bold ${child.mayOrderFood ? 'text-emerald-400' : 'text-red-400'}`}>
          {child.mayOrderFood ? 'Yes' : 'No'}
        </span>
      </div>

      {child.foodRestrictions && (
        <div className="rounded-xl bg-muted/50 border border-border px-3 py-2 text-sm">
          <span className="font-semibold text-muted-foreground">Dietary note: </span>
          {child.foodRestrictions}
        </div>
      )}

      {/* Status (shown when children have different statuses) */}
      {showStatusBlock && (
        <>
          {child.status === 'in_park' && (
            <div className={`rounded-xl border px-3 py-2 flex items-center gap-2 font-bold tabular-nums text-sm ${timerBg}`}>
              {due === 'overdue' ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <Clock className="w-4 h-4 shrink-0" />}
              {remaining != null ? formatRemaining(remaining) : 'In park'}
            </div>
          )}
          {child.status === 'registered' && child.scheduledFor && (
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-3 py-2 flex items-center gap-2 text-violet-400 font-semibold text-sm">
              <CalendarClock className="w-4 h-4" />
              Scheduled · {fmtTime(child.scheduledFor)}
            </div>
          )}
        </>
      )}

      {/* Check-in sale summary */}
      {child.checkInSale && (
        <div className="rounded-xl bg-muted/50 border border-border px-3 py-2 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wide">
            <ShieldCheck className="w-3.5 h-3.5" />
            Check-in summary
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{child.checkInSale.ticketName}</span>
            <span className="font-bold">฿{child.checkInSale.ticketPriceTHB}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Service fee</span>
            <span className="font-bold">฿{child.checkInSale.serviceFeeTHB}</span>
          </div>
          <div className="flex justify-between text-sm font-bold border-t border-border pt-2 mt-1">
            <span>Total paid</span>
            <span>฿{child.checkInSale.totalTHB}</span>
          </div>
        </div>
      )}

      {/* Out info */}
      {child.status === 'out' && child.checkedOutAt && (
        <div className="rounded-xl bg-muted/50 border border-border px-3 py-2 text-sm flex items-center gap-2 text-muted-foreground">
          <LogOut className="w-4 h-4 shrink-0" />
          Checked out at {fmtTime(child.checkedOutAt)}
        </div>
      )}
    </div>
  );
}

/**
 * Full-screen portrait family detail view. Shows all children in the registration,
 * each with their own info, per-child edit, and per-nanny-child assign-nanny.
 * Family-level actions (Check In, Check Out, Message, WA block) appear once.
 */
export function MobileChildDetail({
  family,
  onBack,
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
  onManagePickups,
}: MobileChildDetailProps) {
  const rep = family[0];
  const isMulti = family.length > 1;

  const waStatus = deriveWaStatus(rep);
  const waActions = showWaActions(waStatus);

  const allSameStatus = family.every((c) => c.status === family[0].status);

  const anyRegistered = family.some((c) => c.status === 'registered' && !c.scheduledFor);
  const anyScheduled = family.some((c) => c.status === 'registered' && !!c.scheduledFor);
  const anyInPark = family.some((c) => c.status === 'in_park');

  const registeredChild = family.find((c) => c.status === 'registered' && !c.scheduledFor) ?? rep;
  const scheduledChild = family.find((c) => c.status === 'registered' && !!c.scheduledFor) ?? rep;
  const inParkChild = family.find((c) => c.status === 'in_park') ?? rep;

  const allSameInPark = allSameStatus && rep.status === 'in_park';
  const remaining = allSameInPark ? remainingMinutes(rep) : null;
  const due = dueState(remaining);
  const timerBg =
    due === 'overdue'
      ? 'text-red-400 bg-red-500/10 border-red-500/30'
      : due === 'due_soon'
        ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
        : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';

  const headerTitle = isMulti
    ? `${rep.parentName} · ${family.length} kids`
    : family[0].childName;

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-background text-foreground animate-in slide-in-from-right duration-200">
      {/* Header bar */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
        <button
          type="button"
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span className="font-bold flex-1 truncate">{headerTitle}</span>
      </div>

      {/* Scrollable body */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-4 space-y-4">
          {/* Family header: parent + phone + child count */}
          <div className="rounded-2xl bg-card/50 border border-border p-4 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-black truncate">{rep.parentName}</span>
              {isMulti && (
                <span className="flex items-center gap-1 text-xs font-bold text-violet-300 bg-violet-500/10 rounded-full px-2 py-0.5">
                  <Users className="w-3.5 h-3.5" />
                  {family.length} children
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground font-mono">{rep.phone}</p>
          </div>

          {/* WA connection block */}
          {waStatus && (
            <div
              className={`rounded-2xl border px-4 py-3 space-y-3 ${
                waStatus === 'confirmed'
                  ? 'border-emerald-500/20 bg-emerald-500/5'
                  : waStatus === 'pending'
                    ? 'border-amber-500/20 bg-amber-500/5'
                    : 'border-red-500/20 bg-red-500/5'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  {CHANNEL_LABEL[normalizeChannel(rep.contactMethod)]} connection
                </span>
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
                  variant="full"
                />
              )}
            </div>
          )}

          {/* Shared in-park timer (all children same status = in_park) */}
          {allSameInPark && (
            <div
              className={`rounded-xl border px-4 py-3 flex items-center gap-2 font-bold tabular-nums ${timerBg}`}
            >
              {due === 'overdue' ? (
                <AlertTriangle className="w-5 h-5 shrink-0" />
              ) : (
                <Clock className="w-5 h-5 shrink-0" />
              )}
              <span className="text-base">
                {remaining != null ? formatRemaining(remaining) : 'In park'}
              </span>
            </div>
          )}

          {/* Shared scheduled badge (all children same status = scheduled) */}
          {allSameStatus && rep.status === 'registered' && rep.scheduledFor && (
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3 flex items-center gap-2 text-violet-400 font-semibold">
              <CalendarClock className="w-5 h-5" />
              Scheduled · {fmtTime(rep.scheduledFor)}
            </div>
          )}

          {/* Per-child sections */}
          {family.map((child) => (
            <ChildSection
              key={child.id}
              child={child}
              showStatusBlock={!allSameStatus}
              onEdit={onEdit}
              onAssignNanny={onAssignNanny}
            />
          ))}
        </div>
      </ScrollArea>

      {/* Sticky action footer */}
      <div className="shrink-0 border-t bg-card/30 px-4 py-4 space-y-3">
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 h-12 gap-2"
            onClick={() => onMessage(rep)}
          >
            <MessageCircle className="w-4 h-4" />
            Message
          </Button>
          <Button
            variant="outline"
            className="h-12 px-3 gap-1.5 text-muted-foreground hover:text-primary"
            onClick={() => onManagePickups(rep)}
            title="Manage authorized pickups"
          >
            <ShieldCheck className="w-4 h-4" />
            Pickups
          </Button>
        </div>

        {anyScheduled && (
          <Button
            className="w-full h-16 text-lg gap-2 rounded-2xl"
            onClick={() => onMarkArrived(scheduledChild)}
          >
            <LogIn className="w-5 h-5" />
            Mark Arrived
          </Button>
        )}

        {anyRegistered && (
          <Button
            className="w-full h-16 text-lg gap-2 rounded-2xl"
            onClick={() => onCheckIn(registeredChild)}
          >
            <LogIn className="w-5 h-5" />
            Check In
          </Button>
        )}

        {anyInPark && (
          <Button
            variant="destructive"
            className="w-full h-16 text-lg gap-2 rounded-2xl"
            onClick={() => onCheckOut(inParkChild)}
          >
            <LogOut className="w-5 h-5" />
            Check Out
          </Button>
        )}
      </div>
    </div>
  );
}
