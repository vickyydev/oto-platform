import { CustomerTier, Member, OtoEvent } from '@/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  tierLabel,
  isDefaultTier,
  getVerification,
  isTierVerified,
  soleTierFor,
} from '@/lib/membership';
import { getTiers } from '@/mockApi';
import { tierProofLabel } from '@/lib/tierProof';
import { formatStoredPhone } from '@/lib/phoneUtils';
import { EventPassCard } from '@/components/till/EventPassCard';
import { Users, Globe, MapPin, BadgeCheck, ShieldQuestion, UserCircle, Ticket, LayoutGrid, type LucideIcon } from 'lucide-react';

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
  /**
   * SCRUM-858 — a member whose verified rate is in date sees that tier's card
   * alone (`soleTierFor`). `onShowAllTiers` is the one way back: staff press
   * "Show all rates" when the member's situation changed for this sale (a
   * guest of theirs at the tourist rate), and the caller sets `showAllTiers`
   * for this sale only; the member's stored rate is not touched. A caller
   * passing no `onShowAllTiers` gets every tier, as a screen with no way back
   * to them must.
   */
  showAllTiers?: boolean;
  onShowAllTiers?: () => void;
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
  showAllTiers = false,
  onShowAllTiers,
}: StepCustomerTypeProps) {
  const verification = getVerification(member);
  // SCRUM-858 — one card for a member whose verified rate is in date, unless
  // staff asked for every rate on this sale (or nobody gave them a way to).
  const soleTier = showAllTiers || !onShowAllTiers ? null : soleTierFor(member);
  const tiers = getTiers();
  const shownTiers = soleTier ? tiers.filter((t) => t.id === soleTier) : tiers;

  return (
    <div className="@container/type flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6 shrink-0 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Select Customer Type</h2>
          <p className="text-muted-foreground mt-2 text-lg">Choose the pricing tier to start the sale.</p>
        </div>
      </div>

      {/* Member banner */}
      <div className="mb-6 shrink-0">
        {member ? (
          <div className="flex items-center gap-4 rounded-xl border bg-card p-4 md:@max-xl/type:flex-wrap md:@max-xl/type:gap-y-3">
            <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center text-primary font-bold text-lg shrink-0">
              {member.nickname.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1 md:@max-xl/type:basis-[calc(100%-4rem)]">
              <div className="font-bold text-lg truncate md:@max-xl/type:whitespace-normal">{member.nickname}</div>
              <div className="text-sm text-muted-foreground truncate">{formatStoredPhone(member.phone)}</div>
            </div>
            {verification ? (
              <>
                {/* The recorded document expiry has passed: the rate holds and
                    staff can sell at it; this asks for the document again. */}
                {verification.reverifyDue && (
                  <button
                    type="button"
                    onClick={() => onRequestVerify(verification.tier)}
                    className="flex items-center gap-2 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-4 py-2 text-sm font-semibold shrink-0 hover:bg-amber-500/25"
                  >
                    <ShieldQuestion className="w-4 h-4" />
                    Document expired — re-verify
                  </button>
                )}
                <div className="flex items-center gap-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-4 py-2 text-sm font-semibold shrink-0">
                  <BadgeCheck className="w-4 h-4" />
                  {tierLabel(verification.tier)} · verified
                </div>
              </>
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
      {/* SCRUM-959 — in the split view the three cards stand whole above the
          fold with a member whose name takes two lines and the "overdue" bar
          above the till (staging's 01b had the Thai card's last line 32px
          under it): the cards sit 8px apart and 12px deep rather than 16,
          and the verified card's badge keeps clear of its title alone, so its
          proof line is one line, not two. */}
      <div className="grid grid-cols-1 @xl:grid-cols-3 gap-6 md:@max-xl/type:gap-2">
        {shownTiers.map((t) => {
          const tier = t.id;
          const isDefault = isDefaultTier(tier);
          const { icon: Icon, blurb } = tierPresentation(tier, isDefault);
          const verified = isTierVerified(member, tier);
          const isSelected = selectedTier === tier;
          const needsVerify = !isDefault && !verified;

          return (
            <Card
              key={tier}
              className={`relative flex flex-col items-center justify-center p-8 md:@max-xl/type:flex-row md:@max-xl/type:justify-start md:@max-xl/type:gap-4 md:@max-xl/type:px-4 md:@max-xl/type:py-3 cursor-pointer transition-all hover:-translate-y-1 active:translate-y-0 ${
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
                className={`h-20 w-20 rounded-full flex items-center justify-center mb-6 md:@max-xl/type:h-12 md:@max-xl/type:w-12 md:@max-xl/type:mb-0 md:@max-xl/type:shrink-0 ${
                  verified && !isDefault ? 'bg-emerald-500/15' : 'bg-primary/20'
                }`}
              >
                <Icon
                  className={`h-10 w-10 md:@max-xl/type:h-6 md:@max-xl/type:w-6 ${
                    verified && !isDefault ? 'text-emerald-500' : 'text-primary'
                  }`}
                />
              </div>
              {/* SCRUM-884 — the card's words as one block: centred under
                  the icon as the prototype draws them, beside it in the split view. */}
              <div className="flex flex-col items-center md:@max-xl/type:items-start md:@max-xl/type:min-w-0">
                <h3 className={`text-2xl font-bold mb-2 md:@max-xl/type:text-xl md:@max-xl/type:mb-0.5 ${!isDefault && verified ? 'md:@max-xl/type:pr-20' : ''}`}>{tierLabel(tier)}</h3>
                <p className="text-muted-foreground text-center md:@max-xl/type:text-left">{blurb}</p>
                {needsVerify ? (
                  <p className="mt-3 text-sm font-semibold text-amber-600 dark:text-amber-400 text-center md:@max-xl/type:mt-1 md:@max-xl/type:text-left">
                    Proof required — verify now
                  </p>
                ) : !isDefault && verified ? (
                  <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400 text-center md:@max-xl/type:mt-1 md:@max-xl/type:text-left">
                    {verification && tierProofLabel(verification.proofType, verification.note)} — no proof needed
                  </p>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      {/* SCRUM-858 — only this member's rate is on offer above; the way back
          to every rate for this sale, and nothing else. It sits under the
          card, not in the banner: in the split view the staff panel is too
          narrow for a second pill beside the badge, and the member's name
          and number must stay readable there. */}
      {soleTier && (
        <div className="mt-3">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onShowAllTiers}>
            <LayoutGrid className="w-4 h-4" />
            Show all rates
          </Button>
        </div>
      )}

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
