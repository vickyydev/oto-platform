import { useEffect, useState } from 'react';
import type { ContactChannel, CustomerTier, Member } from '@/types';
import { TIER_PROOF_NOTE, TIER_PROOF_TYPES } from '@/lib/tierProof';
import { useOperator } from '@/auth/OperatorContext';
import type { ApiMember as ApiMemberRecord } from '@/api/platform';
import {
  CHANNEL_COLOR,
  CHANNEL_ICON,
  CHANNEL_LABEL,
  CONTACT_CHANNELS,
} from '@/lib/contactChannel';
import { cn } from '@/lib/utils';
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
import { Textarea } from '@/components/ui/textarea';
import { PhoneInput } from '@/components/shared/PhoneInput';
import {
  ChildDetailsFields,
  childDetailsDraft,
  childDetailsPatch,
  childDetailsSummary,
  type ChildDetailsDraft,
} from '@/components/shared/ChildDetailsFields';
import { AlertTriangle, Baby, ChevronDown, ChevronRight, Loader2, ShieldCheck } from 'lucide-react';
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
  /**
   * Document expiry, YYYY-MM-DD, when the document carries one; absent, the
   * verification never expires. The API refuses an already-expired document.
   */
  evidenceExpiresAt?: string;
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

/** One child's edits, addressed by id — `PATCH /members/children/:id`. */
export interface ChildPatchRequest {
  id: string;
  /** For the message when this one child's save is the half that failed. */
  name: string;
  patch: Record<string, unknown>;
}

export interface MemberFormData {
  /** What a create needs; on an edit these are the values as the form holds them. */
  phone: string;
  nickname: string;
  /** The member's own channel — null is a real answer: they never chose one. */
  preferredChannel: ContactChannel | null;
  name: string | null;
  email: string | null;
  notes: string | null;
  /**
   * ONLY the member fields that actually changed (SCRUM-321).
   *
   * The dialog used to hand back every field it held and the panel PATCHed
   * all of them, so opening an unrelated edit and saving wrote a messaging
   * channel onto a member who had never picked one — the WhatsApp chip was
   * lit because the control had no way to show "none". Empty when nothing on
   * the profile was touched, and the panel then sends no PATCH at all.
   *
   * On a NEW member this carries only what `POST /members` cannot take
   * (full name, email, notes); the panel applies it straight after the create.
   */
  patch: Record<string, unknown>;
  tierChange?: TierChangeRequest;
  tierRevoke?: TierRevokeRequest;
  /** Child edits, one entry per child whose details changed (SCRUM-231). */
  childPatches: ChildPatchRequest[];
}

