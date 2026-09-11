import { useMemo } from 'react';
import { CartLine, CustomerTier, TicketType, DropOffServiceType, SelectedAddOn, AddOnVariantQty } from '@/types';
import { getTicketTypes, getNannyRoster, getDropOffPricing, getAddOns } from '@/mockApi';
import { getInventoryItem } from '@/store/catalogStore';
import { priceForTier, setAddOnQty, setAddOnVariants } from '@/lib/pricing';
import { resolveDropOffPricing } from '@/lib/dropoff';
import { resolveRateToday } from '@/lib/pricingMode';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TicketCard } from './TicketCard';
import { AddOnsGrid } from './AddOnsGrid';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { ArrowLeft, Baby, UserCheck, AlertTriangle, Users, Footprints } from 'lucide-react';

const SOCKS_ID = 'a-socks';

// Semantic patch the till applies to a drop-off line (it recomputes the fee +
// lineTotal). Keeps pricing logic in one place (handleUpdateDropOffLine).
export interface DropOffLineUpdate {
  ticketType?: TicketType;
  service?: DropOffServiceType;
  nannyId?: string;
  nannyName?: string;
}

interface DropOffLineConfigProps {
  line: CartLine; // a line with `dropOff` set
  tier: CustomerTier;
  /** Other drop-off nanny lines in THIS cart per nannyId (excludes this line). */
  cartNannyLoads: Record<string, number>;
  onUpdate: (id: string, update: DropOffLineUpdate) => void;
  /**
   * Update the child's extras (socks / add-ons). Routed separately from onUpdate
   * so the till re-runs normalizeDropOffFees (the service fee stays nested in
   * dropOff) rather than the plain per-line pricing path.
   */
  onUpdateExtras: (id: string, updates: { socks?: number; addOns?: SelectedAddOn[] }) => void;
  /** Assign the chosen nanny to every nanny drop-off line in the cart. */
  onAssignNannyToAll: (nannyId: string, nannyName: string) => void;
  /**
   * A nanny already assigned to another drop-off child in THIS cart, if any.
   * Lets staff one-tap "same nanny as the others" when configuring a sibling.
   */
  siblingNanny?: { id: string; name: string };
  onBackToGrid: () => void;
  onDone: () => void;
}

/**
 * Per-line config for a drop-off child inside the till. The child identity comes
 * from the registration (read-only); staff explicitly choose the play ticket
 * length (no default — it prices both the play time AND the nanny supervision),
 * the service (flat drop-off fee or per-hour nanny), and — for nanny — a nanny.
 * The 1:1 ratio is relaxed: one nanny can cover several siblings, so the picker
 * shows every on-shift nanny with her load and only soft-warns past the max.
 */
