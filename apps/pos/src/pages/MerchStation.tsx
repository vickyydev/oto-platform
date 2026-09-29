import { useEffect, useMemo, useRef, useState } from 'react';
import { StationHeader } from '@/components/shared/StationHeader';
import { setSaleOpen } from '@/pwa/openSale';
import { Discount, ManualDiscount, MerchItem, MerchOrder, MerchOrderLine, Wristband } from '@/types';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import { getActiveMerchItems, getDiscountByCode, getDiscountReasons, recordMerchOrder, getInventoryItem } from '@/mockApi';
import { asksForSize, computeMerchLineTotal, isOutOfStock, merchSizes } from '@/lib/merch';
import { readProductScan, useStationScans, type StationScanEvent } from '@/lib/scanChannel';
import { validateItemPromoCode } from '@/lib/itemPromo';
import { useItemCartQuoteWithPromos } from '@/lib/itemPromoQuote';
import { useSaleWriter, type SaleWriteOutcome } from '@/lib/saleWriter';
import { usePaymentStage, type PaymentSettlement } from '@/lib/usePaymentStage';
import { useMerchDisplay } from '@/lib/merchDisplaySession';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { useBranch } from '@/branch/BranchContext';
import { useStation } from '@/station/StationContext';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { getDefaultTier } from '@/store/catalogStore';
import { menuIsServerBacked } from '@/api/menu';
import {
  buildItemCartPayload,
  refusedPromoCodes,
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
import { FnbPayment, fnbPaymentResult } from '@/components/fnb/FnbPayment';
import { PaymentExpiry, PaymentQr } from '@/components/till/PaymentQr';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { MerchConfirmation } from '@/components/merch/MerchConfirmation';
import { MerchCustomerDisplay, MerchCustomerStage } from '@/components/merch/MerchCustomerDisplay';
import { PublicMerchCustomerDisplay } from '@/components/merch/PublicMerchCustomerDisplay';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { useOperator } from '@/auth/OperatorContext';
import { toast } from '@/hooks/use-toast';
import { announceSalePrinting } from '@/lib/printRouting';
import { Button } from '@/components/ui/button';
import { Monitor } from 'lucide-react';

type Stage = 'scan' | 'order' | 'payment' | 'confirmation';

let orderCounter = 1;
let lineCounter = 1;

export default function MerchStation() {
  const { operator, locked, offlineUnlock } = useOperator();
  const staffLocked = useRef(locked);
  staffLocked.current = locked;
  const stationOffline = (): boolean =>
    (typeof navigator !== 'undefined' && navigator.onLine === false) || offlineUnlock !== null;
  const { branch } = useBranch();
  const { station } = useStation();
  const { t } = useLanguage();

  const [stage, setStage] = useState<Stage>('scan');
  const [wristband, setWristband] = useState<Wristband | null>(null);
  const [cart, setCart] = useState<MerchOrderLine[]>([]);
  // Item awaiting a size: one the platform sells in two or more sizes (S2-09b),
  // or — on the ported catalogue — a multi-variant inventory item.
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
  const completedSaleRef = useRef<string | null>(null);
  const paymentSnapshotRef = useRef<{ epoch: number; scope: string; prepare: () => Promise<SaleWriteOutcome>; complete: (sale: ApiSale, settlements: readonly PaymentSettlement[]) => void } | null>(null);
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
    enabled: !locked && stage !== 'confirmation',
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
  const paymentEpoch = saleEpochRef.current;
  const paymentScope = JSON.stringify([paymentEpoch, saleIdentity, lines, manualDiscounts, promoCodes]);
  const paymentScopeRef = useRef({ epoch: paymentEpoch, scope: paymentScope });
  paymentScopeRef.current = { epoch: paymentEpoch, scope: paymentScope };
  const paymentContextCurrent = (): boolean => saleEpochRef.current === paymentEpoch && paymentScopeRef.current.scope === paymentScope;
  const notePaymentLeftBehind = (saleId: string) => {
    if (saleId) toast({ title: 'Check the previous sale in History', description: `The payment answer belongs to sale ${saleId}. This station changed, so no local sale was completed.`, variant: 'destructive' });
  };

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

  // Tap on the merch grid: an item with sizes opens a picker first. The
  // platform's sizes win (S2-09b); the inventory's are the ported catalogue's,
  // for a deployment with no platform menu behind it.
  const handleAdd = (item: MerchItem) => {
    if (isOutOfStock(item)) return;
    if (asksForSize(item)) {
      setPendingVariantItem(item);
      return;
    }
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
    const label = asksForSize(pendingVariantItem)
      ? merchSizes(pendingVariantItem).find((v) => v.id === variantId)?.label
      : getInventoryItem(pendingVariantItem.inventoryItemId!)?.variants.find(
          (v) => v.id === variantId,
        )?.label;
    addToCart(pendingVariantItem, variantId, label);
    setPendingVariantItem(null);
  };

  /**
   * A BARCODE SCANNED AT THIS STATION (S2-09b) — from the scanner on the box,
   * the Console's scanner simulator, or anything else that reaches the box.
   *
   * The box has already decided what the code means (`lib/scanChannel.ts`);
   * this puts it on the sale the way a tap would. A code on one size's tag adds
   * that size — even one this screen's copy of the catalogue does not list yet;
   * the item's own code on an item with sizes asks which one, as the tile does;
   * "Unknown barcode" adds nothing and says so. Scanned before a wristband is
   * chosen, it starts a guest sale — the guest at the counter is holding the
   * thing. During payment it adds nothing: the sale being paid for must not
   * change under the person paying.
   */
  const handleScan = (event: StationScanEvent) => {
    if (staffLocked.current) return;
    const scan = readProductScan(event);
    if (!scan) return;
    if (scan.kind === 'unknown') {
      toast({
        title: scan.message,
        description: 'Nothing was added to the sale.',
        variant: 'destructive',
      });
      return;
    }
    const scannedSize = scan.line.variant;
    // What was scanned, in the words the cart line uses: "Grip Socks (M)".
    const scanned = scannedSize ? `${scan.line.name} (${scannedSize.label})` : scan.line.label;
    if (stage === 'payment' || stage === 'confirmation') {
      toast({
        title: `Scanned ${scanned}`,
        description: 'Finish this sale first — nothing was added.',
        variant: 'destructive',
      });
      return;
    }
    const item = merchItems.find((m) => m.id === scan.line.productId);
    if (!item) {
      toast({
        title: `${scanned} is not on this shop's grid`,
        description: 'Nothing was added. It may be retired, or sold at another branch.',
        variant: 'destructive',
      });
      return;
    }
    if (isOutOfStock(item)) {
      toast({
        title: `${scanned} is out of stock`,
        description: 'Nothing was added to the sale.',
        variant: 'destructive',
      });
      return;
    }
    if (stage === 'scan') loadBand(null);
    if (scannedSize) {
      // The box named the size from the platform's catalogue as it read the
      // tag. This screen's copy can be older than that — a size added since it
      // loaded — so when the grid does not list the size, the line takes the
      // scan's own id and label rather than losing the size. The platform
      // checks the id when it prices the sale, and refuses one the item does
      // not have.
      const listed = merchSizes(item).find((v) => v.id === scannedSize.id);
      addToCart(item, scannedSize.id, listed?.label ?? scannedSize.label);
      return;
    }
    if (asksForSize(item)) setPendingVariantItem(item);
    else addToCart(item);
  };
  useStationScans(locked ? undefined : station?.stationId, handleScan);

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
   * by the engine that will price it (`lib/itemPromo.ts`), over this station's
   * copy of the park's codes. The platform reads the code from the park's own
   * definition (SCRUM-401), so a code the copy still passes — withdrawn since,
   * used up, out of its window, another branch's — can come back refused, and
   * it then comes off the sale with the platform's reason (below).
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

  /**
   * SCRUM-401 — A CODE THE PLATFORM REFUSED COMES OFF THE SALE, as it does at
   * the F&B station and on the ticket till (`pages/Till.tsx`).
   *
   * The platform prices every code from the park's own definition, so a code
   * this station's copy still honours can come back refused on the quote. The
   * panel draws code badges from the platform's figures, which leaves a refused
   * code with no badge and no remove button. Kept, it would be sent with every
   * quote and commit, it would still count in this station's own stacking check
   * (`validateItemPromoCode`), refusing the next code against one nobody can
   * see, and typed again it would be "already applied". So it is taken off as
   * its remove button would take it, and the platform's reason goes on the promo
   * box's refusal line, after the removal has cleared it (`refusedPromoCodes`).
   *
   * Keyed on the quote alone: the platform's answer replaces it only when it is
   * about the sale on screen, codes included, and the removal changes the sale,
   * so each answer is acted on once.
   */
  useEffect(() => {
    const refused = refusedPromoCodes(sale.quote, promoCodes);
    if (refused.length === 0) return;
    for (const { code } of refused) handleRemovePromoCode(code);
    setPromoError(refused.map((rejected) => rejected.reason).join(' '));
    // `promoCodes` is read as it stands with this quote, which was answered for
    // it; `handleRemovePromoCode` is redefined every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.quote]);

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
    completedSaleRef.current = null;
    paymentSnapshotRef.current = null;
    setPlatformSale(null);
    setStage('scan');
    setWristband(null);
    setCart([]);
    setManualDiscounts([]);
    setPromoCodes([]);
    setPromoError('');
    setCompletedOrder(null);
    setNewBalance(null);
    setSoldEpoch((n) => n + 1); // re-read on-hand stock after the sale's decrement
  };

  const handleCheckout = () => {
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
  const recordSaleOnPlatform = async (epoch: number): Promise<SaleWriteOutcome> => {
    if (staffLocked.current) return { ok: false, saleId: saleWriter.committed?.id ?? '', message: 'Unlock this station before saving the sale.', retryable: false };
    if (saleEpochRef.current !== epoch || !paymentContextCurrent()) return { ok: false, saleId: saleWriter.committed?.id ?? '', message: 'This sale or station changed before it could be saved.', retryable: false };
    const payload = commitPayload();
    if (!payload) return { ok: false, saleId: saleWriter.committed?.id ?? '', message: unwritableReason(), retryable: false };
    const outcome = await saleWriter.commit({ cart: payload, finalise: false });
    if (!staffLocked.current && (saleEpochRef.current !== epoch || !paymentContextCurrent()) && outcome.ok && outcome.written) {
      // The station moved on before the answer landed. The sale IS on the
      // platform and nothing on this screen will mention it again, so it is
      // said out loud rather than dropped.
      toast({
        title: 'A sale was saved for the previous guest',
        description: `This station moved on before it could finish. Sale ${outcome.sale.receiptNumber ?? outcome.saleId} is recorded and nothing was printed for it — find it in the sale list.`,
        variant: 'destructive',
      });
    }
    return outcome;
  };

  useEffect(() => {
    if (locked || stage !== 'payment') return;
    void paymentSnapshotRef.current?.prepare();
  }, [stage, locked]);

  /** The local stock/receipt record follows the platform's finalised sale once. */
  const completeSale = (written: ApiSale, settlements: readonly PaymentSettlement[]) => {
    if (staffLocked.current) return;
    if (!paymentContextCurrent() || written.stationId !== saleIdentity?.stationId) { notePaymentLeftBehind(written.id); return; }
    if (!operator || written.status !== 'finalised') return;
    if (completedSaleRef.current === written.id) return;
    completedSaleRef.current = written.id;
    const payment = fnbPaymentResult(settlements);
    setPlatformSale(written);

    const balanceAfter = wristband?.creditBalanceTHB ?? null;

    // The record this till keeps, carrying the figures the guest was shown.
    const record: MerchOrder = {
      id: String(orderCounter++).padStart(4, '0'),
      operatorId: operator.id,
      operatorName: operator.name,
      wristband: wristband ?? undefined,
      lines: displayLines,
      manualDiscounts,
      total: written.totals.grossSatang / 100,
      payment,
      createdAt: new Date().toISOString(),
      status: 'paid',
      refunds: [],
    };
    recordMerchOrder(record); // decrements on-hand stock in the store
    setCompletedOrder(record);
    setNewBalance(balanceAfter);
    setStage('confirmation');
    // S2-11 — the platform printed the shop receipt when it closed the sale;
    // the toast says where. This station never routed a receipt of its own,
    // so a deployment with no print jobs has nothing to stand in for.
    void announceSalePrinting(written.id, () => undefined);
  };

  if (stage === 'payment' && paymentSnapshotRef.current?.epoch !== paymentEpoch) {
    paymentSnapshotRef.current = { epoch: paymentEpoch, scope: paymentScope, prepare: () => recordSaleOnPlatform(paymentEpoch), complete: completeSale };
  }
  const paymentStage = usePaymentStage({
    scope: paymentScope,
    isCurrentScope: (scope) => !staffLocked.current && scope === paymentScopeRef.current.scope && paymentScopeRef.current.epoch === saleEpochRef.current,
    active: stage === 'payment',
    paused: locked,
    totalSatang: Math.round(total * 100),
    prepareSale: () => paymentSnapshotRef.current?.prepare() ?? recordSaleOnPlatform(paymentEpoch),
    finaliseSale: saleWriter.finalise,
    onComplete: (sale, settlements) => paymentSnapshotRef.current?.complete(sale, settlements),
    onLeftBehind: notePaymentLeftBehind,
  });
  const backFromPayment = () => {
    if (!paymentStage.canBack) return;
    saleEpochRef.current += 1;
    paymentSnapshotRef.current = null;
    setStage('order');
  };

  let customerStage: MerchCustomerStage;
  if (stage === 'confirmation') customerStage = 'thankyou';
  else if (stage === 'payment') customerStage = 'payment';
  else if (stage === 'order') customerStage = 'order';
  else customerStage = 'welcome';

  const separateDisplay = useMerchDisplay(station?.stationId ?? null, {
    sessionKey: `${operator?.id ?? ''}:${station?.branchId ?? branch.id}:${station?.stationId ?? ''}:${saleEpochRef.current}`,
    stage: customerStage, online: !stationOffline(),
    excluded: !!wristband || promoCodes.length > 0 || !shopFromPlatform,
    lines, manualDiscounts, quote: sale.quote, pending: sale.pending, quoteFailed: !!sale.error,
    payment: paymentStage.display, completedOrder, platformSale,
  }, !locked && !stationOffline());
  const inlineDisplay = showCustomerDisplay && (!separateDisplay.connected.length || !separateDisplay.supported || !!separateDisplay.error);

  // Preserve the sale hooks across a lock without staff controls or portals.
  if (locked) return null;

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
                WHAT THIS STATION STILL DOES ON ITS OWN. The catalogue, the
                prices and the sizes a tile asks for are the platform's (sizes
                since S2-09b), and so is the receipt printing (S2-11); the
                counts under each tile and the band's balance are not, and each
                names the ticket that moves it.
              */}
              <div className="mb-4 shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-foreground/15 bg-foreground/5 px-4 py-2 text-xs text-muted-foreground">
                <span className="font-bold uppercase tracking-wide text-foreground/70">
                  This till&apos;s own record
                </span>
                <span>Stock counts and out-of-stock — S2-14b</span>
                <span>Wallet credit — S2-14a</span>
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
              stage={paymentStage}
              onBack={backFromPayment}
            />
            <div className="mx-auto w-full max-w-2xl px-6 pb-6">
              {saleWriter.state.kind === 'failed' && <SaleWriteFailure
                state={saleWriter.state}
                onRetry={() => { if (saleWriter.state.kind === 'failed' && saleWriter.state.stage === 'finalise') void paymentStage.retry(); else void paymentSnapshotRef.current?.prepare(); }}
                onDismiss={backFromPayment}
              />}
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

      {/* Size picker for an item sold in sizes (S2-09b) */}
      {pendingVariantItem && asksForSize(pendingVariantItem) && (
        <VariantPickerModal
          open={true}
          itemName={pendingVariantItem.name}
          variants={merchSizes(pendingVariantItem)}
          onPick={handlePickMerchVariant}
          onCancel={() => setPendingVariantItem(null)}
        />
      )}

      {/* Variant picker for multi-variant inventory items (the ported catalogue) */}
      {pendingVariantItem && !asksForSize(pendingVariantItem) && pendingVariantItem.inventoryItemId && (() => {
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
            {separateDisplay.connected.length
              ? `Display connected: ${separateDisplay.connected.map(device => device.name).join(', ')} — ${separateDisplay.supported ? 'guest purchase and payment are shared.' : 'follow the staff screen for this flow.'}`
              : separateDisplay.error ? 'Separate display unavailable — use the inline customer display.'
                : 'Test harness — staff station (left) + customer display (right) share one live sale. In production the customer display runs on a separate device.'}
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

      <div className="shrink-0" inert={stage === 'payment' && !paymentStage.canBack}><StationHeader active="merch" /></div>

      <div className="flex-1 flex min-h-0">
        <div
          className={`${inlineDisplay ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0`}
        >
          {staffStation}
        </div>
        {inlineDisplay && (
          <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
            {separateDisplay.presentation ? <PublicMerchCustomerDisplay
              stage={customerStage} cart={separateDisplay.presentation.cart}
              totals={separateDisplay.presentation.totals} payment={paymentStage.display}
            /> : stage === 'payment' ? (
              <div className="relative h-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col items-center justify-center gap-6 px-10 text-center">
                <div className="absolute top-4 right-4"><LanguageSwitcher variant="dark" /></div>
                <h2 className="text-4xl font-black">{t('merch.payment.amountToPay')}</h2>
                {paymentStage.display.online && paymentStage.display.status === 'pending' && (paymentStage.display.qrPayload || paymentStage.display.qrImageUrl) && (
                  <div className="rounded-3xl bg-white p-6"><PaymentQr payload={paymentStage.display.qrPayload} imageUrl={paymentStage.display.qrImageUrl} className="h-64 w-64" /></div>
                )}
                <div className="text-6xl font-black tabular-nums text-primary">฿{paymentStage.display.amountSatang / 100}</div>
                {paymentStage.display.status === 'pending' && <PaymentExpiry expiresAt={paymentStage.display.expiresAt} />}
                <p className="text-xl text-foreground/60">
                  {!paymentStage.display.online ? t('till.payment.reconnect') : paymentStage.display.offline ? t('till.payment.offlineRecorded') : paymentStage.display.status === 'pending' ? t('merch.payment.waiting') : paymentStage.display.status === 'paid' ? t('till.payment.received') : paymentStage.display.status === 'failed' || paymentStage.display.status === 'blocked' ? t('till.payment.checking') : t('merch.payment.confirmWithStaff')}
                </p>
              </div>
            ) : <MerchCustomerDisplay
              stage={customerStage}
              wristband={wristband}
              lines={displayLines}
              manualDiscounts={manualDiscounts}
              total={total}
              taxBreakdown={taxBreakdown}
              promptpayAmount={null}
              completedOrder={completedOrder}
              newBalance={newBalance}
            />}
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
