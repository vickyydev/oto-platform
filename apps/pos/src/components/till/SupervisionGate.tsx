import { TicketType, SupervisionPolicy, ChildFoodProvision } from '@/types';
import {
  resolveGroupRequirements,
  resolveSupervisionOutcome,
  confirmationsSatisfied,
} from '@/lib/supervision';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { ageFromDob } from '@/lib/childDob';
import {
  ShieldAlert,
  ShieldCheck,
  Baby,
  UserCheck,
  ArrowLeft,
  Check,
} from 'lucide-react';

// One anonymous kid pulled out of the cart for door-flow supervision. The whole
// draft (names, ages, waiver + consent fields) is LIFTED in Till so the staff
// gate and the customer consent screen read/write the same single state.
export interface SupervisedSlot {
  id: string;
  // The cart line this kid came from (so the conversion knows which ticket /
  // extras to preserve), plus the play ticket priced for the child's drop-off.
  sourceLineId: string;
  ticketType: TicketType;
  name: string;
  age: string; // derived/parsed age string; kept in sync with dateOfBirth when set
  // Real date of birth (ISO YYYY-MM-DD) captured via the low-tap picker. When
  // present it is the source of truth — `age` is re-derived from it so the
  // supervision band stays correct on the visit date (slotAge prefers this).
  dateOfBirth?: string;
  waived: boolean;
  // Consent fields (captured on the customer screen, mirrored here).
  allergiesMedical: string;
  foodRestrictions: string;
  mayOrderFood: boolean;
  // Prepaid food provision chosen by the parent on the customer consent screen.
  // When present, mayOrderFood is derived from mode !== 'none'.
  foodProvision?: ChildFoodProvision;
  childPhotoUrl?: string;
  // Customer-chosen nanny billing start time ("HH:MM"). Online /book flow only —
  // the reception door flow ignores this (nanny timing is handled in-park there).
  nannyStartTime?: string;
  // Links this slot to a SavedChild on the member's profile when it was pre-filled
  // from a saved profile. On capture, a slot WITH this updates that saved child;
  // a slot WITHOUT it is added as a brand-new saved child. Never carries a photo.
  savedChildId?: string;
  // Staff/parent opt-in: register a 'none'-requirement (no-fee) child for the
  // identical supervised drop-off flow anyway (consent/photo/allergy/dietary/
  // credit/pickup), at ฿0. Only meaningful when the child's BASE requirement is
  // 'none' — see resolveSupervisionOutcome. Ignored/cleared once age makes
  // supervision mandatory; a waived-down mandatory child is unaffected.
  optIn?: boolean;
}