export function DropOffLineConfig({
  line,
  tier,
  cartNannyLoads,
  onUpdate,
  onUpdateExtras,
  onAssignNannyToAll,
  siblingNanny,
  onBackToGrid,
  onDone,
}: DropOffLineConfigProps) {
  const tickets = useMemo(() => getTicketTypes(), []);
  const pricing = useMemo(() => resolveDropOffPricing(getDropOffPricing()), []);
  const allAddOns = useMemo(() => getAddOns(), []);
  const socksItem = allAddOns.find((a) => a.id === SOCKS_ID);
  // Stock cap for the socks stepper — prevents oversell when inventory is tracked.
  const socksInvItem = socksItem?.inventoryItemId
    ? getInventoryItem(socksItem.inventoryItemId)
    : undefined;
  const socksStock = socksInvItem?.variants[0]?.stock;
  const d = line.dropOff!;

  const setAddOnQuantity = (addOnId: string, quantity: number, variantId?: string) => {
    onUpdateExtras(line.id, {
      addOns: setAddOnQty(line.addOns, allAddOns, addOnId, quantity, variantId),
    });
  };

  const setAddOnVariantsForLine = (addOnId: string, breakdown: AddOnVariantQty[]) => {
    onUpdateExtras(line.id, {
      addOns: setAddOnVariants(line.addOns, allAddOns, addOnId, breakdown),
    });
  };

  // The child's own extras subtotal (socks + add-ons), shown in the summary and —
  // for nanny — added to the play-ticket figure (the shared fee is its own row).
  const socksPrice = socksItem ? resolveRateToday(socksItem.price) : 0;
  const extrasTotal =
    socksPrice * line.socks +
    line.addOns.reduce((sum, a) => sum + a.price * a.quantity, 0);
  const ownTotal = priceForTier(line.ticketType, tier) + extrasTotal;
  // Exclude this child's own pre-assignment from the load so her own nanny isn't
  // counted against herself.
  const roster = useMemo(() => getNannyRoster(d.checkInId), [d.checkInId]);

  const lengthChosen = d.lengthChosen;
  const nannyMissing = d.service === 'nanny' && !d.nannyId;
  const softMax = pricing.nannyRatioSoftMax;

  // Projected load for a nanny if SHE supervised this child too (park-wide active
  // kids + other cart siblings already on her + this one).
  const loadIfPicked = (nannyId: string) =>
    (roster.find((n) => n.id === nannyId)?.load ?? 0) + (cartNannyLoads[nannyId] ?? 0) + 1;
  const baseLoad = (nannyId: string) =>
    (roster.find((n) => n.id === nannyId)?.load ?? 0) + (cartNannyLoads[nannyId] ?? 0);

  const overRatio = !!d.nannyId && loadIfPicked(d.nannyId) > softMax;

  return (
    <div className="flex flex-col h-full animate-in slide-in-from-bottom-4 duration-300">
      <div className="mb-5 flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Baby className="w-7 h-7 text-primary shrink-0" />
            <span className="truncate">{d.childName}</span>
            <span className="text-muted-foreground font-normal text-2xl">· {d.childAge}y</span>
          </h2>
          {d.allergiesMedical && (
            <span className="inline-flex items-center gap-1.5 text-sm text-amber-300 mt-1">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {d.allergiesMedical}
            </span>
          )}
        </div>
        <Button variant="ghost" className="gap-2 shrink-0" onClick={onBackToGrid}>
          <ArrowLeft className="w-4 h-4" />
          Back to tickets
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 pr-1">
        {/* Play ticket — staff must pick a length (no default). */}
        <div>
          <h3 className="text-xl font-semibold mb-1">Play ticket length</h3>
          <p className="text-sm text-muted-foreground mb-3">
            {lengthChosen
              ? 'Sets both the play time and the nanny supervision hours.'
              : 'Choose a length to price this child (also sets nanny hours).'}
          </p>
          <div className="grid grid-cols-2 gap-4">
            {tickets.map((t) => (
              <TicketCard
                key={t.id}
                ticket={t}
                tier={tier}
                selected={lengthChosen && line.ticketType.id === t.id}
                onClick={() => onUpdate(line.id, { ticketType: t })}
              />
            ))}
          </div>
        </div>

        {/* Service type */}
        <div>
          <h3 className="text-xl font-semibold mb-3">Drop-off service</h3>
          <div className="grid grid-cols-2 gap-4">
            <Button
              type="button"
              variant={d.service === 'drop_off' ? 'default' : 'outline'}
              className="h-20 flex-col gap-0.5"
              onClick={() => onUpdate(line.id, { service: 'drop_off' })}
            >
              <span className="text-base font-bold">Drop-Off</span>
              <span className="text-xs opacity-80">Flat ฿{pricing.oneTimeFeeTHB}</span>
            </Button>
            <Button
              type="button"
              variant={d.service === 'nanny' ? 'default' : 'outline'}
              className="h-20 flex-col gap-0.5"
              onClick={() => onUpdate(line.id, { service: 'nanny' })}
            >
              <span className="text-base font-bold">Nanny</span>
              <span className="text-xs opacity-80">฿{pricing.nannyHourlyRateTHB}/hr · shared</span>
            </Button>
          </div>
        </div>

        {/* Nanny picker (relaxed ratio — one nanny may cover several kids). */}
        {d.service === 'nanny' && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5 uppercase tracking-wide">
              <UserCheck className="w-4 h-4" />
              Assign a nanny <span className="text-destructive">*</span>
            </p>
            {siblingNanny &&
              d.nannyId !== siblingNanny.id &&
              roster.find((n) => n.id === siblingNanny.id)?.onShift && (
              <Button
                type="button"
                variant="secondary"
                className="w-full gap-2 h-12"
                onClick={() =>
                  onUpdate(line.id, { nannyId: siblingNanny.id, nannyName: siblingNanny.name })
                }
              >
                <Users className="w-4 h-4" />
                Same nanny as the others · {siblingNanny.name}
              </Button>
            )}
            <div className="grid grid-cols-1 gap-2">
              {roster.map((n) => {
                const own = d.nannyId === n.id;
                const pickable = n.onShift;
                const shown = own ? loadIfPicked(n.id) : baseLoad(n.id);
                const status = !n.onShift
                  ? 'Off shift'
                  : shown > 0
                    ? `${shown} ${shown === 1 ? 'kid' : 'kids'}`
                    : 'Available';
                const willBeOver = pickable && loadIfPicked(n.id) > softMax;
                return (
                  <Button
                    key={n.id}
                    type="button"
                    disabled={!pickable}
                    variant={own ? 'default' : 'outline'}
                    className="h-12 justify-between text-base px-3"
                    onClick={() => onUpdate(line.id, { nannyId: n.id, nannyName: n.name })}
                  >
                    <span className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold shrink-0 text-sm">
                        {n.name.charAt(0).toUpperCase()}
                      </span>
                      {n.name}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        !pickable
                          ? 'text-muted-foreground'
                          : willBeOver
                            ? 'text-amber-300'
                            : 'text-emerald-400'
                      }`}
                    >
                      {status}
                    </span>
                  </Button>
                );
              })}
            </div>

            {d.nannyId && (
              <div className="space-y-2 pt-1">
                {overRatio && (
                  <div className="flex items-start gap-2 text-sm text-amber-300 bg-amber-300/10 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      {d.nannyName} would be looking after {loadIfPicked(d.nannyId)} children
                      (over the suggested {softMax}). Allowed — just double-check it's okay.
                    </span>
                  </div>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full gap-2"
                  onClick={() => onAssignNannyToAll(d.nannyId!, d.nannyName ?? '')}
                >
                  <Users className="w-4 h-4" />
                  Same nanny for all drop-off kids
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Extras & Add-ons — same list as the normal till (priced once length set). */}
        {lengthChosen && (
          <div>
            <h3 className="text-xl font-semibold mb-3">Extras &amp; Add-ons</h3>
            <Card
              className={`p-4 flex items-center justify-between gap-3 mb-4 ${
                line.socks > 0 ? 'border-primary bg-primary/10 ring-1 ring-primary' : ''
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                    line.socks > 0 ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Footprints className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-lg leading-tight">Regular Socks</div>
                  <div className="text-xs text-primary font-medium mt-0.5">฿{socksPrice} each</div>
                </div>
              </div>
              <QuantityStepper
                value={line.socks}
                max={socksStock}
                onChange={(v) => onUpdateExtras(line.id, { socks: v })}
                ariaLabel="Regular Socks"
              />
            </Card>
            <AddOnsGrid
              selected={line.addOns}
              onSetQuantity={setAddOnQuantity}
              onSetVariants={setAddOnVariantsForLine}
            />
          </div>
        )}

        {/* Line summary */}
        <Card className="p-4 space-y-1.5 text-sm">
          {lengthChosen ? (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{line.ticketType.name}</span>
                <span className="tabular-nums">฿{priceForTier(line.ticketType, tier)}</span>
              </div>
              {line.socks > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Regular Socks × {line.socks}
                  </span>
                  <span className="tabular-nums">฿{socksPrice * line.socks}</span>
                </div>
              )}
              {line.addOns.map((a) => (
                <div key={a.id} className="flex justify-between">
                  <span className="text-muted-foreground">
                    {a.name}
                    {a.quantity > 1 && ` × ${a.quantity}`}
                  </span>
                  <span className="tabular-nums">฿{a.price * a.quantity}</span>
                </div>
              ))}
              {d.service === 'nanny' ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Nanny · {d.hours}h{' '}
                    <span className="text-xs opacity-70">(shared, billed once)</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    ฿{pricing.nannyHourlyRateTHB * d.hours}
                  </span>
                </div>
              ) : (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Drop-off service</span>
                  <span className="tabular-nums">฿{pricing.oneTimeFeeTHB}</span>
                </div>
              )}
              <div className="flex justify-between font-bold pt-1.5 border-t">
                <span>{d.service === 'nanny' ? 'Child subtotal' : 'Line total'}</span>
                <span className="text-primary tabular-nums">
                  ฿{d.service === 'nanny' ? ownTotal : line.lineTotal}
                </span>
              </div>
              {d.service === 'nanny' && (
                <p className="text-xs text-muted-foreground pt-1">
                  The shared nanny fee appears once on the order summary.
                </p>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Choose a play ticket length to price this child.
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6 pt-6 border-t grid grid-cols-2 gap-4">
        <Button variant="outline" size="lg" className="h-16 text-lg" onClick={onBackToGrid}>
          Back to tickets
        </Button>
        <Button
          size="lg"
          className="h-16 text-xl font-bold"
          disabled={!lengthChosen || nannyMissing}
          onClick={onDone}
        >
          {!lengthChosen ? 'Choose length' : nannyMissing ? 'Assign a nanny' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}
