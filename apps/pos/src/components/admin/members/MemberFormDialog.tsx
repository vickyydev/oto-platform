import { useEffect, useState } from 'react';
import type { ContactChannel, CustomerTier, Member } from '@/types';
import { TIER_PROOF_NOTE, TIER_PROOF_TYPES } from '@/lib/tierProof';
import { useOperator } from '@/auth/OperatorContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { Loader2, ShieldCheck } from 'lucide-react';
import { verifiedTiers } from './memberLabels';
import { getDefaultTier } from '@/mockApi';
import { isDefaultTier, tierLabel } from '@/lib/membership';

/**
 * A tier upgrade to record. The screen never invents who checked the document
 * or when: `POST /members/:id/tier-verification` stamps the verifier from the
 * session, the branch and the time, and writes the evidence row and the new
 * tier in one transaction.
 */
export interface TierChangeRequest {
  toTier: CustomerTier;
  evidenceType: string;
  /** Document expiry, YYYY-MM-DD. The API refuses an already-expired document. */
  evidenceExpiresAt: string;
  note?: string;
}

/**
 * The verified tier ending (SCRUM-241). The reason is the whole record of why
 * — a revocation has no document behind it — so the form requires one and the
 * API refuses anything shorter than three characters.
 */
export interface TierRevokeRequest {
  reason: string;
}

export const REVOKE_REASON_MIN = 3;
export const REVOKE_REASON_MAX = 200;

export interface MemberFormData {
  phone: string;
  nickname: string;
  preferredChannel?: ContactChannel;
  tierChange?: TierChangeRequest;
  tierRevoke?: TierRevokeRequest;
}

interface MemberFormDialogProps {
  open: boolean;
  /** The member being edited, or null when creating a new one. */
  member: Member | null;
  onOpenChange: (open: boolean) => void;
  /** Resolves once the save reached the API; rejects with the API's error. */
  onSave: (data: MemberFormData) => Promise<void>;
}

type TierChoice = CustomerTier;

interface TierSelection {
  tier: TierChoice;
  proofType: string;
  expiresAt: string;
  otherDoc: string;
}

