import { CustomerTier, Member, OtoEvent } from '@/types';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  tierLabel,
  isDefaultTier,
  getVerification,
  isTierVerified,
} from '@/lib/membership';
import { getTiers } from '@/mockApi';
import { EventPassCard } from '@/components/till/EventPassCard';
import { Users, Globe, MapPin, BadgeCheck, ShieldQuestion, UserCircle, Ticket, type LucideIcon } from 'lucide-react';

interface StepCustomerTypeProps {
  member: Member | null;
  /** Tier the customer currently has selected (auto-applied from membership). */
  selectedTier: CustomerTier;
  /** Pick a tier that is allowed without fresh proof (tourist or verified). */
  onPickTier: (tier: CustomerTier) => void;
  /** Request proof for an unverified discounted tier (opens verify modal). */
  onRequestVerify: (tier: CustomerTier) => void;
  /** Active camp/event passes for today, sold at a flat entry price (no tier). */
  eventPasses?: OtoEvent[];
  onSellEventPass?: (event: OtoEvent) => void;
}

// Per-tier presentation hints. Seeded ids keep their original icon/blurb; any
// new tier configured by the owner falls back to a generic icon + the default
// pricing blurb so the card still renders sensibly.
const TIER_PRESENTATION: Record<string, { icon: LucideIcon; blurb: string }> = {
  tourist: { icon: Globe, blurb: 'Standard pricing' },
  expat: { icon: Users, blurb: 'Resident pricing' },
  thai: { icon: MapPin, blurb: 'Local pricing' },
};

const tierPresentation = (tier: CustomerTier, isDefault: boolean) =>
  TIER_PRESENTATION[tier] ?? {
    icon: isDefault ? Globe : Users,
    blurb: isDefault ? 'Standard pricing' : 'Discounted pricing',
  };

export function StepCustomerType({
  member,
  selectedTier,
  onPickTier,
  onRequestVerify,
  eventPasses = [],
  onSellEventPass,
}: StepCustomerTypeProps) {
  const verification = getVerification(member);

  return (
    <div className="flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6 shrink-0 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Select Customer Type</h2>
          <p className="text-muted-foreground mt-2 text-lg">Choose the pricing tier to start the sale.</p>
        </div>
      </div>

      {/* Member banner */}
      <div className="mb-6 shrink-0">
        {member ? (
          <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
            <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center text-primary font-bold text-lg shrink-0">
              {member.nickname.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold text-lg truncate">{member.nickname}</div>
              <div className="text-sm text-muted-foreground truncate">{member.phone}</div>
            </div>
            {verification ? (
              <div className="flex items-center gap-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-4 py-2 text-sm font-semibold shrink-0">
                <BadgeCheck className="w-4 h-4" />
                {tierLabel(verification.tier)} · verified
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-full bg-muted text-muted-foreground px-4 py-2 text-sm font-semibold shrink-0">
                <ShieldQuestion className="w-4 h-4" />
                No verified rate
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-dashed bg-muted/30 p-4 text-muted-foreground">
            <UserCircle className="w-6 h-6 shrink-0" />
            <span>Walk-in (no member) · default Tourist rate. Verify to apply a discounted tier.</span>
          </div>
        )}
      </div>

      {/* Padding lives INSIDE the scroll viewport (the wrapper div below), not
          on the ScrollArea root — root padding puts the clip edge flush against
          the cards and cuts off their selection ring and hover lift. */}
      <ScrollArea className="flex-1 min-h-0 -mx-3">
      {/* @container: column count follows the PANEL width, not the viewport —
          in the split till view the panel is far narrower than the screen and
          a viewport-keyed md:grid-cols-3 overflowed and clipped the cards. */}
      <div className="px-3 py-2 @container">
      <div className="grid grid-cols-1 @xl:grid-cols-3 gap-6">
        {getTiers().map((t) => {
          const tier = t.id;
          const isDefault = isDefaultTier(tier);
          const { icon: Icon, blurb } = tierPresentation(tier, isDefault);
          const verified = isTierVerified(member, tier);
          const isSelected = selectedTier === tier;
          const needsVerify = !isDefault && !verified;

          return (
            <Card
              key={tier}
              className={`relative flex flex-col items-center justify-center p-8 cursor-pointer transition-all hover:-translate-y-1 active:translate-y-0 ${
                isSelected
                  ? 'border-primary ring-2 ring-primary bg-primary/5'
                  : verified && !isDefault
                  ? 'border-emerald-500/40 hover:border-emerald-500'
                  : 'hover:border-primary hover:bg-primary/5'
              }`}
              onClick={() => (needsVerify ? onRequestVerify(tier) : onPickTier(tier))}
            >
              {!isDefault && verified && (
                <div className="absolute top-3 right-3 flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-2.5 py-1 text-xs font-bold">
                  <BadgeCheck className="w-3.5 h-3.5" />
                  Verified
                </div>
              )}
              <div
                className={`h-20 w-20 rounded-full flex items-center justify-center mb-6 ${
                  verified && !isDefault ? 'bg-emerald-500/15' : 'bg-primary/20'
                }`}
              >
                <Icon
                  className={`h-10 w-10 ${
                    verified && !isDefault ? 'text-emerald-500' : 'text-primary'
                  }`}
                />
              </div>
              <h3 className="text-2xl font-bold mb-2">{tierLabel(tier)}</h3>
              <p className="text-muted-foreground text-center">{blurb}</p>
              {needsVerify ? (
                <p className="mt-3 text-sm font-semibold text-amber-600 dark:text-amber-400 text-center">
                  Proof required — verify now
                </p>
              ) : !isDefault && verified ? (
                <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400 text-center">
                  {verification?.proofType} — no proof needed
                </p>
              ) : null}
            </Card>
          );
        })}
      </div>

      {/* Event passes — flat-priced camp/event entry sold to this identified
          customer without a tier. Reuses the same sell flow as the identify step. */}
      {onSellEventPass && eventPasses.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <Ticket className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
              Event Passes
            </h3>
            <span className="text-xs text-muted-foreground/70">
              {member ? `Sell an event to ${member.nickname}` : 'Flat day entry — no tier needed'}
            </span>
          </div>
          <div className="space-y-2">
            {eventPasses.map((ev) => (
              <EventPassCard key={ev.id} event={ev} onSell={onSellEventPass} />
            ))}
          </div>
        </div>
      )}
      </div>
      </ScrollArea>
    </div>
  );
}
