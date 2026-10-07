import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  CartLine,
  CustomerTier,
  ManualDiscount,
  Member,
  PartyBooking,
  Sale,
  TicketType,
  TierVerification,
} from '@/types';
import {
  getDefaultTier,
  getDiscountReasons,
} from '@/mockApi';
import { lookupMember } from '@/api/members';
import { toast } from '@/hooks/use-toast';
import { computeLineTotal, computeLineBreakdown } from '@/lib/pricing';
import { ticketTotals } from '@/lib/cartWire';
import { resolveAutoTier } from '@/lib/membership';
import { dropOrphanedDiscounts } from '@/lib/manualDiscount';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import { useOperator } from '@/auth/OperatorContext';
import type { PartyChargeConfirmation, PartyChargeLine } from '@/api/parties';
import { PartyChargeHeldNote } from './PartyChargeHeldNote';
import { usePartyChargeHold } from './usePartyChargeHold';
import { StepCustomerType } from '@/components/till/StepCustomerType';
import { StepAddTicket } from '@/components/till/StepAddTicket';
import { OrderSummary } from '@/components/till/OrderSummary';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { VerifyTierModal } from '@/components/shared/VerifyTierModal';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import type { DiscountComponentOption } from '@/components/shared/ManualDiscountModal';
import { Monitor, PartyPopper } from 'lucide-react';

interface PartyTicketModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  party: PartyBooking;
  operatorName: string;
  /**
   * S2-20 E4: a request on the platform, which may answer later, or no. From
   * the press to the answer the order is held exactly as it was sent; the
   * modal closes on a charge; a definite no leaves the order open to change;
   * no answer keeps it held (`PartyChargeConfirmation`, `usePartyChargeHold`).
   */
  onCharge: (items: PartyChargeLine[], total: number) => PartyChargeConfirmation | Promise<PartyChargeConfirmation>;
}

// Break a ticket line into its discountable component rows for the manual-discount
// picker — mirrors the Till's helper so the modal prices components identically.
function lineDiscountComponents(line: CartLine): DiscountComponentOption[] {
  return computeLineBreakdown(line).map((item) => ({
    target: item.kind === 'addon' ? { kind: 'addon', addOnId: item.key } : { kind: item.kind },
    label: item.quantity > 1 ? `${item.label} × ${item.quantity}` : item.label,
    amount: item.subtotal,
  }));
}

