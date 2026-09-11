import { useEffect, useState } from 'react';
import type { ContactChannel, CustomerTier, Member, TierVerification } from '@/types';
import { getProofTypes } from '@/mockApi';
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
import { ShieldCheck } from 'lucide-react';
import { verifiedTiers } from './memberLabels';
import { getDefaultTier } from '@/mockApi';
import { isDefaultTier, tierLabel } from '@/lib/membership';

export interface MemberFormData {
  phone: string;
  nickname: string;
  tierVerification?: TierVerification;
  preferredChannel?: ContactChannel;
}

interface MemberFormDialogProps {
  open: boolean;
  /** The member being edited, or null when creating a new one. */
  member: Member | null;
  onOpenChange: (open: boolean) => void;
  onSave: (data: MemberFormData) => void;
}

type TierChoice = CustomerTier;

interface TierSelection {
  tier: TierChoice;
  proofType: string;
}

interface FormErrors {
  nickname?: string;
  phone?: string;
  operator?: string;
  tier?: string;
}

const emptySelection = (): TierSelection => ({
  tier: getDefaultTier().id,
  proofType: '',
});

const toSelection = (verification?: TierVerification): TierSelection => {
  if (!verification) return emptySelection();
  return { tier: verification.tier, proofType: verification.proofType };
};

/**
 * Create/Edit form for a member profile. Beyond nickname + phone, carries the
 * optional verified tier (expat/thai with a proof type) or clears to Tourist
 * (no verification). Setting or changing a verification stamps the current
 * face-login operator + timestamp; an unchanged verification keeps its original stamp.
 */
export function MemberFormDialog({
  open,
  member,
  onOpenChange,
  onSave,
}: MemberFormDialogProps) {
  const { operator } = useOperator();
  const proofTypes = getProofTypes();

  const [nickname, setNickname] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<ContactChannel>('whatsapp');
  const [selection, setSelection] = useState<TierSelection>(() => emptySelection());
  const [errors, setErrors] = useState<FormErrors>({});

  // Reset fields whenever the dialog opens (for add) or the target changes.
  useEffect(() => {
    if (!open) return;
    setNickname(member?.nickname ?? '');
    setPhone(member?.phone ?? '');
    setChannel(member?.preferredChannel ?? 'whatsapp');
    setSelection(toSelection(member?.tierVerification));
    setErrors({});
  }, [open, member]);

  const handleTierChange = (tier: TierChoice) => {
    setSelection({
      tier,
      proofType: isDefaultTier(tier)
        ? ''
        : selection.proofType || proofTypes[0] || '',
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedNickname = nickname.trim();
    const trimmedPhone = phone.trim();
    const nextErrors: FormErrors = {};

    if (!trimmedNickname) nextErrors.nickname = 'Nickname is required.';
    if (!trimmedPhone) {
      nextErrors.phone = 'Phone is required.';
    } else if (trimmedPhone.replace(/\D/g, '').length < 6) {
      nextErrors.phone = 'Enter a valid phone number.';
    }
    if (!isDefaultTier(selection.tier) && !selection.proofType) {
      nextErrors.tier = 'Select a proof type for this verified tier.';
    }

    // A new/changed verification must be stamped with the logged-in operator.
    const originalVerification = member?.tierVerification;
    const isChangedVerification =
      !isDefaultTier(selection.tier) &&
      !(
        originalVerification &&
        originalVerification.tier === selection.tier &&
        originalVerification.proofType === selection.proofType
      );
    if (isChangedVerification && !operator) {
      nextErrors.operator =
        'You must be logged in as an operator to verify or change a tier.';
    }

    if (nextErrors.nickname || nextErrors.phone || nextErrors.operator || nextErrors.tier) {
      setErrors(nextErrors);
      return;
    }

    let tierVerification: TierVerification | undefined;
    if (!isDefaultTier(selection.tier)) {
      const unchanged =
        originalVerification &&
        originalVerification.tier === selection.tier &&
        originalVerification.proofType === selection.proofType;
      tierVerification =
        unchanged || !operator
          ? originalVerification
          : {
              tier: selection.tier,
              proofType: selection.proofType,
              verifiedBy: operator.name,
              verifiedById: operator.id,
              verifiedAt: new Date().toISOString(),
            };
    }

    onSave({ phone: trimmedPhone, nickname: trimmedNickname, tierVerification, preferredChannel: channel });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{member ? 'Edit member' : 'Add member'}</DialogTitle>
          <DialogDescription>
            {member
              ? 'Update this member\u2019s profile and verified tier.'
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
              Setting a tier records who verified it and when.
            </p>

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
            </div>

            {errors.tier && (
              <p className="text-xs text-destructive">{errors.tier}</p>
            )}
          </div>

          <p className="text-xs text-foreground/40">
            Proof handling is a label only in this prototype — no ID documents are
            uploaded or stored. Real proof capture needs proper data-protection
            treatment (consent, retention, access control).
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{member ? 'Save changes' : 'Add member'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