interface FormErrors {
  nickname?: string;
  phone?: string;
  operator?: string;
  tier?: string;
  reason?: string;
  save?: string;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const emptySelection = (): TierSelection => ({
  tier: getDefaultTier().id,
  proofType: '',
  expiresAt: '',
  otherDoc: '',
});

const toSelection = (member: Member | null): TierSelection => {
  const verification = member?.tierVerification;
  // A verification of the baseline tier entitles nothing — it is the record of
  // one that was revoked (SCRUM-241) — so the form opens on the baseline with
  // no document named, which is what the member now holds.
  if (!verification || isDefaultTier(verification.tier)) return emptySelection();
  return {
    tier: verification.tier,
    proofType: verification.proofType,
    expiresAt: verification.expiresAt ?? '',
    otherDoc: '',
  };
};

/**
 * Create/Edit form for a member profile: nickname, phone, contact channel and
 * the verified tier that sets what every ticket they buy costs.
 *
 * The tier is not a field on the profile — it is granted by a checked document.
 * Choosing a verified tier here collects the document type and its expiry and
 * sends them to the verification route; the server decides the tier from them.
 * Choosing the baseline rate for a member who holds a verified one ENDS that
 * entitlement (SCRUM-241) and collects the reason, which is the only record a
 * revocation has — there is no document behind it.
 */
export function MemberFormDialog({
  open,
  member,
  onOpenChange,
  onSave,
}: MemberFormDialogProps) {
  const { operator, can } = useOperator();
  const proofTypes = TIER_PROOF_TYPES;
  /**
   * A manager gate, and deliberately not the permission that records a
   * verification: reception checks documents all day and cannot take a rate
   * back. The API settles it either way — this only decides what the form
   * offers, so nobody types a reason into a box that was always going to be
   * refused.
   */
  const mayRevoke = can('pos:member:tier_downgrade');

  const [nickname, setNickname] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<ContactChannel>('whatsapp');
  const [selection, setSelection] = useState<TierSelection>(() => emptySelection());
  const [revokeReason, setRevokeReason] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  // Reset fields whenever the dialog opens (for add) or the target changes.
  useEffect(() => {
    if (!open) return;
    setNickname(member?.nickname ?? '');
    setPhone(member?.phone ?? '');
    setChannel(member?.preferredChannel ?? 'whatsapp');
    setSelection(toSelection(member));
    setRevokeReason('');
    setErrors({});
    setSaving(false);
  }, [open, member]);

  /**
   * The entitlement this member holds, if any.
   *
   * A verification OF the baseline tier is not one: the baseline is the rate
   * that needs no document, and a row saying so is the record of a revoked
   * entitlement rather than a live one. `GET /members/:id` already filters
   * those out; the register list this screen reads (`GET /members`) hands the
   * latest row over as it stands, so the same rule is applied here.
   */
  const current =
    member?.tierVerification && !isDefaultTier(member.tierVerification.tier)
      ? member.tierVerification
      : undefined;

  const handleTierChange = (tier: TierChoice) => {
    setSelection((prev) => ({
      ...prev,
      tier,
      proofType: isDefaultTier(tier) ? '' : prev.proofType || proofTypes[0] || '',
      expiresAt: isDefaultTier(tier) ? '' : prev.expiresAt,
    }));
  };

  const isOther = selection.proofType === 'Other';
  // Re-sending the same tier with the same document and expiry is not a change;
  // anything else about the entitlement is, and needs the document checked again.
  const tierChanged =
    !isDefaultTier(selection.tier) &&
    !(
      current &&
      current.tier === selection.tier &&
      current.proofType === selection.proofType &&
      (current.expiresAt ?? '') === selection.expiresAt
    );
  const clearingTier = !!current && isDefaultTier(selection.tier);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const trimmedNickname = nickname.trim();
    const trimmedPhone = phone.trim();
    const nextErrors: FormErrors = {};

    if (!trimmedNickname) nextErrors.nickname = 'Nickname is required.';
    if (!trimmedPhone) {
      nextErrors.phone = 'Phone is required.';
    } else if (trimmedPhone.replace(/\D/g, '').length < 6) {
      nextErrors.phone = 'Enter a valid phone number.';
    }

    // Ending an entitlement: the reason is the record, so it is required here
    // exactly as the document is required when granting one.
    const trimmedReason = revokeReason.trim();
    if (current && clearingTier) {
      if (!mayRevoke) {
        nextErrors.tier =
          `Taking the ${tierLabel(current.tier)} rate back off a member needs a manager. ` +
          'Ask someone who can, or leave the tier as it is.';
      } else if (trimmedReason.length < REVOKE_REASON_MIN) {
        nextErrors.reason = `Say why the ${tierLabel(current.tier)} rate is ending.`;
      }
    }
    if (tierChanged) {
      if (!selection.proofType) {
        nextErrors.tier = 'Select the document you checked.';
      } else if (isOther && !selection.otherDoc.trim()) {
        nextErrors.tier = 'Name the document you checked.';
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(selection.expiresAt)) {
        nextErrors.tier = "Enter the document's expiry date.";
      } else if (selection.expiresAt < todayIso()) {
        nextErrors.tier = 'That document has already expired — it cannot verify a discounted rate.';
      }
      // The verifier is stamped from the session, so there has to be one.
      if (!operator) {
        nextErrors.operator = 'You must be signed in to verify or change a tier.';
      }
    }

    if (
      nextErrors.nickname ||
      nextErrors.phone ||
      nextErrors.operator ||
      nextErrors.tier ||
      nextErrors.reason
    ) {
      setErrors(nextErrors);
      return;
    }

    const data: MemberFormData = {
      phone: trimmedPhone,
      nickname: trimmedNickname,
      preferredChannel: channel,
      ...(tierChanged
        ? {
            tierChange: {
              toTier: selection.tier,
              evidenceType: selection.proofType,
              evidenceExpiresAt: selection.expiresAt,
              ...(isOther ? { note: selection.otherDoc.trim() } : {}),
            },
          }
        : {}),
      ...(current && clearingTier ? { tierRevoke: { reason: trimmedReason } } : {}),
    };

    setErrors({});
    setSaving(true);
    onSave(data)
      .then(() => {
        setSaving(false);
        onOpenChange(false);
      })
      .catch((err: unknown) => {
        // The dialog stays open holding what was typed: a save that did not
        // reach the database must not look like one that did.
        setSaving(false);
        setErrors({ save: err instanceof Error ? err.message : 'Unknown error' });
      });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{member ? 'Edit member' : 'Add member'}</DialogTitle>
          <DialogDescription>
            {member
              ? 'Update this member’s profile and verified tier.'
              : 'Create a member profile that carries a verified discounted tier.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-nickname">Nickname</Label>
            <Input
              id="member-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g. Mali"
              autoFocus
            />
            {errors.nickname && (
              <p className="text-xs text-destructive">{errors.nickname}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <PhoneInput
              value={phone}
              onChange={setPhone}
              label="Phone"
              channel={channel}
              onChannelChange={setChannel}
            />
            {errors.phone && (
              <p className="text-xs text-destructive">{errors.phone}</p>
            )}
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
              <ShieldCheck className="w-4 h-4 text-emerald-300" />
              Verified tier
            </div>
            <p className="text-xs text-foreground/45">
              Pick the verified rate, or leave as Tourist (full price).
              Setting a tier records the document checked, its expiry, and who
              checked it.
            </p>

            {current && (
              <p className="rounded-lg bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300">
                Holds {tierLabel(current.tier)} on a {current.proofType}
                {current.expiresAt ? `, valid to ${current.expiresAt}` : ''} — verified by{' '}
                {current.verifiedBy}.
              </p>
            )}

            {!operator && (
              <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
                No operator is signed in — you can edit the name and phone, but
                verifying or changing a tier requires a logged-in operator.
              </p>
            )}
            {errors.operator && (
              <p className="text-xs text-destructive">{errors.operator}</p>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Select
                value={selection.tier}
                onValueChange={(v) => handleTierChange(v as TierChoice)}
              >
                <SelectTrigger aria-label="Tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={getDefaultTier().id}>
                    {tierLabel(getDefaultTier().id)} (no proof)
                  </SelectItem>
                  {verifiedTiers().map((t) => (
                    <SelectItem key={t} value={t}>
                      {tierLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {!isDefaultTier(selection.tier) && (
                <Select
                  value={selection.proofType}
                  onValueChange={(v) =>
                    setSelection((prev) => ({ ...prev, proofType: v }))
                  }
                >
                  <SelectTrigger aria-label="Proof type">
                    <SelectValue placeholder="Proof type" />
                  </SelectTrigger>
                  <SelectContent>
                    {proofTypes.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {!isDefaultTier(selection.tier) && (
                <p className="text-xs text-muted-foreground">{TIER_PROOF_NOTE}</p>
              )}
            </div>

            {!isDefaultTier(selection.tier) && isOther && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="member-tier-other">Which document?</Label>
                <Input
                  id="member-tier-other"
                  value={selection.otherDoc}
                  maxLength={120}
                  placeholder="e.g. Work permit, Driving licence…"
                  onChange={(e) =>
                    setSelection((prev) => ({ ...prev, otherDoc: e.target.value }))
                  }
                />
              </div>
            )}

            {/* Ending an entitlement (SCRUM-241). Shown only when this member
                actually holds one and the baseline has been chosen for them —
                the grant row stays either way; this adds the record of why the
                rate stopped. */}
            {current && clearingTier && (
              <div className="flex flex-col gap-1.5 rounded-xl border border-amber-400/30 bg-amber-400/[0.07] p-3">
                <Label htmlFor="member-tier-revoke-reason">
                  Why is the {tierLabel(current.tier)} rate ending?
                </Label>
                {mayRevoke ? (
                  <>
                    <Input
                      id="member-tier-revoke-reason"
                      value={revokeReason}
                      maxLength={REVOKE_REASON_MAX}
                      placeholder="e.g. Residence permit expired and was not renewed"
                      onChange={(e) => setRevokeReason(e.target.value)}
                    />
                    <p className="text-xs text-foreground/45">
                      Saving puts {member?.nickname ?? 'this member'} back on the{' '}
                      {tierLabel(getDefaultTier().id)} rate. The {current.proofType} record
                      stays — nothing is erased — and this reason is filed beside it.
                    </p>
                    {errors.reason && (
                      <p className="text-xs text-destructive">{errors.reason}</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-amber-300">
                    Taking a verified rate back off a member needs a manager.
                  </p>
                )}
              </div>
            )}

            {!isDefaultTier(selection.tier) && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="member-tier-expiry">Document expiry date</Label>
                <Input
                  id="member-tier-expiry"
                  type="date"
                  value={selection.expiresAt}
                  min={todayIso()}
                  onChange={(e) =>
                    setSelection((prev) => ({ ...prev, expiresAt: e.target.value }))
                  }
                />
                <p className="text-xs text-foreground/40">
                  The rate stops applying on this date and the member is asked
                  for fresh proof.
                </p>
              </div>
            )}

            {errors.tier && (
              <p className="text-xs text-destructive">{errors.tier}</p>
            )}
          </div>

          <p className="text-xs text-foreground/40">
            The document type, its expiry and the staff member who checked it are
            recorded. The document itself is never uploaded or stored.
          </p>

          {errors.save && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Not saved — {errors.save}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Saving…' : member ? 'Save changes' : 'Add member'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