// The party ticket builder reuses the Till's ticket flow verbatim — tier step
// (StepCustomerType + VerifyTierModal), then the ticket grid (StepAddTicket) +
// OrderSummary on the left and the live CustomerDisplay on the right. The only
// difference from a walk-in sale is the outcome: rather than finalizing a sale
// (no credit grants minted, no prints, no check-in), the built lines + total are
// appended to the party tab as an extra charge.
export function PartyTicketModal({
  open,
  onOpenChange,
  party,
  operatorName,
  onCharge,
}: PartyTicketModalProps) {
  const { operator } = useOperator();

  // Charge target rides on the shared order state both surfaces read, derived
  // from the stable `party` prop so it can never go missing mid-order.
  const chargeTarget = useMemo(
    () => ({
      partyId: party.id,
      partyTitle: party.title,
      childName: party.childName,
      parentName: party.parentName,
      phone: party.whatsapp,
    }),
    [party.id, party.title, party.childName, party.parentName, party.whatsapp],
  );

  // Member identity comes from the party's parent (same name + phone), looked
  // up on the platform each time the builder opens (S2-09b, SCRUM-204) — the
  // member the till's membership check finds, not this browser's fixtures. A
  // number the platform does not know leaves no member and the default rate,
  // as before; a lookup that fails says so and leaves the same.
  const [member, setMember] = useState<Member | null>(null);
  useEffect(() => {
    if (!open) return;
    const phone = party.whatsapp?.trim() ?? '';
    if (!phone) {
      setMember(null);
      return;
    }
    let current = true;
    lookupMember(phone).then(
      (found) => {
        if (current) setMember(found);
      },
      (err: unknown) => {
        if (!current) return;
        setMember(null);
        toast({
          title: 'Membership lookup failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      },
    );
    return () => {
      current = false;
    };
  }, [open, party.whatsapp]);

  const [phase, setPhase] = useState<'tier' | 'build'>('tier');
  const [tier, setTier] = useState<CustomerTier>(
    member ? resolveAutoTier(member) : getDefaultTier().id,
  );
  // The member's own rate is the tier step's first offer, as it was when the
  // lookup answered at once — it now arrives with the answer. A tier staff
  // have already picked stands.
  useEffect(() => {
    if (phase === 'tier') setTier(member ? resolveAutoTier(member) : getDefaultTier().id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the answer, not on a step change
  }, [member]);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [customerTheme] = useCustomerTheme();

  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyTier, setVerifyTier] = useState<CustomerTier | null>(null);
  const [showDiscountModal, setShowDiscountModal] = useState(false);

  // S2-20 E4 — from the charge press until the platform says yes or no, the
  // order is held exactly as it was sent: nothing adds to it, changes, clears
  // or leaves it meanwhile (each is refused with "Order held"), and after an
  // answer that never came the charge press sends it again.
  const hold = usePartyChargeHold();
  const whileHeld = hold.refused;

  const activeLine = lines.find((l) => l.id === activeLineId) ?? null;

  const { subtotal, total } = useMemo(
    () => ticketTotals(lines, [], manualDiscounts),
    [lines, manualDiscounts],
  );

  const reset = () => {
    setPhase('tier');
    setTier(member ? resolveAutoTier(member) : getDefaultTier().id);
    setLines([]);
    setActiveLineId(null);
    setManualDiscounts([]);
    setShowVerifyModal(false);
    setVerifyTier(null);
    setShowDiscountModal(false);
    hold.release();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (whileHeld()) return;
      reset();
    }
    onOpenChange(next);
  };

  // --- Tier step (mirrors the Till) ---------------------------------------
  const handlePickTier = (t: CustomerTier) => {
    if (whileHeld()) return;
    setTier(t);
    setPhase('build');
  };

  const handleRequestVerify = (t: CustomerTier) => {
    if (whileHeld()) return;
    setVerifyTier(t);
    setShowVerifyModal(true);
  };

  const handleVerified = ({ verification }: { member: Member | null; verification: TierVerification }) => {
    if (whileHeld()) return;
    setTier(verification.tier);
    setPhase('build');
  };

  // --- Ticket lines (mirrors the Till, minus drop-off) --------------------
  const handleSelectTicket = (ticket: TicketType) => {
    if (whileHeld()) return;
    const id = Math.random().toString(36).substring(7);
    const base = { ticketType: ticket, tier, kids: 1, adults: 1, socks: 0, addOns: [] };
    const line: CartLine = { id, ...base, lineTotal: computeLineTotal(base) };
    setLines((prev) => [...prev, line]);
    setActiveLineId(id);
  };

  const handleUpdateLine = (
    id: string,
    updates: Partial<Pick<CartLine, 'kids' | 'adults' | 'socks' | 'addOns'>>,
  ) => {
    if (whileHeld()) return;
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const next = { ...l, ...updates };
        return { ...next, lineTotal: computeLineTotal(next) };
      }),
    );
  };

  const handleRemoveLine = (id: string) => {
    if (whileHeld()) return;
    setLines((prev) => {
      const next = prev.filter((l) => l.id !== id);
      setManualDiscounts((mds) => dropOrphanedDiscounts(mds, next));
      return next;
    });
    setActiveLineId((prev) => (prev === id ? null : prev));
  };

  const handleApplyManualDiscount = (md: ManualDiscount) => {
    if (whileHeld()) return;
    setManualDiscounts((prev) => [...prev, md]);
  };

  const handleRemoveManualDiscount = (id: string) => {
    if (whileHeld()) return;
    setManualDiscounts((prev) => prev.filter((md) => md.id !== id));
  };

  const handleCharge = async () => {
    if (lines.length === 0) return;
    // Items are the per-component breakdown of each ticket line (descriptive);
    // the authoritative charge is `total` (after any manual discounts + tax).
    const items = lines.flatMap((l) =>
      computeLineBreakdown(l).map((b) => ({
        name: `${l.ticketType.name} · ${b.label}`,
        qty: b.quantity,
        lineTotal: b.subtotal,
      })),
    );
    // Held from here: the order on screen is the order sent. On its way
    // already (a second press), nothing more is sent.
    const result = await hold.charge(
      () => ({ items, total }),
      (sent) => onCharge(sent.items, sent.total),
    );
    // No answer: still held as sent. A definite no: the order is staff's again.
    if (!result?.charged) return;
    reset();
    onOpenChange(false);
  };

  // A read-only Sale projection for the customer display (order stage only) —
  // only the order-stage fields are meaningful; the rest satisfy the type.
  const sale: Sale = useMemo(
    () => ({
      id: `party-ticket-${party.id}`,
      operatorId: operator?.id ?? '',
      operatorName: operator?.name ?? operatorName,
      tier,
      lines,
      manualDiscounts,
      total,
      creditGrants: [],
      bracelets: { adults: 0, children: 0 },
      createdAt: '',
      status: 'paid',
      refunds: [],
    }),
    [party.id, operator, operatorName, tier, lines, manualDiscounts, total],
  );

  const canCharge = lines.some((l) => l.kids + l.adults > 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-none w-screen h-[100dvh] p-0 gap-0 border-0 rounded-none overflow-hidden flex flex-col bg-background">
        <DialogTitle className="sr-only">Add tickets to {party.title}</DialogTitle>
        <DialogDescription className="sr-only">
          Build a ticket order on the staff station; the customer display mirrors it live. The order
          is charged to the party tab.
        </DialogDescription>

        {/* Test-harness banner — identical pattern to the F&B party modal */}
        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <Monitor className="w-4 h-4 shrink-0" />
            <span className="truncate">
              Adding tickets to {party.title} — staff station (left) + customer display (right) share
              one live order. Charged to the party tab by {operatorName}.
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-amber-300 hover:text-amber-200 hover:bg-amber-500/20"
            onClick={() => setShowCustomerDisplay((v) => !v)}
          >
            {showCustomerDisplay ? 'Hide' : 'Show'} customer display
          </Button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div
            className={`${showCustomerDisplay ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0`}
          >
            <div className="flex flex-col h-full min-h-0 bg-background text-foreground">
              <div className="shrink-0 flex items-center gap-2 bg-primary/10 border-b border-primary/20 px-6 py-3">
                <PartyPopper className="w-5 h-5 text-primary shrink-0" />
                <span className="font-semibold">
                  Charging to: {party.title}
                  {party.childName ? ` (${party.childName})` : ''}
                </span>
              </div>

              {phase === 'tier' ? (
                <div className="flex-1 min-h-0 p-6 overflow-y-auto">
                  <StepCustomerType
                    member={member}
                    selectedTier={tier}
                    onPickTier={handlePickTier}
                    onRequestVerify={handleRequestVerify}
                  />
                </div>
              ) : (
                <div className="flex-1 flex min-h-0">
                  <div className="flex-1 min-w-0 p-6 border-r bg-card/20 overflow-y-auto">
                    <StepAddTicket
                      tier={tier}
                      activeLine={activeLine}
                      hasLines={lines.length > 0}
                      onSelectTicket={handleSelectTicket}
                      onUpdateLine={handleUpdateLine}
                      onAddDropOff={() => {}}
                      onBackToGrid={() => setActiveLineId(null)}
                      onDone={() => setActiveLineId(null)}
                      hideDropOff
                    />
                  </div>
                  <div className="w-[380px] shrink-0 bg-sidebar p-6">
                    <OrderSummary
                      tier={tier}
                      chargeTarget={chargeTarget}
                      lines={lines}
                      activeLineId={activeLineId}
                      discounts={[]}
                      manualDiscounts={manualDiscounts}
                      onUpdateLine={handleUpdateLine}
                      onRemoveLine={handleRemoveLine}
                      onRemoveDiscount={() => {}}
                      onAddManualDiscount={() => {
                        if (!whileHeld()) setShowDiscountModal(true);
                      }}
                      onRemoveManualDiscount={handleRemoveManualDiscount}
                      onPay={() => void handleCharge()}
                      onCancel={() => handleOpenChange(false)}
                      canPay={canCharge && !hold.sending}
                      payLabel={`Charge ฿${total} to party`}
                      priceNote={hold.unanswered ? <PartyChargeHeldNote /> : undefined}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {showCustomerDisplay && (
            <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
              <CustomerDisplay
                stage="order"
                sale={sale}
                phone={party.whatsapp ?? ''}
                nickname={member?.nickname ?? party.parentName}
                member={member}
                chargeTarget={chargeTarget}
                onPhoneChange={() => {}}
                onNicknameChange={() => {}}
                onIdentify={() => {}}
                onSkipIdentify={() => {}}
                onCustomerDone={() => {}}
              />
            </div>
          )}
        </div>
      </DialogContent>

      {operator && verifyTier && (
        <VerifyTierModal
          open={showVerifyModal}
          onOpenChange={setShowVerifyModal}
          tier={verifyTier}
          member={member}
          operatorId={operator.id}
          operatorName={operator.name}
          onConfirm={handleVerified}
        />
      )}

      {operator && (
        <ManualDiscountModal
          open={showDiscountModal}
          onOpenChange={setShowDiscountModal}
          subtotal={subtotal}
          lines={lines.map((l) => ({
            id: l.id,
            label: l.ticketType.name,
            amount: l.lineTotal,
            components: lineDiscountComponents(l),
          }))}
          reasons={getDiscountReasons()}
          operatorId={operator.id}
          operatorName={operator.name}
          onApply={handleApplyManualDiscount}
        />
      )}
    </Dialog>
  );
}
