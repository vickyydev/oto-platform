import { DropOffServiceType } from '@/types';
import type { CheckInPaymentInput } from '@/mockApi';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Baby, LogIn, CalendarClock, UserCheck, ShieldAlert } from 'lucide-react';

// One drop-off / nanny registration awaiting the door check-in choice. Siblings
// on the same registration are grouped together so staff decide for them as one.
export interface DoorCheckInGroup {
  registrationId: string;
  parentLabel?: string;
  entries: {
    checkInId: string;
    childName: string;
    service: DropOffServiceType;
    input: CheckInPaymentInput;
  }[];
}

const SERVICE_META: Record<DropOffServiceType, { label: string; icon: typeof UserCheck } | null> = {
  nanny: { label: 'Nanny', icon: UserCheck },
  drop_off: { label: 'Drop-off', icon: ShieldAlert },
  none: null,
};

interface DoorCheckInChoiceModalProps {
  // null (or empty) → closed. Each remaining group is shown as a card; once a
  // group is resolved the caller removes it, and the modal closes when none remain.
  groups: DoorCheckInGroup[] | null;
  onCheckInNow: (group: DoorCheckInGroup) => void;
  onLeaveAsBooked: (group: DoorCheckInGroup) => void;
}

/**
 * Post-payment door choice for drop-off / nanny children: per registration, staff
 * pick "Check in now" (issue the band + start the timer) or "Leave as booked"
 * (stay registered, no band, checkable later). The modal requires a decision for
 * every registration — it can't be dismissed until all groups are resolved.
 */
export function DoorCheckInChoiceModal({
  groups,
  onCheckInNow,
  onLeaveAsBooked,
}: DoorCheckInChoiceModalProps) {
  const open = !!groups && groups.length > 0;
  const multi = (groups?.length ?? 0) > 1;

  return (
    <Dialog open={open}>
      {/* No onOpenChange + hidden X — a choice is required for each registration. */}
      <DialogContent className="max-w-md [&>button]:hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Baby className="w-5 h-5 text-primary" />
            Check in the drop-off {multi ? 'children' : 'child'}?
          </DialogTitle>
          <DialogDescription>
            Payment is complete. For each registration, choose whether to check the
            child in now or leave them booked for later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          {(groups ?? []).map((group) => (
            <div key={group.registrationId} className="rounded-2xl border border-border bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {group.entries.map((e) => {
                  const meta = SERVICE_META[e.service];
                  const Icon = meta?.icon;
                  return (
                    <span key={e.checkInId} className="flex items-center gap-1.5">
                      <span className="font-semibold">{e.childName || 'Child'}</span>
                      {meta && Icon && (
                        <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-xs">
                          <Icon className="h-3 w-3" />
                          {meta.label}
                        </Badge>
                      )}
                    </span>
                  );
                })}
              </div>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1 gap-1.5"
                  onClick={() => onLeaveAsBooked(group)}
                >
                  <CalendarClock className="h-4 w-4" />
                  Leave as booked
                </Button>
                <Button
                  className="flex-1 gap-1.5"
                  onClick={() => onCheckInNow(group)}
                >
                  <LogIn className="h-4 w-4" />
                  Check in now
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
