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
import { getDefaultTier } from '@/mockApi';
import { TIER_PROOF_TYPES } from '@/lib/tierProof';
import { membersApi } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { isDefaultTier, tierLabel } from '@/lib/membership';
import { useOperator } from '@/auth/OperatorContext';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { BadgeCheck, CalendarClock, Loader2, ShieldCheck, ShieldOff, UserCheck } from 'lucide-react';

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

/** Members loaded from the platform API carry UUID ids, and only those can be
 *  persisted. Every screen that opens this modal finds its member on the
 *  platform (S2-09b); a member object from anywhere else is not written. */
const isApiMemberId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Matches the route's floor: a revocation's reason IS its record. */
const REVOKE_REASON_MIN = 3;
const REVOKE_REASON_MAX = 200;

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
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const { can } = useOperator();
  // A fixed built-in list — no route serves it (see `lib/tierProof.ts`). The
  // verification it produces is written to the platform, not to the fixtures.
  const proofTypes = TIER_PROOF_TYPES;

  useEffect(() => {
    if (open) {
      setProofType(null);
      setExpiresAt('');
      setBusy(false);
      setRevoking(false);
      setRevokeReason('');
      setRevokeError(null);
    }
  }, [open]);

  /**
   * SCRUM-241 — the rate this member already holds, and the way to end it.
   *
   * A verified tier at the counter holds until it is revoked; a recorded
   * document expiry that has passed only flags it for re-verification
   * (`reverifyDue`). The action sits here
   * because this is the one place at the till that already talks to the tier
   * routes; the member banner on the customer-type step would be the better
   * home for it and belongs to another slice's file.
   *
   * A verification OF the baseline tier is not an entitlement — it is the
   * record of one already revoked — so there is nothing to take back.
   */
  const held =
    member &&
    isApiMemberId(member.id) &&
    member.tierVerification &&
    !isDefaultTier(member.tierVerification.tier)
      ? member.tierVerification
      : undefined;
  const mayRevoke = can('pos:member:tier_downgrade');
  const baselineLabel = tierLabel(getDefaultTier().id);

  const handleRevoke = async () => {
    if (!member || !held) return;
    const reason = revokeReason.trim();
    if (reason.length < REVOKE_REASON_MIN) {
      setRevokeError(`Say why the ${tierLabel(held.tier)} rate is ending.`);
      return;
    }
    setBusy(true);
    setRevokeError(null);
    try {
      const res = await membersApi.revokeTierVerification(member.id, { reason });
      const updated = apiMemberToMember(res.member);
      /**
       * The same callback the grant takes, carrying the revocation the server
       * has just written: from here the till reads the tier now in force and
       * re-states the cart at it. Without this the sale would go on being
       * priced at a rate the platform no longer recognises — the till would
       * quote Expat, the platform would price the baseline, and the commit
       * would refuse the difference as `SALE_LINE_PRICE_MISMATCH` with nothing
       * on screen to explain it.
       *
       * `proofType: 'revoked'` is the evidence row's own kind, not a document:
       * the baseline rate is the one that needs no proof.
       */
      onConfirm({
        member: { ...member, ...updated },
        verification: {
          tier: getDefaultTier().id,
          proofType: 'revoked',
          verifiedBy: operatorName,
          verifiedById: operatorId,
          verifiedAt: new Date().toISOString(),
        },
      });
      toast({
        title: `${res.member.nickname} is back on the ${baselineLabel} rate`,
        description: `Filed: ${reason}`,
      });
      onOpenChange(false);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * The approved design's step asks for the proof type only, so the expiry is
   * optional for a member and for a visitor with no member yet alike. A
   * document with no expiry date never expires; one that is given must not
   * have passed.
   */
  const expiryValid =
    expiresAt === '' || (/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) && expiresAt >= todayIso());
  const canConfirm = !!proofType && expiryValid && !busy;

  const handleConfirm = async () => {
    if (!proofType || !expiryValid) return;
    const verification: TierVerification = {
      tier,
      proofType,
      verifiedBy: operatorName,
      verifiedById: operatorId,
      verifiedAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
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
          ...(expiresAt ? { evidenceExpiresAt: expiresAt } : {}),
        });
        const updated = apiMemberToMember(res.member);
        toast({
          title: `${tierLabel(tier)} rate verified`,
          description: `${proofType}${expiresAt ? ` · valid until ${expiresAt}` : ''} · recorded by ${operatorName}`,
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

          {/* The rate this member already holds, and the way to end it
              (SCRUM-241). Nothing is erased: the document record stays and a
              revocation is filed after it with the reason typed here. */}
          {held && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-4 space-y-3">
              <div className="flex items-start gap-2 text-sm">
                <ShieldOff className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                <span>
                  Already holds <span className="font-semibold">{tierLabel(held.tier)}</span> on a{' '}
                  {held.proofType}
                  {held.expiresAt
                    ? held.reverifyDue
                      ? `, expired ${held.expiresAt} — re-verify`
                      : `, valid to ${held.expiresAt}`
                    : ' with no expiry'}{' '}
                  — verified by{' '}
                  {held.verifiedBy}.
                </span>
              </div>
              {!mayRevoke ? (
                <p className="text-sm text-muted-foreground">
                  Taking that rate back off a member needs a manager.
                </p>
              ) : !revoking ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-11"
                  onClick={() => setRevoking(true)}
                >
                  End the {tierLabel(held.tier)} rate — back to {baselineLabel}
                </Button>
              ) : (
                <div className="space-y-2">
                  <label
                    htmlFor="tier-revoke-reason"
                    className="text-sm font-medium text-muted-foreground"
                  >
                    Why is it ending? <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="tier-revoke-reason"
                    value={revokeReason}
                    maxLength={REVOKE_REASON_MAX}
                    placeholder="e.g. Residence permit expired and was not renewed"
                    onChange={(e) => setRevokeReason(e.target.value)}
                  />
                  {revokeError && <p className="text-sm text-destructive">{revokeError}</p>}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 h-11"
                      disabled={busy}
                      onClick={() => {
                        setRevoking(false);
                        setRevokeReason('');
                        setRevokeError(null);
                      }}
                    >
                      Keep it
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      className="flex-1 h-11 gap-2"
                      disabled={busy}
                      onClick={handleRevoke}
                    >
                      {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                      Back to {baselineLabel}
                    </Button>
                  </div>
                </div>
              )}
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

          <div className="space-y-2">
            <label
              htmlFor="tier-evidence-expiry"
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
            >
              <CalendarClock className="w-4 h-4" />
              Document expiry date
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
