import { useState } from 'react';
import { newId } from '@oto/shared';
import { ApiError } from '@/api/client';
import { benefitsApi } from '@/api/benefits';
import { currentLane, isBoxLaneTrigger, laneStation } from '@/lib/lane';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, ArrowRight, Gift, ScanLine } from 'lucide-react';

/**
 * A staff benefit QR the order station has scanned (S2-21 round 3): the QR,
 * which travels with the order to the platform on every quote and on the
 * commit, the application id minted for this scan, and whose it is.
 *
 * `provisional` is a QR taken with the link down: the box checks it when it
 * prices the order, and names the person then.
 */
export interface ScannedBenefit {
  code: string;
  applicationId: string;
  name: string | null;
  benefitRole: 'owner' | 'manager' | 'staff' | null;
  provisional: boolean;
}

/**
 * Scan (or type) a staff benefit QR code to apply that staff member's benefit
 * to the cart.
 *
 * The prototype looked the code up in its in-memory roster
 * (`findOperatorByBenefitQrCode`) and checked the profile there; the platform
 * checks it now (`POST /benefits/resolve`): the signature, the revocation, the
 * person and their profile today. The refusals arrive in the prototype's own
 * words — `No staff benefit found for "<code>".` and `<name> has no benefit
 * configured.` — and in the platform's for what the prototype could not
 * refuse (a revoked or expired QR, someone who has left). The dialog, its
 * title, its text and its button are the prototype's, unchanged.
 */
export function BenefitScanModal({
  open,
  onOpenChange,
  onScanned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScanned: (benefit: ScannedBenefit) => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accept = (benefit: ScannedBenefit) => {
    setError(null);
    setCode('');
    onScanned(benefit);
    onOpenChange(false);
  };

  const submit = async () => {
    const value = code.trim();
    if (!value || busy) return;
    // With the link down the counter's box checks the QR when it prices the
    // order — comp and the standing percent apply there, free items and credit
    // are online only — so the scan is taken and the box's answer names it.
    const provisional = (): ScannedBenefit => ({
      code: value,
      applicationId: newId(),
      name: null,
      benefitRole: null,
      provisional: true,
    });
    if (laneStation() && currentLane() === 'box') {
      accept(provisional());
      return;
    }
    setBusy(true);
    try {
      const resolved = await benefitsApi.resolve(value);
      accept({
        code: value,
        applicationId: newId(),
        name: resolved.name,
        benefitRole: resolved.benefitRole,
        provisional: false,
      });
    } catch (err) {
      if (laneStation() && isBoxLaneTrigger(err)) {
        accept(provisional());
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('The staff benefit could not be checked. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCode('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Gift className="w-5 h-5 text-primary" />
            <DialogTitle>Scan staff benefit</DialogTitle>
          </div>
          <DialogDescription>
            Scan or type the staff member's benefit QR code to apply their comp,
            free items, credit, or discount to this order.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex gap-2"
        >
          <Input
            autoFocus
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Benefit QR code"
            className="h-12 text-lg"
          />
          <Button type="submit" size="lg" disabled={!code.trim() || busy}>
            Apply
            <ArrowRight className="w-4 h-4" />
          </Button>
        </form>

        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-foreground/40">
          <ScanLine className="w-3.5 h-3.5 shrink-0" />
          Look up the staff member's QR in Admin → Staff Benefits.
        </div>
      </DialogContent>
    </Dialog>
  );
}
