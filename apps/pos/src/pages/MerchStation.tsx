import { useEffect, useMemo, useRef, useState } from 'react';
import { StationHeader } from '@/components/shared/StationHeader';
import { setSaleOpen } from '@/pwa/openSale';
import { Discount, ManualDiscount, MerchItem, MerchOrder, MerchOrderLine, Wristband } from '@/types';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import { getActiveMerchItems, chargeMerchCredit, getDiscountByCode, getDiscountReasons, recordMerchOrder, getInventoryItem } from '@/mockApi';
import { computeMerchLineTotal, isOutOfStock } from '@/lib/merch';
import { validateItemPromoCode } from '@/lib/itemPromo';
import { useItemCartQuoteWithPromos } from '@/lib/itemPromoQuote';
import { useSaleWriter } from '@/lib/saleWriter';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { useBranch } from '@/branch/BranchContext';
import { useStation } from '@/station/StationContext';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { getDefaultTier } from '@/store/catalogStore';
import { menuIsServerBacked } from '@/api/menu';
import {
  buildItemCartPayload,
  type ApiSale,
  type ItemCartIdentity,
  type SaleCartPayload,
} from '@/api/sales';
import {
  PriceSourceNote,
  SaleNotSavedNotice,
  SaleWriteFailure,
} from '@/components/till/SaleWriteStatus';
import { QuoteRefusalNote } from '@/components/fnb/QuoteRefusalNote';
import { QuoteFaultNote } from '@/components/fnb/QuoteFaultNote';
import { VariantPickerModal } from '@/components/shared/VariantPickerModal';
import { ScanWristband } from '@/components/fnb/ScanWristband';
import { MerchGrid } from '@/components/merch/MerchGrid';
import { MerchCart } from '@/components/merch/MerchCart';
import { FnbPayment, FnbPaymentResult, FnbMethod, FnbRemainder } from '@/components/fnb/FnbPayment';
import { MerchConfirmation } from '@/components/merch/MerchConfirmation';
import { MerchCustomerDisplay, MerchCustomerStage } from '@/components/merch/MerchCustomerDisplay';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { useOperator } from '@/auth/OperatorContext';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Monitor } from 'lucide-react';

type Stage = 'scan' | 'order' | 'payment' | 'confirmation';

let orderCounter = 1;
let lineCounter = 1;

/**
 * WHICH TENDER CLOSED THE SALE — the same rule the F&B station follows: the
 * bucket that settled the balance is the one the ledger records, and a sale
 * paid from a band's wallet is named as one because that balance is still this
 * till's own record (S2-14a).
 */
function tenderMethodOf(payment: FnbPaymentResult): string {
  if (payment.cash > 0) return 'cash';
  if (payment.card > 0) return 'card';
  if (payment.promptpay > 0) return 'promptpay';
  return 'wallet_credit';
}

function tenderKindOf(payment: FnbPaymentResult): 'cash' | 'card' | 'qr' | 'other' {
  if (payment.cash > 0) return 'cash';
  if (payment.card > 0) return 'card';
  if (payment.promptpay > 0) return 'qr';
  return 'other';
}

