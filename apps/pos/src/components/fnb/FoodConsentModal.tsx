import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Wristband } from '@/types';
import { UtensilsCrossed, ShieldX } from 'lucide-react';

interface FoodConsentModalProps {
  open: boolean;
  /** The scanned band whose child is not authorized to order food. */
  wristband: Wristband | null;
  onOpenChange: (open: boolean) => void;
  /** Staff explicitly override the no-food restriction (stamped on the order). */
  onOverride: () => void;
}

// Shown when staff try to add an item to a band whose parent did NOT authorize
// food orders (mayOrderFood:false). Adding is blocked until staff record an
// explicit override, which is stamped onto the finalized order.
export function FoodConsentModal({
  open,
  wristband,
  onOpenChange,
  onOverride,
}: FoodConsentModalProps) {
  const name = wristband?.holderName ?? wristband?.customerNickname ?? 'This child';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-amber-500/50 sm:max-w-lg">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
            <ShieldX className="h-9 w-9" />
          </div>
          <DialogTitle className="text-center text-2xl font-bold text-amber-300">
            Food not authorized
          </DialogTitle>
          <DialogDescription className="text-center">
            {name}&rsquo;s parent did <span className="font-bold text-amber-300">not authorize</span>{' '}
            food orders for this child on the drop-off form.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100/90">
          <div className="flex items-start gap-2">
            <UtensilsCrossed className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <span>
              Only override after confirming with the parent or duty manager. The override is
              recorded against this order with your name.
            </span>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="flex-1 bg-amber-600 font-bold text-white hover:bg-amber-500"
            onClick={onOverride}
          >
            Override &amp; add anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
