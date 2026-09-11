import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CustomerTier, Member, TierVerification } from '@/types';
import { getProofTypes, verifyMemberTier } from '@/mockApi';
import { tierLabel } from '@/lib/membership';
import { BadgeCheck, ShieldCheck } from 'lucide-react';

interface VerifyTierModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The discounted tier being verified (expat | thai). */
  tier: CustomerTier;
  /** Existing member, or null when the customer hasn't given their details yet. */
  member: Member | null;
  operatorId: string;
  operatorName: string;
  onConfirm: (result: { member: Member | null; verification: TierVerification }) => void;
}

export function VerifyTierModal({
  open,
  onOpenChange,
  tier,
  member,
  operatorId,
  operatorName,
  onConfirm,
}: VerifyTierModalProps) {
  const [proofType, setProofType] = useState<string | null>(null);
  const proofTypes = getProofTypes();

  useEffect(() => {
    if (open) setProofType(null);
  }, [open]);

  const canConfirm = !!proofType;

  const handleConfirm = () => {
    if (!proofType) return;
    const verification: TierVerification = {
      tier,
      proofType,
      verifiedBy: operatorName,
      verifiedById: operatorId,
      verifiedAt: new Date().toISOString(),
    };
    // Existing member: stamp now. New customer: defer until they key in their
    // phone & nickname at the input step, then the profile gets saved.
    if (member) verifyMemberTier(member.id, verification);
    onConfirm({ member, verification });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            Verify {tierLabel(tier)} rate
          </DialogTitle>
          <DialogDescription>
            Checked by {operatorName}.
            {member
              ? ' Saved to the member profile so they won\u2019t be asked again.'
              : ' Saved to their profile once they enter their details.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {member && (
            <div className="flex items-center gap-3 rounded-lg bg-muted p-4">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center text-primary font-bold shrink-0">
                {member.nickname.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="font-bold truncate">{member.nickname}</div>
                <div className="text-sm text-muted-foreground truncate">{member.phone}</div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Proof checked <span className="text-destructive">*</span>
            </p>
            <div className="grid grid-cols-1 gap-2">
              {proofTypes.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={proofType === p ? 'default' : 'outline'}
                  className="h-14 justify-start text-base"
                  onClick={() => setProofType(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>

          <Button className="w-full h-14 text-lg gap-2" disabled={!canConfirm} onClick={handleConfirm}>
            <BadgeCheck className="w-5 h-5" />
            {proofType
              ? `Verify ${tierLabel(tier)} — ${proofType}`
              : 'Choose proof to verify'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
