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
import { membersApi } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { tierLabel } from '@/lib/membership';
import { toast } from '@/hooks/use-toast';
import { BadgeCheck, CalendarClock, Loader2, ShieldCheck, UserCheck } from 'lucide-react';

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

/** Members loaded from the platform API carry UUID ids; mock sale-flow members
 *  (Sprint 2 territory) don't — only the former can be persisted right now. */
const isApiMemberId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const todayIso = () => new Date().toISOString().slice(0, 10);

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
  const [otherDoc, setOtherDoc] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const proofTypes = getProofTypes();

  useEffect(() => {
    if (open) {
      setProofType(null);
      setOtherDoc('');
      setExpiresAt('');
      setBusy(false);
    }
  }, [open]);

  const isOther = proofType === 'Other';
  const expiryValid = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt) && expiresAt >= todayIso();
  const canConfirm = !!proofType && (!isOther || otherDoc.trim().length > 0) && expiryValid && !busy;

  const handleConfirm = async () => {
    if (!proofType || !expiryValid || (isOther && !otherDoc.trim())) return;
    const verification: TierVerification = {
      tier,
      proofType,
      verifiedBy: operatorName,
      verifiedById: operatorId,
      verifiedAt: new Date().toISOString(),
      expiresAt,
    };

    // Existing API member: persist now — the server stamps WHO checked it from
    // the session (hard-fixed, not client-supplied), plus branch and time, and
    // writes the audit row. New customer: defer until they key in their phone
    // & nickname at the input step, then the profile gets saved.
    if (member && isApiMemberId(member.id)) {
      setBusy(true);
      try {
        const res = await membersApi.verifyTier(member.id, {
          toTier: tier,
          evidenceType: proofType,
          evidenceExpiresAt: expiresAt,
          note: isOther ? otherDoc.trim() : undefined,
        });
        const updated = apiMemberToMember(res.member);
        verifyMemberTier(member.id, verification); // keep the in-memory sale-flow stores in step
        toast({
          title: `${tierLabel(tier)} rate verified`,
          description: `${proofType} · valid until ${expiresAt} · recorded by ${operatorName}`,
        });
        onConfirm({ member: { ...member, ...updated }, verification: updated.tierVerification ?? verification });
        onOpenChange(false);
      } catch (err) {
        toast({
          title: "Couldn't save the verification",
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setBusy(false);
      }
      return;
    }

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
            {member
              ? 'Saved to the member profile so they won’t be asked again.'
              : 'Saved to their profile once they enter their details.'}
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

          {isOther && (
            <div className="space-y-2">
              <label
                htmlFor="tier-evidence-other"
                className="text-sm font-medium text-muted-foreground"
              >
                Which document? <span className="text-destructive">*</span>
              </label>
              <input
                id="tier-evidence-other"
                type="text"
                value={otherDoc}
                onChange={(e) => setOtherDoc(e.target.value)}
                placeholder="e.g. Work permit, Driving licence…"
                maxLength={120}
                className="w-full h-12 rounded-lg border border-input bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="tier-evidence-expiry"
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
            >
              <CalendarClock className="w-4 h-4" />
              Document expiry date <span className="text-destructive">*</span>
            </label>
            <input
              id="tier-evidence-expiry"
              type="date"
              value={expiresAt}
              min={todayIso()}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="w-full h-12 rounded-lg border border-input bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {expiresAt && !expiryValid && (
              <p className="text-sm text-destructive">The document has already expired.</p>
            )}
          </div>

          {/* Recorded automatically — who checked, fixed to the signed-in account. */}
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            <UserCheck className="w-4 h-4 shrink-0 text-primary" />
            <span>
              Checked by <span className="font-semibold text-foreground">{operatorName}</span> — recorded
              automatically with date &amp; time.
            </span>
          </div>

          <Button className="w-full h-14 text-lg gap-2" disabled={!canConfirm} onClick={handleConfirm}>
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <BadgeCheck className="w-5 h-5" />}
            {busy
              ? 'Saving…'
              : proofType
                ? `Verify ${tierLabel(tier)} — ${proofType}`
                : 'Choose proof to verify'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