// Parse the raw age input to a non-negative integer, or null if not yet valid.
export function parseAge(raw: string): number | null {
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

// The slot's effective age: derived from the captured DOB against the visit date
// (`asOfDate`, default today) when one is present, else the stored numeric age.
// Use this (not parseAge) anywhere a supervision requirement or age display is
// computed so DOB records resolve for the correct visit and never go stale. Pass
// `asOfDate` for non-today visits (e.g. an online booking's scheduled date).
export function slotAge(
  slot: { dateOfBirth?: string; age: string },
  asOfDate?: Date,
): number | null {
  if (slot.dateOfBirth) return ageFromDob(slot.dateOfBirth, asOfDate);
  return parseAge(slot.age);
}

const REQUIREMENT_META = {
  nanny: { label: 'Nanny required', icon: UserCheck, badge: 'destructive' as const },
  drop_off: { label: 'Drop-off required', icon: ShieldAlert, badge: 'destructive' as const },
  none: { label: 'No supervision needed', icon: ShieldCheck, badge: 'secondary' as const },
};

interface SupervisionGateProps {
  slots: SupervisedSlot[];
  parentName: string;
  consentAck: boolean;
  policy: SupervisionPolicy;
  // Confirmations checklist ticked on the customer screen — required for ANY
  // unaccompanied registration, not just supervised ones (see ConsentCapture).
  acknowledgedConfirmationIds: string[];
  onUpdateSlot: (id: string, patch: Partial<SupervisedSlot>) => void;
  onToggleWaiver: (id: string) => void;
  onBack: () => void;
  onContinue: () => void;
  // True while Continue's work is in flight — the children are being saved to
  // the member's record (SCRUM-233), which is a round trip that can fail.
  busy?: boolean;
}

/**
 * Door-flow supervision gate (staff side). Shown when a ticket sale is
 * unaccompanied (no adults + anonymous kids). Each child must be named + aged so
 * the configurable policy can resolve its requirement (nanny / drop-off / none).
 * Staff may waive a drop-off child that an older sibling covers (audited in
 * Till). Continue is blocked until every child is named + aged AND, for the
 * children who still need supervision, the customer screen has captured a photo
 * per child plus the parent's name and explicit consent.
 */
export function SupervisionGate({
  slots,
  parentName,
  consentAck,
  policy,
  acknowledgedConfirmationIds,
  onUpdateSlot,
  onToggleWaiver,
  onBack,
  onContinue,
  busy = false,
}: SupervisionGateProps) {
  // Only resolve children with a valid age — feeding a placeholder age for a
  // not-yet-typed child would trip the policy's "no band" warning on every
  // keystroke. An un-aged child shows no requirement until its age is entered.
  const resolved = resolveGroupRequirements(
    slots
      .filter((s) => slotAge(s) !== null)
      .map((s) => ({ id: s.id, age: slotAge(s)! })),
    policy,
  );
  const byId = new Map(resolved.map((r) => [r.id, r]));

  const rows = slots.map((slot) => {
    const r = byId.get(slot.id);
    const aged = slotAge(slot) !== null;
    const requirement = aged ? r?.requirement ?? 'none' : 'none';
    const waiverEligible = aged ? !!r?.waiverEligible : false;
    const outcome = aged
      ? resolveSupervisionOutcome(requirement, slot.waived, slot.optIn)
      : { effective: 'none' as const, needsConsent: false, service: null };
    return {
      slot,
      aged,
      requirement,
      waiverEligible,
      effective: outcome.effective,
      needsConsent: outcome.needsConsent,
      optedIn: outcome.service === 'none',
    };
  });

  const anyNeedsConsent = rows.some((r) => r.needsConsent);
  // Every supervised child must have a photo captured on the customer screen.
  const photosOk = rows.every((r) => !r.needsConsent || !!r.slot.childPhotoUrl);
  const consentOk =
    !anyNeedsConsent || (parentName.trim().length > 0 && consentAck && photosOk);
  const allIdentified = rows.every((r) => r.slot.name.trim().length > 0 && r.aged);
  // Confirmations must be ticked for ANY unaccompanied registration, even one
  // where every child ends up needing no service (e.g. an all-9+ group).
  const confirmationsOk =
    slots.length === 0 || confirmationsSatisfied(policy, acknowledgedConfirmationIds);

  // Build a plain-language list of everything still blocking payment.
  const blockers: string[] = [];
  for (const r of rows) {
    const who = r.slot.name.trim() || 'This child';
    if (!r.slot.name.trim()) blockers.push('Every child needs a name.');
    else if (!r.aged) blockers.push(`${who} needs an age.`);
    else if (r.effective === 'nanny') blockers.push(`${who} (age ${slotAge(r.slot)}) needs a nanny before payment.`);
    else if (r.effective === 'drop_off') blockers.push(`${who} (age ${slotAge(r.slot)}) needs drop-off supervision.`);
    // Photo is independent of the requirement type — flag it separately.
    if (r.needsConsent && !r.slot.childPhotoUrl) blockers.push(`${who} needs a photo taken.`);
  }
  if (anyNeedsConsent && (parentName.trim().length === 0 || !consentAck)) {
    blockers.push('Parent must give their name and consent on the customer screen.');
  }
  if (!confirmationsOk) {
    blockers.push('Parent must accept every required confirmation on the customer screen.');
  }
  // De-dupe the generic "needs a name" line.
  const uniqueBlockers = Array.from(new Set(blockers));
  const canContinue = allIdentified && consentOk && confirmationsOk;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-2xl font-bold">Children playing alone</h2>
          <p className="text-sm text-muted-foreground">
            No adult on this sale. Name each child and confirm their age so we know who needs supervision.
          </p>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1">
        {rows.map(({ slot, aged, requirement, waiverEligible, effective, optedIn }) => {
          const meta = REQUIREMENT_META[effective];
          const Icon = meta.icon;
          return (
            <div
              key={slot.id}
              className="rounded-2xl border border-border bg-card p-4"
            >
              <div className="flex items-center gap-3">
                <Baby className="h-5 w-5 shrink-0 text-muted-foreground" />
                <Input
                  value={slot.name}
                  onChange={(e) => onUpdateSlot(slot.id, { name: e.target.value })}
                  placeholder="Child's name"
                  className="h-12 flex-1 text-lg"
                />
                <div className="w-36 shrink-0">
                  <ChildDobPicker
                    dateOfBirth={slot.dateOfBirth}
                    age={parseAge(slot.age)}
                    childName={slot.name}
                    onChange={({ dateOfBirth, age }) =>
                      onUpdateSlot(slot.id, { dateOfBirth, age: String(age) })
                    }
                  />
                </div>
              </div>

              {aged && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge variant={meta.badge} className="gap-1.5 px-2.5 py-1 text-sm">
                    <Icon className="h-4 w-4" />
                    {meta.label}
                  </Badge>
                  {slot.waived && (
                    <Badge variant="outline" className="gap-1.5 px-2.5 py-1 text-sm text-emerald-400">
                      <Check className="h-3.5 w-3.5" /> Waived — sibling covers
                    </Badge>
                  )}
                  {waiverEligible && (
                    <Button
                      size="sm"
                      variant={slot.waived ? 'secondary' : 'outline'}
                      className="h-8 text-sm"
                      onClick={() => onToggleWaiver(slot.id)}
                    >
                      {slot.waived
                        ? 'Undo waiver'
                        : `Waive — older sibling (${policy.siblingWaiver.guardianMinAge}+) covers`}
                    </Button>
                  )}
                  {effective === 'none' && requirement !== 'none' && !slot.waived && (
                    <span className="text-sm text-muted-foreground">No supervision required</span>
                  )}
                  {requirement === 'none' && optedIn && (
                    <Badge variant="outline" className="gap-1.5 px-2.5 py-1 text-sm text-emerald-400">
                      <Check className="h-3.5 w-3.5" /> Registered for drop-off — no fee
                    </Badge>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {uniqueBlockers.length > 0 && (
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-300">
            <ShieldAlert className="h-4 w-4" /> Before payment
          </div>
          <ul className="space-y-1 text-sm text-amber-200/90">
            {uniqueBlockers.map((b, i) => (
              <li key={i}>• {b}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex gap-3">
        <Button
          variant="outline"
          size="lg"
          className="h-14 rounded-2xl px-6 text-lg"
          onClick={onBack}
        >
          <ArrowLeft className="mr-2 h-5 w-5" /> Back
        </Button>
        <Button
          size="lg"
          className="h-14 flex-1 rounded-2xl text-lg font-bold"
          disabled={!canContinue || busy}
          onClick={onContinue}
        >
          {busy ? 'Saving…' : 'Continue to payment'}
        </Button>
      </div>
    </div>
  );
}
