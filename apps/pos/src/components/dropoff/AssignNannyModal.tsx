import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckIn } from '@/types';
import { getNannyRoster, getDropOffPricing } from '@/mockApi';
import { BadgeCheck, Baby, UserCheck, AlertTriangle } from 'lucide-react';

interface AssignNannyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkIn: CheckIn;
  /** Called with the chosen nanny id once confirmed. */
  onAssign: (nannyId: string) => void;
}

export function AssignNannyModal({
  open,
  onOpenChange,
  checkIn,
  onAssign,
}: AssignNannyModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nannies = getNannyRoster(checkIn.id);
  const softMax = getDropOffPricing().nannyRatioSoftMax;
  const selectedNanny = nannies.find((n) => n.id === selectedId);
  // Load if SHE took this child too (her current active kids + this one).
  const overRatio = !!selectedNanny && selectedNanny.load + 1 > softMax;

  useEffect(() => {
    if (open) setSelectedId(checkIn.assignedNannyId ?? null);
  }, [open, checkIn.assignedNannyId]);

  const handleConfirm = () => {
    if (!selectedId) return;
    onAssign(selectedId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-primary" />
            Assign a nanny
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Baby className="w-4 h-4" />
            {checkIn.childName} · {checkIn.childAge} yrs
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              On shift now <span className="text-destructive">*</span>
            </p>
            <p className="text-xs text-muted-foreground">
              A nanny can look after several children — pick anyone on shift.
            </p>
            <div className="grid grid-cols-1 gap-2">
              {nannies.map((n) => {
                const disabled = !n.available;
                const selected = selectedId === n.id;
                const status = !n.onShift
                  ? 'Off shift'
                  : n.load > 0
                    ? `${n.load} ${n.load === 1 ? 'kid' : 'kids'}`
                    : 'Available';
                const willBeOver = n.onShift && n.load + 1 > softMax;
                return (
                  <Button
                    key={n.id}
                    type="button"
                    disabled={disabled}
                    variant={selected ? 'default' : 'outline'}
                    className="h-16 justify-between text-base px-4"
                    onClick={() => setSelectedId(n.id)}
                  >
                    <span className="flex items-center gap-3">
                      <span className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold shrink-0">
                        {n.name.charAt(0).toUpperCase()}
                      </span>
                      {n.name}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        disabled
                          ? 'text-muted-foreground'
                          : willBeOver
                            ? 'text-amber-300'
                            : 'text-emerald-400'
                      }`}
                    >
                      {status}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>

          {overRatio && selectedNanny && (
            <div className="flex items-start gap-2 text-sm text-amber-300 bg-amber-300/10 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {selectedNanny.name} would be looking after {selectedNanny.load + 1} children
                (over the suggested {softMax}). Allowed — just double-check it's okay.
              </span>
            </div>
          )}

          <Button
            className="w-full h-14 text-lg gap-2"
            disabled={!selectedId}
            onClick={handleConfirm}
          >
            <BadgeCheck className="w-5 h-5" />
            {selectedId
              ? `Assign ${nannies.find((n) => n.id === selectedId)?.name ?? 'nanny'}`
              : 'Choose a nanny'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