interface MemberFormDialogProps {
  open: boolean;
  /** The member being edited, or null when creating a new one. */
  member: Member | null;
  /**
   * The member as the API holds them — the full name, email and staff notes
   * the POS `Member` type does not carry, and the children with every field:
   * medical notes, the medical alert, dietary needs, food restrictions
   * (SCRUM-231).
   *
   * Read from `GET /members/:id`, and not from the list this screen is built
   * on, because a register row deliberately carries no child medical data
   * (SCRUM-246) — the whole customer file is not a thing to answer one
   * request with.
   */
  record?: ApiMemberRecord | null;
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

/**
 * The messaging channel, with "None" as a real choice — SCRUM-321.
 *
 * The same pills as the selector attached to `PhoneInput` (same labels,
 * icons and colours, from `lib/contactChannel`), plus the state most members
 * are actually in. `PhoneInput`'s own selector has no way to express it:
 * `normalizeChannel` answers 'whatsapp' for a null, so the WhatsApp chip lit
 * up for a member who had never chosen a channel and the next save wrote it
 * to the database. That selector is shared with the till identify step and
 * the booking site, where the default is wanted; this screen is where a
 * member's stored record is edited, so it shows what is stored.
 */
function ChannelPicker({
  value,
  onChange,
}: {
  value: ContactChannel | null;
  onChange: (next: ContactChannel | null) => void;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      {CONTACT_CHANNELS.map((c) => {
        const Icon = CHANNEL_ICON[c];
        const active = value === c;
        const colors = CHANNEL_COLOR[c];
        return (
          <button
            key={c}
            type="button"
            title={CHANNEL_LABEL[c]}
            aria-pressed={active}
            onClick={() => onChange(c)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors',
              active
                ? `${colors.bg} ${colors.text} ${colors.border}`
                : 'border-transparent bg-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="w-3 h-3" />
            {CHANNEL_LABEL[c]}
          </button>
        );
      })}
      <button
        type="button"
        title="No messaging channel chosen"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={cn(
          'flex h-7 items-center rounded-full border px-2.5 text-xs font-semibold transition-colors',
          value === null
            ? 'border-foreground/20 bg-foreground/10 text-foreground/70'
            : 'border-transparent bg-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        None
      </button>
    </div>
  );
}

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
  record,
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
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  /**
   * null is a real state and the one most members are in (SCRUM-321): they
   * never picked a channel. Opening on 'whatsapp' because the control could
   * not show "none" is what wrote a channel onto a member during an unrelated
   * tier edit.
   */
  const [channel, setChannel] = useState<ContactChannel | null>(null);
  const [selection, setSelection] = useState<TierSelection>(() => emptySelection());
  const [revokeReason, setRevokeReason] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  /** Each child's editable draft, keyed by child id, and which one is open. */
  const [childDrafts, setChildDrafts] = useState<Record<string, ChildDetailsDraft>>({});
  const [openChildId, setOpenChildId] = useState<string | null>(null);

  const children = record?.children ?? [];

  // Reset fields whenever the dialog opens (for add) or the target changes.
  useEffect(() => {
    if (!open) return;
    setNickname(member?.nickname ?? '');
    setPhone(member?.phone ?? '');
    setFullName(record?.name ?? '');
    setEmail(record?.email ?? '');
    setNotes(record?.notes ?? '');
    setChannel(record?.preferredChannel ?? member?.preferredChannel ?? null);
    setSelection(toSelection(member));
    setRevokeReason('');
    setErrors({});
    setSaving(false);
    setChildDrafts(
      Object.fromEntries((record?.children ?? []).map((c) => [c.id, childDetailsDraft(c)])),
    );
    setOpenChildId(null);
  }, [open, member, record]);

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
      } else if (selection.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(selection.expiresAt)) {
        nextErrors.tier = "Enter the document's expiry date.";
      } else if (selection.expiresAt && selection.expiresAt < todayIso()) {
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

    /**
     * Only what changed (SCRUM-321). A PATCH that names a field sets it, so
     * re-sending everything the form holds is how a save with no edits wrote
     * a channel nobody chose — and how one screen would overwrite a note
     * another till had written while this dialog sat open.
     *
     * A new member has nothing to compare against: `POST /members` carries
     * the phone, nickname and channel itself, so the patch is left holding
     * the fields the create route does not take.
     */
    const asText = (v: string): string | null => (v.trim() ? v.trim() : null);
    const patch: Record<string, unknown> = {};
    if (member) {
      if (trimmedNickname !== member.nickname) patch.nickname = trimmedNickname;
      if (trimmedPhone !== member.phone) patch.phone = trimmedPhone;
      if (channel !== (record?.preferredChannel ?? member.preferredChannel ?? null)) {
        patch.preferredChannel = channel;
      }
      if (asText(fullName) !== (record?.name ?? null)) patch.name = asText(fullName);
      if (asText(email) !== (record?.email ?? null)) patch.email = asText(email);
      if (asText(notes) !== (record?.notes ?? null)) patch.notes = asText(notes);
    } else {
      if (asText(fullName)) patch.name = asText(fullName);
      if (asText(email)) patch.email = asText(email);
      if (asText(notes)) patch.notes = asText(notes);
    }

    const childPatches = children.flatMap((c) => {
      const draft = childDrafts[c.id];
      if (!draft) return [];
      const childPatch = childDetailsPatch(childDetailsDraft(c), draft);
      return childPatch ? [{ id: c.id, name: c.name, patch: childPatch }] : [];
    });

    const data: MemberFormData = {
      phone: trimmedPhone,
      nickname: trimmedNickname,
      preferredChannel: channel,
      name: asText(fullName),
      email: asText(email),
      notes: asText(notes),
      patch,
      childPatches,
      ...(tierChanged
        ? {
            tierChange: {
              toTier: selection.tier,
              evidenceType: selection.proofType,
              ...(selection.expiresAt ? { evidenceExpiresAt: selection.expiresAt } : {}),
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

        {/*
          `min-w-0` on the form, because `DialogContent` is a CSS grid and a
          grid item's default `min-width: auto` lets it grow the column past
          the dialog's own `max-w-lg`. One nowrap line — a child's allergy
          summary on the collapsed row below — was enough to widen the column
          to 723px inside a 512px dialog, which clipped the email field, the
          tier text and the footer buttons off the right edge. With the item
          allowed to shrink, the dialog keeps its width and the summary
          truncates, which is what the ellipsis is there for.
        */}
        <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
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

          {/* The name on the passport and the address a receipt goes to. The
              API has accepted both since Sprint 1 and this form offered
              neither, so a member the park knows as "Mali" had nowhere to be
              anything else (SCRUM-231). */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-name">Full name</Label>
              <Input
                id="member-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Malee Srisai"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-email">Email</Label>
              <Input
                id="member-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <PhoneInput value={phone} onChange={setPhone} label="Phone" />
            <ChannelPicker value={channel} onChange={setChannel} />
            {errors.phone && (
              <p className="text-xs text-destructive">{errors.phone}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-notes">Notes</Label>
            <Textarea
              id="member-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything staff should know about this member"
              rows={2}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              Verified tier
            </div>
            <p className="text-xs text-foreground/45">
              Pick the verified rate, or leave as Tourist (full price).
              Setting a tier records the document checked, its expiry, and who
              checked it.
            </p>

            {current && (
              <p className="rounded-lg bg-emerald-500/15 px-3 py-2 text-xs text-emerald-700">
                Holds {tierLabel(current.tier)} on a {current.proofType}
                {current.expiresAt ? `, valid to ${current.expiresAt}` : ''} — verified by{' '}
                {current.verifiedBy}.
              </p>
            )}

            {!operator && (
              <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-700">
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
                  <p className="text-xs text-amber-700">
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

          {/* The children saved against this member (SCRUM-231). Collapsed to
              a row each, because most edits here are to the profile above and
              a wall of medical boxes would bury them; open one and every field
              the record holds is editable. */}
          {member && children.length > 0 && (
            <div className="flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <Baby className="w-4 h-4 text-primary" />
                Children
              </div>
              <p className="text-xs text-foreground/45">
                Allergies, medical notes, dietary needs and food restrictions —
                what the kitchen and the nanny floor read. Saved with this form.
              </p>
              {children.map((c) => {
                const draft = childDrafts[c.id];
                if (!draft) return null;
                const isOpen = openChildId === c.id;
                const summary = childDetailsSummary(draft);
                return (
                  <div
                    key={c.id}
                    className="rounded-xl border border-foreground/10 bg-background/40"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenChildId(isOpen ? null : c.id)}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 shrink-0 text-foreground/40" />
                      ) : (
                        <ChevronRight className="w-4 h-4 shrink-0 text-foreground/40" />
                      )}
                      <span className="shrink-0 font-medium">{draft.name || c.name}</span>
                      {draft.medicalAlert && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-destructive">
                          <AlertTriangle className="w-3 h-3" />
                          Medical alert
                        </span>
                      )}
                      {/* `min-w-0` is what makes `truncate` work: a flex item's
                          default `min-width: auto` will not shrink below its
                          text, so a child with a long allergy line pushed this
                          row — and with it the whole dialog — wider than the
                          dialog box, clipping the fields above. */}
                      <span className="ml-auto min-w-0 truncate pl-2 text-right text-xs text-foreground/45">
                        {summary || 'Nothing recorded'}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="border-t border-foreground/10 p-3">
                        <ChildDetailsFields
                          draft={draft}
                          idPrefix={`member-child-${c.id}`}
                          onChange={(next) =>
                            setChildDrafts((prev) => ({
                              ...prev,
                              [c.id]: { ...prev[c.id]!, ...next },
                            }))
                          }
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

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
