import { Operator } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { QrCode } from '@/components/till/QrCode';

/** Shows a staff member's scannable benefit QR (mock pattern, keyed by benefitQrCode). */
export function BenefitQrDialog({
  operator,
  open,
  onOpenChange,
}: {
  operator: Operator | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{operator?.name ?? 'Benefit QR'}</DialogTitle>
          <DialogDescription>
            Scan at the F&amp;B order station to apply this staff member's benefit.
          </DialogDescription>
        </DialogHeader>
        {operator && (
          <div className="flex flex-col items-center gap-3 py-2">
            <QrCode seed={operator.benefitQrCode ?? operator.id} className="h-48 w-48" />
            <span className="font-mono text-xs text-foreground/50">
              {operator.benefitQrCode}
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