export default function MerchStation() {
  const { operator } = useOperator();
  const { branch } = useBranch();
  const { station } = useStation();

  const [stage, setStage] = useState<Stage>('scan');
  const [wristband, setWristband] = useState<Wristband | null>(null);
  const [cart, setCart] = useState<MerchOrderLine[]>([]);
  // Item awaiting variant selection (multi-variant inventory items).
  const [pendingVariantItem, setPendingVariantItem] = useState<MerchItem | null>(null);
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  /**
   * THE PROMO CODES ON THIS SALE — SCRUM-362, the same state the F&B station
   * holds: the branch's own discount definitions, sent with the sale so the
   * platform prices them, and priced here by the same engine when it cannot.
   */
  const [promoCodes, setPromoCodes] = useState<Discount[]>([]);
  /** The refusal for the last code entered, drawn under the entry. */
  const [promoError, setPromoError] = useState('');
  const [completedOrder, setCompletedOrder] = useState<MerchOrder | null>(null);
  const [newBalance, setNewBalance] = useState<number | null>(null);
  /** The same writer the till and the F&B station use — see `lib/saleWriter.ts`. */
  const saleWriter = useSaleWriter();
  const [platformSale, setPlatformSale] = useState<ApiSale | null>(null);
  /** Bumped on every new sale, so a late answer cannot land on the next guest. */
  const saleEpochRef = useRef(0);
  /** Bumped when a sale finishes, so the grid re-reads the stock it decremented. */
  const [soldEpoch, setSoldEpoch] = useState(0);

  // Same reason as the till's (S2-06): a new build must not be swapped in
  // under a sale somebody is still ringing up.
  const saleOnScreen = cart.length > 0 || completedOrder !== null;
  useEffect(() => {
    setSaleOpen('merch-station', saleOnScreen);
    return () => setSaleOpen('merch-station', false);
  }, [saleOnScreen]);
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [customerTheme] = useCustomerTheme();
  const [payMethod, setPayMethod] = useState<FnbMethod | null>(null);
  const [payRemainder, setPayRemainder] = useState<FnbRemainder>('card');

  /**
   * THE SHOP GRID IS THE PLATFORM'S (S2-09b). The merch rows live in the same
   * `pos.product` table the menu does and arrive in the same answer, hydrated
   * into the catalogue store at sign-in and after any admin save
   * (`api/menu.ts:reloadMenuInto`). Read through the store rather than
   * snapshotted at mount, so a price edited in the Merch panel is on the shop
   * grid at the next pull without the station being reopened.
   *
   * `getActiveMerchItems()` rather than the snapshot's raw list: it drops the
   * retired rows and resolves each item's on-hand stock, which is still the
   * ported stock module's (S2-14b).
   */
  const catalogue = useCatalogStore();
  const merchItems = useMemo(
    () => getActiveMerchItems(),
    // Recomputed when either half of what it reads moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogue.merchItems, catalogue.inventory, soldEpoch],
  );
  const shopFromPlatform = menuIsServerBacked();

  const lines = cart;

  /**
   * WHO THIS SALE BELONGS TO, in the platform's own ids. Null when this device
   * is on no platform station, in which case the sale is priced here, said to
   * be, and the confirmation says plainly that nothing reached the ledger.
   */
  const saleIdentity: ItemCartIdentity | null = useMemo(() => {
    const branchId = apiBranchIdForSlug(branch.id);
    if (!branchId || !station?.stationId || !operator) return null;
    return {
      branchId,
      stationId: station.stationId,
      // A merch row is flat-priced from its catalogue row; no tier reads it.
      tier: getDefaultTier()?.id ?? 'tourist',
      channel: 'shop',
      memberId: null,
      customerPhone: null,
      customerNickname: null,
      accountId: operator.id,
      accountName: operator.name,
    };
  }, [branch.id, station?.stationId, operator]);

  /**
   * THE PRICE THE PLATFORM QUOTES FOR THIS SALE. The prototype totalled the
   * shop cart in the browser (`computeMerchTotals`); that is now the fallback,
   * and when it is what is on screen the note above the charge button says so.
   */
  const sale = useItemCartQuoteWithPromos({
    kind: 'shop',
    lines,
    manualDiscounts,
    promos: promoCodes,
    identity: saleIdentity,
    enabled: stage !== 'confirmation',
  });
  const { subtotal, total, manualAmounts, taxBreakdown } = sale.totals;

  /**
   * THE PLATFORM LOOKED AT THIS SALE AND OBJECTED — SCRUM-352, the rule the
   * F&B station has carried since SCRUM-342/351 (`pages/OrderStation.tsx`).
   *
   * While a refusal stands the charge button is off. The rule that refused the
   * quote is the rule the commit meets, so the press could only carry the guest
   * to the payment screen and fail there; before this the refusal was advisory
   * — the note said the sale was refused and the button beneath it invited the
   * press anyway. It clears the moment a later quote answers — the stale line
   * re-priced, the item taken off — and the button comes back with it.
   *
   * A FAULT IS NOT THAT: the api breaking, or a proxy answering in its place.
   * Neither is a judgement on this sale, so the button stays on and the shop
   * sells through the outage on this till's own figures — `QuoteFaultNote` says
   * the platform failed and `PriceSourceNote` says whose figure is on the
   * screen. Until this ticket both arrived at `QuoteRefusalNote` together and
   * an outage read to the counter as "the platform refused this order".
   *
   * A sale the platform was never asked about is a third thing and reaches
   * neither note: `quoteItemCart` answers that one with this till's figures and
   * a reason rather than rejecting (`api/sales.ts`), so `sale.error` is null
   * and only the source note is drawn.
   */
  const quoteError = sale.error;
  const quoteRefusal = quoteError && quoteError.kind === 'refusal' ? quoteError : null;
  const quoteFault = quoteError && quoteError.kind === 'fault' ? quoteError : null;

  /** The rows as the panel draws them — the platform's figure where it quoted one. */
  const displayLines = useMemo(() => {
    const quoted = sale.quote.lineTotals;
    if (!quoted) return lines;
    return lines.map((line) =>
      quoted[line.id] === undefined ? line : { ...line, lineTotal: quoted[line.id] },
    );
  }, [lines, sale.quote.lineTotals]);

  // Total qty per merch item across all lines — drives the in-grid badge and the
  // remaining-availability clamp.
  const quantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of cart) map[line.merchItem.id] = (map[line.merchItem.id] ?? 0) + line.qty;
    return map;
  }, [cart]);

  // Core add-to-cart helper — merges into an existing line that matches both item
  // id AND variantId (multi-variant merch items get one line per variant).
  const addToCart = (item: MerchItem, variantId?: string, variantLabel?: string) => {
    setCart((prev) => {
      const existing = prev.find(
        (l) => l.merchItem.id === item.id && l.variantId === variantId,
      );
      const current = existing?.qty ?? 0;

      // Per-variant stock clamp when variantId is known; total stock otherwise.
      let maxStock: number;
      if (variantId && item.inventoryItemId) {
        const invItem = getInventoryItem(item.inventoryItemId);
        const v = invItem?.variants.find((vv) => vv.id === variantId);
        maxStock = v?.stock ?? Infinity;
      } else {
        maxStock = item.stock ?? Infinity;
      }
      if (current >= maxStock) return prev;

      if (existing) {
        const newQty = current + 1;
        return prev.map((l) =>
          l === existing
            ? { ...l, qty: newQty, lineTotal: computeMerchLineTotal(item, newQty) }
            : l,
        );
      }
      const line: MerchOrderLine = {
        id: `mline-${lineCounter++}`,
        merchItem: item,
        qty: 1,
        lineTotal: computeMerchLineTotal(item, 1),
        ...(variantId ? { variantId, variantLabel } : {}),
      };
      return [...prev, line];
    });
  };

  // Tap on the merch grid: multi-variant items open a picker first.
  const handleAdd = (item: MerchItem) => {
    if (isOutOfStock(item)) return;
    if (item.inventoryItemId) {
      const invItem = getInventoryItem(item.inventoryItemId);
      if (invItem && invItem.variants.length > 1) {
        setPendingVariantItem(item);
        return;
      }
    }
    addToCart(item);
  };

  const handlePickMerchVariant = (variantId: string) => {
    if (!pendingVariantItem) return;
    const invItem = getInventoryItem(pendingVariantItem.inventoryItemId!);
    const label = invItem?.variants.find((v) => v.id === variantId)?.label;
    addToCart(pendingVariantItem, variantId, label);
    setPendingVariantItem(null);
  };

  const handleChangeQty = (lineId: string, qty: number) => {
    if (qty <= 0) {
      // Line removed — drop any manual discount that targeted it.
      setManualDiscounts((prev) => prev.filter((md) => md.targetLineId !== lineId));
    }
    setCart((prev) => {
      if (qty <= 0) return prev.filter((l) => l.id !== lineId);
      return prev.map((l) => {
        if (l.id !== lineId) return l;
        // Per-variant stock clamp for inventory-backed lines.
        let maxStock: number;
        if (l.variantId && l.merchItem.inventoryItemId) {
          const invItem = getInventoryItem(l.merchItem.inventoryItemId);
          const v = invItem?.variants.find((vv) => vv.id === l.variantId);
          maxStock = v?.stock ?? Infinity;
        } else {
          maxStock = l.merchItem.stock ?? Infinity;
        }
        const clamped = Math.min(qty, maxStock);
        return { ...l, qty: clamped, lineTotal: computeMerchLineTotal(l.merchItem, clamped) };
      });
    });
  };

  const handleApplyManualDiscount = (md: ManualDiscount) => {
    setManualDiscounts((prev) => [...prev, md]);
  };

  const handleRemoveManualDiscount = (id: string) => {
    setManualDiscounts((prev) => prev.filter((md) => md.id !== id));
  };

  /**
   * Put a promo code on the sale, or say why it cannot go on — the F&B
   * station's handler, against shop rows. The code is checked against THIS sale
   * by the engine that will price it (`lib/itemPromo.ts`), so a code accepted
   * here is a code the platform will honour.
   */
  const handleApplyPromoCode = (code: string) => {
    const promo = getDiscountByCode(code);
    if (!promo) {
      setPromoError(`Code "${code.toUpperCase()}" was not found.`);
      return;
    }
    const result = validateItemPromoCode(promo, lines, { applied: promoCodes });
    if (!result.ok) {
      setPromoError(result.reason);
      return;
    }
    setPromoError('');
    setPromoCodes((prev) => [...prev, promo]);
  };

  const handleRemovePromoCode = (code: string) => {
    setPromoCodes((prev) => prev.filter((promo) => promo.code !== code));
    setPromoError('');
  };

  const handleClearCart = () => {
    setCart([]);
    setManualDiscounts([]);
    setPromoCodes([]);
    setPromoError('');
  };

  const loadBand = (wb: Wristband | null) => {
    setWristband(wb);
    setStage('order');
  };

  const resetOrder = () => {
    // A new sale takes new ids; any answer still in flight for the previous one
    // is ignored rather than drawn onto this guest.
    saleEpochRef.current += 1;
    saleWriter.reset();
    setPlatformSale(null);
    setStage('scan');
    setWristband(null);
    setCart([]);
    setManualDiscounts([]);
    setPromoCodes([]);
    setPromoError('');
    setCompletedOrder(null);
    setNewBalance(null);
    setPayMethod(null);
    setPayRemainder('card');
    setSoldEpoch((n) => n + 1); // re-read on-hand stock after the sale's decrement
  };

  const handleCheckout = () => {
    // Wallet credit is one universal pool spendable at both stations.
    const balance = wristband?.creditBalanceTHB ?? 0;
    setPayMethod(balance > 0 ? 'credit' : null);
    setPayRemainder('card');
    setStage('payment');
  };

  /** The sale as the platform receives it, or null when there is nowhere to send it. */
  const commitPayload = (): SaleCartPayload | null => {
    if (!saleIdentity) return null;
    return buildItemCartPayload(displayLines, manualDiscounts, saleIdentity, total, {
      mode: sale.quote.pricingMode,
      modeReason: sale.quote.pricingModeReason,
      // The codes the quote was answered for, so the sale the platform prices
      // at commit is the sale it quoted.
      promos: promoCodes,
    });
  };

  const unwritableReason = (): string =>
    !saleIdentity
      ? 'This device is not on a platform station, so there is nowhere to write the sale.'
      : (sale.quote.reason ?? 'The platform could not price this sale.');

  /** Reaching the payment screen is the Pay press — the till's seam (S2-09a). */
  const recordSaleOnPlatform = async (epoch: number): Promise<void> => {
    const payload = commitPayload();
    if (!payload) return;
    const outcome = await saleWriter.commit({ cart: payload, finalise: total === 0 });
    if (saleEpochRef.current !== epoch && outcome.ok && outcome.written) {
      // The station moved on before the answer landed. The sale IS on the
      // platform and nothing on this screen will mention it again, so it is
      // said out loud rather than dropped.
      toast({
        title: 'A sale was saved for the previous guest',
        description: `This station moved on before it could finish. Sale ${outcome.sale.receiptNumber ?? outcome.saleId} is recorded and nothing was printed for it — find it in the sale list.`,
        variant: 'destructive',
      });
    }
  };

  useEffect(() => {
    if (stage !== 'payment') return;
    void recordSaleOnPlatform(saleEpochRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const handleConfirmPayment = (payment: FnbPaymentResult) => {
    void completeSale(payment);
  };

  const completeSale = async (payment: FnbPaymentResult) => {
    if (!operator) return;

    const epoch = saleEpochRef.current;
    const payload = commitPayload();
    let written: ApiSale | null = null;
    if (!payload) {
      saleWriter.declareUnwritten(unwritableReason());
    } else {
      const committed = await saleWriter.commit({ cart: payload, finalise: total === 0 });
      if (saleEpochRef.current !== epoch) return;
      if (!committed.ok) return; // the failure panel is showing; nothing is finalised
      if (committed.written) {
        written = committed.sale;
        if (written.status !== 'finalised') {
          const closed = await saleWriter.finalise({
            method: tenderMethodOf(payment),
            kind: tenderKindOf(payment),
            amountSatang: written.totals.grossSatang,
            tenderedSatang: written.totals.grossSatang,
            changeSatang: 0,
          });
          if (saleEpochRef.current !== epoch) return;
          if (!closed.ok) return;
          if (closed.written) written = closed.sale;
        }
      }
    }
    setPlatformSale(written);

    let balanceAfter: number | null = null;
    if (wristband && payment.creditUsed > 0) {
      balanceAfter = chargeMerchCredit(wristband.id, payment.creditUsed, operator.name);
    } else if (wristband) {
      balanceAfter = wristband.creditBalanceTHB ?? 0;
    }

    // The record this till keeps, carrying the figures the guest was shown.
    const record: MerchOrder = {
      id: String(orderCounter++).padStart(4, '0'),
      operatorId: operator.id,
      operatorName: operator.name,
      wristband: wristband ?? undefined,
      lines: displayLines,
      manualDiscounts,
      total,
      payment,
      createdAt: new Date().toISOString(),
      status: 'paid',
      refunds: [],
    };
    recordMerchOrder(record); // decrements on-hand stock in the store
    setCompletedOrder(record);
    setNewBalance(balanceAfter);
    setStage('confirmation');
  };

  let customerStage: MerchCustomerStage;
  if (stage === 'confirmation') customerStage = 'thankyou';
  else if (stage === 'payment') customerStage = 'payment';
  else if (stage === 'order') customerStage = 'order';
  else customerStage = 'welcome';

  // The amount the customer pays by Thai QR / PromptPay (full sale, or the
  // remainder after credit spend). null when no QR payment is in progress.
  const balance = wristband?.creditBalanceTHB ?? 0;
  const remainderAfterCredit = total - Math.min(balance, total);
  let promptpayAmount: number | null = null;
  if (stage === 'payment') {
    if (payMethod === 'promptpay') promptpayAmount = total;
    else if (payMethod === 'credit' && remainderAfterCredit > 0 && payRemainder === 'promptpay')
      promptpayAmount = remainderAfterCredit;
  }

  const staffStation = (
    <div className="h-full w-full flex flex-col bg-background text-foreground overflow-hidden">
      <div className="flex-1 min-h-0">
        {stage === 'scan' && (
          <ScanWristband
            title="Retail Sale"
            subtitle="Scan a wristband to put the sale on the customer's tab, or continue as a guest."
            onLoadTab={(wb) => loadBand(wb)}
            onGuest={() => loadBand(null)}
          />
        )}

        {stage === 'order' && (
          <div className="flex h-full min-h-0">
            <div className="flex-1 min-w-0 flex flex-col p-6 border-r bg-card/20">
              {/*
                WHAT THIS STATION STILL DOES ON ITS OWN. The catalogue and the
                prices are the platform's; the counts under each tile, the sizes
                a tile asks for and the band's balance are not, and each names
                the ticket that moves it.
              */}
              <div className="mb-4 shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-foreground/15 bg-foreground/5 px-4 py-2 text-xs text-muted-foreground">
                <span className="font-bold uppercase tracking-wide text-foreground/70">
                  This till&apos;s own record
                </span>
                <span>Stock counts, sizes and out-of-stock — S2-14b</span>
                <span>Wallet credit — S2-14a</span>
                <span>Receipt printing — S2-11</span>
                {!shopFromPlatform && (
                  <span className="text-amber-300">
                    Catalogue — this deployment has no menu route, so the ported one is shown
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0">
                <MerchGrid items={merchItems} quantities={quantities} onAdd={handleAdd} />
              </div>
            </div>
            <div className="w-[380px] shrink-0 bg-sidebar p-6">
              <MerchCart
                wristband={wristband}
                lines={displayLines}
                total={total}
                manualDiscounts={manualDiscounts}
                manualAmounts={manualAmounts}
                taxBreakdown={taxBreakdown}
                priceNote={
                  lines.length > 0 ? (
                    <div className="space-y-2">
                      <QuoteRefusalNote error={quoteRefusal} blocking />
                      <QuoteFaultNote error={quoteFault} />
                      <PriceSourceNote quote={sale.quote} pending={sale.pending} />
                    </div>
                  ) : null
                }
                chargeBlockedReason={quoteRefusal?.message ?? null}
                onChangeQty={handleChangeQty}
                onClear={handleClearCart}
                onCheckout={handleCheckout}
                onSwitchTab={resetOrder}
                onAddManualDiscount={() => setShowDiscountModal(true)}
                onRemoveManualDiscount={handleRemoveManualDiscount}
                promoCodes={sale.totals.scannedDiscounts}
                promoError={promoError}
                onApplyPromoCode={handleApplyPromoCode}
                onRemovePromoCode={handleRemovePromoCode}
              />
            </div>
          </div>
        )}

        {stage === 'payment' && (
          <div className="h-full min-h-0 overflow-y-auto">
            <FnbPayment
              total={total}
              wristband={wristband}
              creditBalanceOverride={wristband?.creditBalanceTHB ?? 0}
              pickupCode=""
              creditLabel="Credit"
              method={payMethod}
              remainder={payRemainder}
              onMethodChange={setPayMethod}
              onRemainderChange={setPayRemainder}
              onConfirm={handleConfirmPayment}
              onBack={() => setStage('order')}
            />
            <div className="mx-auto w-full max-w-2xl px-6 pb-6">
              <SaleWriteFailure
                state={saleWriter.state}
                onRetry={() => void recordSaleOnPlatform(saleEpochRef.current)}
                onDismiss={() => setStage('order')}
              />
            </div>
          </div>
        )}

        {stage === 'confirmation' && completedOrder && (
          <div className="h-full min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-xl px-6 pt-6">
              <SaleNotSavedNotice state={saleWriter.state} />
            </div>
            <MerchConfirmation
              order={completedOrder}
              newBalance={newBalance}
              onNewOrder={resetOrder}
              receiptNumber={platformSale?.receiptNumber ?? null}
            />
          </div>
        )}
      </div>

      {/* Variant picker for multi-variant merch items */}
      {pendingVariantItem && pendingVariantItem.inventoryItemId && (() => {
        const invItem = getInventoryItem(pendingVariantItem.inventoryItemId!);
        return invItem ? (
          <VariantPickerModal
            open={true}
            itemName={pendingVariantItem.name}
            variants={invItem.variants}
            onPick={handlePickMerchVariant}
            onCancel={() => setPendingVariantItem(null)}
          />
        ) : null;
      })()}
    </div>
  );

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background overflow-hidden">
      {/* Test-harness banner */}
      <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor className="w-4 h-4 shrink-0" />
          <span className="truncate">
            Test harness — staff station (left) + customer display (right) share one live sale. In
            production the customer display runs on a separate device.
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

      <StationHeader active="merch" />

      <div className="flex-1 flex min-h-0">
        <div
          className={`${showCustomerDisplay ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0`}
        >
          {staffStation}
        </div>
        {showCustomerDisplay && (
          <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
            <MerchCustomerDisplay
              stage={customerStage}
              wristband={wristband}
              lines={displayLines}
              manualDiscounts={manualDiscounts}
              total={total}
              taxBreakdown={taxBreakdown}
              promptpayAmount={promptpayAmount}
              completedOrder={completedOrder}
              newBalance={newBalance}
            />
          </div>
        )}
      </div>

      {operator && (
        <ManualDiscountModal
          open={showDiscountModal}
          onOpenChange={setShowDiscountModal}
          subtotal={subtotal}
          lines={lines.map((l) => ({
            id: l.id,
            label: `${l.qty}× ${l.merchItem.name}`,
            amount: l.lineTotal,
          }))}
          reasons={getDiscountReasons()}
          operatorId={operator.id}
          operatorName={operator.name}
          onApply={handleApplyManualDiscount}
        />
      )}
    </div>
  );
}
