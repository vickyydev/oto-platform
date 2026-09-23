import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { StationHeader } from '@/components/shared/StationHeader';
import { FnbOrder, FnbOrderLine, ManualDiscount, MenuItem, Operator, SelectedModifier, Wristband } from '@/types';
import { useStation } from '@/station/StationContext';
import { dispatchPrintJobs, fnbPrintJobs, promptSetupStation } from '@/lib/printRouting';
import { setSaleOpen } from '@/pwa/openSale';
import { takeCorrectedOrder } from '@/lib/correctedOrder';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import {
  chargeFnbCredit,
  redeemPrepaidItem,
  getDiscountReasons,
  recordFnbOrder,
  getInventoryItem,
  previewStaffBenefit,
  commitStaffBenefit,
  attachBenefitAuditOrderId,
} from '@/mockApi';
import { INVENTORY_DEFAULT_VARIANT_ID } from '@/types';
import { VariantPickerModal } from '@/components/shared/VariantPickerModal';
import { computeLineTotal, hasModifiers, modifierSignature } from '@/lib/fnb';
import { useItemCartQuote } from '@/lib/cartQuote';
import { useSaleWriter } from '@/lib/saleWriter';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { useBranch } from '@/branch/BranchContext';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { getDefaultTier } from '@/store/catalogStore';
import { menuIsServerBacked } from '@/api/menu';
import {
  buildItemCartPayload,
  offLedgerOnly,
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
import { dropDiscountsForRemovedLines } from '@/lib/manualDiscount';
import { ScanWristband } from '@/components/fnb/ScanWristband';
import { BenefitScanModal } from '@/components/fnb/BenefitScanModal';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { FnbCart } from '@/components/fnb/FnbCart';
import { FnbPayment, FnbPaymentResult, FnbMethod, FnbRemainder } from '@/components/fnb/FnbPayment';
import { FnbConfirmation } from '@/components/fnb/FnbConfirmation';
import { PickupCodeModal } from '@/components/fnb/PickupCodeModal';
import { ModifierSheet } from '@/components/fnb/ModifierSheet';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { FnbCustomerDisplay, FnbCustomerStage } from '@/components/fnb/FnbCustomerDisplay';
import { FoodConsentModal } from '@/components/fnb/FoodConsentModal';
import { useOperator } from '@/auth/OperatorContext';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Monitor, AlertTriangle, Ban, Gift } from 'lucide-react';

const STAFF_BENEFIT_DISCOUNT_ID = 'staff-benefit';

type Stage = 'scan' | 'order' | 'payment' | 'confirmation';

/**
 * WHICH TENDER CLOSED THE ORDER.
 *
 * The prototype's payment screen splits one order into four buckets and the
 * platform's finalise records ONE tender token, so the bucket that settled the
 * balance is the one named. Credit is last rather than first on purpose: the
 * band's wallet is not money the ledger holds (S2-14a), so where a card or cash
 * finished the order that is the honest name for what was taken; an order paid
 * from the band alone is named as the wallet it came from and the panel beside
 * it says the balance is still this till's own record.
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

let orderCounter = 1;
let lineCounter = 1;

export default function OrderStation() {
  const { operator } = useOperator();
  const { station } = useStation();
  const { branch } = useBranch();
  const [, navigate] = useLocation();
  /**
   * THE MENU IS THE PLATFORM'S — SCRUM-232 landed `GET /branches/:id/menu` and
   * the catalogue store is hydrated from it at sign-in
   * (`api/catalogBridge.loadMenuFromApi`). Read through the store rather than
   * snapshotted at mount, so an item edited in the admin panel and pulled again
   * appears here without the station being reopened.
   *
   * `menuIsServerBacked()` says whether that hydration actually happened; when
   * it did not — a deployment with no menu route — the ported catalogue is what
   * is on screen and the grid says so rather than passing it off as the park's.
   */
  const { menuItems } = useCatalogStore();
  const menuFromPlatform = menuIsServerBacked();

  const [stage, setStage] = useState<Stage>('scan');
  const [wristband, setWristband] = useState<Wristband | null>(null);
  const [cart, setCart] = useState<FnbOrderLine[]>([]);
  const [orderNote, setOrderNote] = useState('');
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<FnbOrder | null>(null);
  const [newBalance, setNewBalance] = useState<number | null>(null);
  /**
   * WRITING THE ORDER — the same writer the till uses (`lib/saleWriter.ts`), so
   * pressing Pay twice produces one sale, a retry is the same sale, and a
   * refusal is shown rather than swallowed. Nothing here re-implements any of
   * that.
   */
  const saleWriter = useSaleWriter();
  /** The sale the platform holds for the order on the confirmation screen. */
  const [platformSale, setPlatformSale] = useState<ApiSale | null>(null);
  /**
   * Bumped whenever this station starts a new order, so an answer for the
   * previous guest cannot land on the one now at the counter — the same guard
   * `saleEpochRef` is in `pages/Till.tsx`.
   */
  const orderEpochRef = useRef(0);

  // Same reason as the till's (S2-06): a new build must not be swapped in
  // under an order somebody is still taking.
  const orderOnScreen = cart.length > 0 || completedOrder !== null;
  useEffect(() => {
    setSaleOpen('order-station', orderOnScreen);
    return () => setSaleOpen('order-station', false);
  }, [orderOnScreen]);
  const [pickupCode, setPickupCode] = useState('');
  const [showPickupModal, setShowPickupModal] = useState(false);
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [customerTheme] = useCustomerTheme();
  const [payMethod, setPayMethod] = useState<FnbMethod | null>(null);
  const [payRemainder, setPayRemainder] = useState<FnbRemainder>('card');

  // Staff benefit (Task #231): a scanned operator's QR applies their comp/
  // free-items/credit/standing-discount to the current cart, ONLY here at the
  // F&B order station. The preview folds into `manualDiscounts` as a single
  // synthetic entry so it flows through the existing totals/receipt seam.
  const [showBenefitScan, setShowBenefitScan] = useState(false);
  const [benefitOperator, setBenefitOperator] = useState<Operator | null>(null);

  // Modifier selection sheet. lineId is set when editing an existing cart line.
  const [sheetItem, setSheetItem] = useState<MenuItem | null>(null);
  const [sheetMode, setSheetMode] = useState<'add' | 'edit'>('add');
  const [sheetLineId, setSheetLineId] = useState<string | null>(null);

  // Food consent: when the band's child is not authorized to order food
  // (mayOrderFood:false), adding is blocked until staff record an explicit
  // override (stamped on the finalized order). pendingItem is held over the modal.
  const [showFoodConsent, setShowFoodConsent] = useState(false);
  const [pendingItem, setPendingItem] = useState<MenuItem | null>(null);
  const [foodOverride, setFoodOverride] = useState<FnbOrder['foodConsentOverride'] | null>(null);

  // Variant (size/flavour) picker for stock-tracked F&B items with >1 variant
  // (e.g. Slushie Red/Blue/Green). variantItem holds the item awaiting a pick;
  // pendingVariant carries the choice through the modifier sheet into the cart.
  const [variantItem, setVariantItem] = useState<MenuItem | null>(null);
  const [pendingVariant, setPendingVariant] = useState<
    { variantId: string; variantLabel: string } | null
  >(null);

  const lines = cart;

  // Consume a "start corrected order" handoff from the History screen (after a
  // refund). Preloads the wristband + cart (with fresh line ids) and drops staff
  // at the order stage to rebuild and re-charge. Runs once on mount.
  useEffect(() => {
    const correction = takeCorrectedOrder();
    if (!correction || correction.kind !== 'fnb') return;
    setWristband(correction.wristband ?? null);
    setCart(correction.lines.map((l) => ({ ...l, id: `line-${lineCounter++}` })));
    setStage('order');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live preview of the scanned staff benefit against the current cart — a
  // pure recompute each time lines change, so quota/credit-remaining stays
  // accurate as the order is built (nothing is committed until payment).
  const benefitPreview = useMemo(
    () => (benefitOperator ? previewStaffBenefit(benefitOperator, lines) : null),
    [benefitOperator, lines]
  );

  // Fold the benefit preview into ONE synthetic order-scope ManualDiscount so
  // it flows through the existing totals/receipt/cart seam untouched — comp
  // becomes a 'comp' discount, everything else a 'fixed' ฿ discount for the
  // combined relief (free items + credit + standing %).
  const benefitDiscount: ManualDiscount | null = useMemo(() => {
    if (!benefitOperator || !benefitPreview || benefitPreview.totalReliefTHB <= 0) return null;
    const isComp = benefitPreview.compedTHB > 0;
    return {
      id: STAFF_BENEFIT_DISCOUNT_ID,
      scope: 'order',
      type: isComp ? 'comp' : 'fixed',
      value: isComp ? 0 : benefitPreview.totalReliefTHB,
      reason: 'Staff benefit',
      note: `Scanned: ${benefitOperator.name} (${benefitOperator.benefitRole ?? 'staff'})`,
      amountTHB: benefitPreview.totalReliefTHB,
      appliedBy: operator?.name ?? benefitOperator.name,
      appliedById: operator?.id ?? benefitOperator.id,
      appliedAt: new Date().toISOString(),
    };
  }, [benefitOperator, benefitPreview, operator]);

  const effectiveManualDiscounts = useMemo(
    () => (benefitDiscount ? [...manualDiscounts, benefitDiscount] : manualDiscounts),
    [manualDiscounts, benefitDiscount]
  );

  /**
   * WHO THIS ORDER BELONGS TO, in the platform's own ids — S2-09b.
   *
   * Null when this deployment has no platform station or no platform branch for
   * the one on screen. The order is then priced on this till and said to be, and
   * the confirmation says plainly that nothing was written to the ledger.
   */
  const orderIdentity: ItemCartIdentity | null = useMemo(() => {
    const branchId = apiBranchIdForSlug(branch.id);
    if (!branchId || !station?.stationId || !operator) return null;
    return {
      branchId,
      stationId: station.stationId,
      // An F&B item is priced from its catalogue row, not from a tier table;
      // the field is the ticket cart's and the platform ignores it here.
      tier: getDefaultTier()?.id ?? 'tourist',
      channel: 'fnb',
      pickupCode: pickupCode || null,
      memberId: null,
      customerPhone: null,
      customerNickname: null,
      accountId: operator.id,
      accountName: operator.name,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch.id, station?.stationId, operator, pickupCode]);

  /**
   * THE PRICE THE PLATFORM QUOTES FOR THIS ORDER. Every figure the order panel,
   * the customer display and the payment screen show comes from here. The
   * prototype totalled the order in the browser (`computeFnbTotals`); that
   * arithmetic is now only the fallback, and when it is what is on screen
   * `PriceSourceNote` says so beside the total.
   *
   * Switched off once the order is confirmed: the sale's own figures stand from
   * then on, and re-quoting a finished order could only disagree with the
   * receipt in the guest's hand.
   */
  const order = useItemCartQuote({
    kind: 'fnb',
    lines,
    manualDiscounts: effectiveManualDiscounts,
    identity: orderIdentity,
    enabled: stage !== 'confirmation',
  });
  const { subtotal, total, manualAmounts, taxBreakdown } = order.totals;

  /**
   * THE PLATFORM LOOKED AT THIS ORDER AND OBJECTED — SCRUM-342, told apart by
   * kind since SCRUM-351.
   *
   * While a refusal stands the charge button is off. The rule that refused the
   * quote is the rule the commit meets, so the press could only carry the guest
   * to the payment screen and fail there; the refusal was advisory and the money
   * never moved. It clears the moment a later quote answers — the question
   * answered, the line taken off — and the button comes back with it.
   *
   * A FAULT IS NOT THAT, and this station used to have to recognise one by its
   * message text. The hook now says which it got (`lib/cartQuote.ts`): the api
   * breaking, or a proxy answering in its place. Neither is a judgement on this
   * order, so the button stays on and the station sells through the outage on
   * this till's own figures — `QuoteFaultNote` says the platform failed and
   * `PriceSourceNote` says whose figure is on the screen.
   *
   * An order the platform was never asked about is a third thing and reaches
   * neither note: `quoteItemCart` answers that one with this till's figures and
   * a reason rather than rejecting (`api/sales.ts`), so `order.error` is null
   * and only the source note is drawn.
   */
  const quoteError = order.error;
  const quoteRefusal = quoteError && quoteError.kind === 'refusal' ? quoteError : null;
  const quoteFault = quoteError && quoteError.kind === 'fault' ? quoteError : null;

  /**
   * The rows as the panel draws them: the platform's figure against each line
   * where it has quoted one, the till's where it has not.
   *
   * The cart itself is never rewritten with a quoted figure — `cart` stays the
   * record of what staff put in it, and this is the view of it. Rewriting the
   * cart would make the next quote reconcile against the previous quote's
   * answer instead of against what was ordered.
   */
  const displayLines = useMemo(() => {
    const quoted = order.quote.lineTotals;
    if (!quoted) return lines;
    return lines.map((line) =>
      quoted[line.id] === undefined ? line : { ...line, lineTotal: quoted[line.id] },
    );
  }, [lines, order.quote.lineTotals]);

  // Total qty per menu item across all lines — drives the badge in the grid.
  const quantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of cart) map[line.menuItem.id] = (map[line.menuItem.id] ?? 0) + line.qty;
    return map;
  }, [cart]);

  const makeLine = (
    item: MenuItem,
    selected: SelectedModifier[],
    qty: number,
    note?: string,
    variant?: { variantId: string; variantLabel: string } | null,
  ): FnbOrderLine => ({
    id: `line-${lineCounter++}`,
    menuItem: item,
    qty,
    selectedModifiers: selected,
    lineTotal: computeLineTotal(item, selected, qty),
    note,
    ...(variant
      ? { variantId: variant.variantId, variantLabel: variant.variantLabel }
      : {}),
  });

  // Available stock for a (stock-tracked) item's chosen variant, or null when the
  // item isn't tracked. Single-variant items have no variantId on the line, so
  // they resolve against the Default variant — same as recordFnbOrder's decrement.
  const variantStockCap = (item: MenuItem, variantId?: string): number | null => {
    if (!item.inventoryItemId) return null;
    const inv = getInventoryItem(item.inventoryItemId);
    if (!inv) return null;
    const v = inv.variants.find((x) => x.id === (variantId ?? INVENTORY_DEFAULT_VARIANT_ID));
    return v ? v.stock : null;
  };

  // --- Prepaid item redemption -------------------------------------------
  // How many units of a given menuItemId are already sitting in the cart as
  // pending prepaid lines (not yet committed). Used to block over-redemption.
  const pendingPrepaidQty = (menuItemId: string): number =>
    cart.filter((l) => l.isPrepaid && l.menuItem.id === menuItemId).reduce((s, l) => s + l.qty, 0);

  const handleRedeemPrepaidItem = (entitlement: { menuItemId: string; qty: number; redeemedQty: number }) => {
    const remaining = entitlement.qty - entitlement.redeemedQty - pendingPrepaidQty(entitlement.menuItemId);
    if (remaining <= 0) return;
    const menuItem = menuItems.find((m) => m.id === entitlement.menuItemId);
    if (!menuItem) return;
    // Zero-charge line — already paid at booking. Does NOT merge with paid lines.
    const line: FnbOrderLine = {
      id: `line-${lineCounter++}`,
      menuItem,
      qty: 1,
      selectedModifiers: [],
      lineTotal: 0,
      isPrepaid: true,
    };
    setCart((prev) => [...prev, line]);
  };

  const addOrMerge = (
    item: MenuItem,
    selected: SelectedModifier[],
    qty: number,
    note?: string,
    variant?: { variantId: string; variantLabel: string } | null,
  ) => {
    const sig = modifierSignature(selected);
    const variantId = variant?.variantId;
    setCart((prev) => {
      // Clamp against the chosen variant's stock, counting everything already in
      // the cart for the same item+variant so split lines can't oversell as a set.
      const cap = variantStockCap(item, variantId);
      let addQty = qty;
      if (cap !== null) {
        const committed = prev
          .filter(
            (l) =>
              l.menuItem.id === item.id && (l.variantId ?? '') === (variantId ?? ''),
          )
          .reduce((s, l) => s + l.qty, 0);
        addQty = Math.min(qty, Math.max(0, cap - committed));
        if (addQty <= 0) return prev;
      }
      // Only merge into a twin with the SAME note + variant — distinct notes or
      // sizes stay separate lines so each reaches the kitchen/bar as its own line.
      const idx = prev.findIndex(
        (l) =>
          l.menuItem.id === item.id &&
          modifierSignature(l.selectedModifiers) === sig &&
          (l.note ?? '') === (note ?? '') &&
          (l.variantId ?? '') === (variantId ?? '')
      );
      if (idx >= 0) {
        const next = [...prev];
        const merged = next[idx];
        const newQty = merged.qty + addQty;
        next[idx] = { ...merged, qty: newQty, lineTotal: computeLineTotal(item, selected, newQty) };
        return next;
      }
      return [...prev, makeLine(item, selected, addQty, note, variant)];
    });
  };

  // After any variant choice (or none), branch to the modifier sheet or add
  // straight to the cart, carrying the chosen variant through.
  const continueAdd = (
    item: MenuItem,
    variant: { variantId: string; variantLabel: string } | null,
  ) => {
    if (hasModifiers(item)) {
      setPendingVariant(variant);
      setSheetItem(item);
      setSheetMode('add');
      setSheetLineId(null);
      return;
    }
    addOrMerge(item, [], 1, undefined, variant);
  };

  const proceedAdd = (item: MenuItem) => {
    const inv = item.inventoryItemId ? getInventoryItem(item.inventoryItemId) : undefined;
    // Multi-variant stocked item → ask staff which size/flavour first.
    if (inv && inv.variants.length > 1) {
      setVariantItem(item);
      return;
    }
    // Single-variant or untracked → no variant label needed (decrement falls back
    // to the Default variant in recordFnbOrder).
    continueAdd(item, null);
  };

  const handlePickVariant = (variantId: string) => {
    const item = variantItem;
    setVariantItem(null);
    if (!item || !item.inventoryItemId) return;
    const inv = getInventoryItem(item.inventoryItemId);
    const v = inv?.variants.find((x) => x.id === variantId);
    continueAdd(item, v ? { variantId: v.id, variantLabel: v.label } : null);
  };

  const handleAdd = (item: MenuItem) => {
    // Block adds entirely until staff record a food-consent override for a band
    // whose child the parent did not authorize to order food.
    if (wristband?.mayOrderFood === false && !foodOverride) {
      setPendingItem(item);
      setShowFoodConsent(true);
      return;
    }
    proceedAdd(item);
  };

  const handleFoodOverride = () => {
    if (!operator) return;
    setFoodOverride({
      byId: operator.id,
      byName: operator.name,
      at: new Date().toISOString(),
    });
    setShowFoodConsent(false);
    const item = pendingItem;
    setPendingItem(null);
    if (item) proceedAdd(item);
  };

  const handleEditLine = (line: FnbOrderLine) => {
    // Every line opens the edit sheet — even no-modifier items — so staff can add
    // or change a free-text note (qty is still also editable inline via the stepper).
    setSheetItem(line.menuItem);
    setSheetMode('edit');
    setSheetLineId(line.id);
  };

  const handleSheetSave = (selected: SelectedModifier[], qty: number, note?: string) => {
    const item = sheetItem;
    if (!item) return;
    if (sheetMode === 'edit' && sheetLineId) {
      const editedId = sheetLineId;
      const sig = modifierSignature(selected);
      setCart((prev) => {
        // If the edited configuration now matches another existing line (same
        // item + modifiers + note), merge their quantities so identical items
        // stay collapsed. Differing notes keep the lines separate.
        const twinIdx = prev.findIndex(
          (l) =>
            l.id !== editedId &&
            l.menuItem.id === item.id &&
            modifierSignature(l.selectedModifiers) === sig &&
            (l.note ?? '') === (note ?? '')
        );
        if (twinIdx >= 0) {
          const edited = prev.find((l) => l.id === editedId);
          const addQty = edited?.qty ?? qty;
          const next = prev
            .filter((l) => l.id !== editedId)
            .map((l) => {
              if (l.id !== prev[twinIdx].id) return l;
              const newQty = l.qty + addQty;
              return { ...l, qty: newQty, lineTotal: computeLineTotal(item, selected, newQty) };
            });
          // The edited line merged into its twin and no longer exists — drop
          // any manual discount that targeted it.
          setManualDiscounts((mds) => dropDiscountsForRemovedLines(mds, next.map((l) => l.id)));
          return next;
        }
        return prev.map((l) =>
          l.id === editedId
            ? {
                ...l,
                selectedModifiers: selected,
                qty,
                lineTotal: computeLineTotal(item, selected, qty),
                note,
              }
            : l
        );
      });
    } else {
      addOrMerge(item, selected, qty, note, pendingVariant ?? undefined);
    }
    closeSheet();
  };

  const closeSheet = () => {
    setSheetItem(null);
    setSheetLineId(null);
    setPendingVariant(null);
  };

  const handleChangeQty = (lineId: string, qty: number) => {
    if (qty <= 0) {
      // Line is being removed — drop any manual discount that targeted it.
      setManualDiscounts((prev) => prev.filter((md) => md.targetLineId !== lineId));
    }
    setCart((prev) => {
      if (qty <= 0) return prev.filter((l) => l.id !== lineId);
      return prev.map((l) => {
        if (l.id !== lineId) return l;
        // Clamp the new qty to the variant's stock, less what other lines of the
        // same item+variant already hold, so the stepper can't oversell.
        let nextQty = qty;
        const cap = variantStockCap(l.menuItem, l.variantId);
        if (cap !== null) {
          const others = prev
            .filter(
              (o) =>
                o.id !== lineId &&
                o.menuItem.id === l.menuItem.id &&
                (o.variantId ?? '') === (l.variantId ?? ''),
            )
            .reduce((s, o) => s + o.qty, 0);
          nextQty = Math.min(nextQty, Math.max(1, cap - others));
        }
        return {
          ...l,
          qty: nextQty,
          lineTotal: computeLineTotal(l.menuItem, l.selectedModifiers, nextQty),
        };
      });
    });
  };

  const handleApplyManualDiscount = (md: ManualDiscount) => {
    setManualDiscounts((prev) => [...prev, md]);
  };

  const handleRemoveManualDiscount = (id: string) => {
    // The staff-benefit row isn't stored in `manualDiscounts` — it's derived
    // live from `benefitOperator` — so removing it means un-scanning instead.
    if (id === STAFF_BENEFIT_DISCOUNT_ID) {
      setBenefitOperator(null);
      return;
    }
    setManualDiscounts((prev) => prev.filter((md) => md.id !== id));
  };

  const handleClearCart = () => {
    setCart([]);
    setOrderNote('');
    setManualDiscounts([]);
    setBenefitOperator(null);
    setShowBenefitScan(false);
  };

  // Any allergy/medical flag is surfaced as a persistent red banner on the order
  // stage (not a blocking modal), so scans always go straight to the order stage.
  const loadBand = (wb: Wristband | null) => {
    setWristband(wb);
    setStage('order');
  };

  const resetOrder = () => {
    // A new order takes new sale ids, and any answer still in flight for the
    // previous one is ignored rather than drawn onto this guest.
    orderEpochRef.current += 1;
    saleWriter.reset();
    setPlatformSale(null);
    setStage('scan');
    setWristband(null);
    setCart([]);
    setOrderNote('');
    setManualDiscounts([]);
    setBenefitOperator(null);
    setShowBenefitScan(false);
    setCompletedOrder(null);
    setNewBalance(null);
    setPickupCode('');
    setShowPickupModal(false);
    setPayMethod(null);
    setPayRemainder('card');
    setShowFoodConsent(false);
    setPendingItem(null);
    setFoodOverride(null);
    setVariantItem(null);
    closeSheet();
  };

  const handlePickupConfirm = (code: string) => {
    setPickupCode(code);
    setShowPickupModal(false);
    const balance = wristband?.creditBalanceTHB ?? 0;
    setPayMethod(balance > 0 ? 'credit' : null);
    setPayRemainder('card');
    setStage('payment');
  };

  /**
   * The order as the platform receives it, or null when there is nowhere to
   * send it — no platform station or branch for this device.
   *
   * Built from `displayLines`, which is what the panel and the customer display
   * have on them: the figures reconciled by the platform are the figures the
   * guest was shown.
   */
  const commitPayload = (): SaleCartPayload | null => {
    if (!orderIdentity || offLedgerOnly(lines)) return null;
    return buildItemCartPayload(displayLines, effectiveManualDiscounts, orderIdentity, total, {
      mode: order.quote.pricingMode,
      modeReason: order.quote.pricingModeReason,
    });
  };

  /** Why this order cannot be offered to the ledger at all. */
  const unwritableReason = (): string =>
    !orderIdentity
      ? 'This device is not on a platform station, so there is nowhere to write the order.'
      : (offLedgerOnly(lines) ??
        order.quote.reason ??
        'The platform could not price this order.');

  /**
   * ENTERING THE PAYMENT SCREEN IS THE PAY PRESS — the same seam the till has
   * (S2-09a). The order is written in `tendering`, with no receipt number,
   * because no money has arrived yet; confirming the money finalises it and
   * that is what allocates the number.
   */
  const recordOrderOnPlatform = async (epoch: number): Promise<void> => {
    const payload = commitPayload();
    if (!payload) return; // said on the confirmation screen, not in a toast at the guest
    const outcome = await saleWriter.commit({ cart: payload, finalise: total === 0 });
    if (orderEpochRef.current !== epoch && outcome.ok && outcome.written) {
      // This station moved on before the answer landed. The order IS on the
      // platform and nothing on this screen will ever mention it again, so it
      // is said out loud rather than dropped — the same thing the till does
      // when a sale finishes after Cancel (`noteSaleLeftBehind`).
      toast({
        title: 'An order was saved for the previous guest',
        description: `This station moved on before it could finish. Order ${outcome.sale.receiptNumber ?? outcome.saleId} is recorded and nothing was printed for it — find it in the sale list.`,
        variant: 'destructive',
      });
    }
  };

  useEffect(() => {
    if (stage !== 'payment') return;
    void recordOrderOnPlatform(orderEpochRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const handleConfirmPayment = (payment: FnbPaymentResult) => {
    void completeOrder(payment);
  };

  /**
   * The money arrived: close the order on the platform, then do everything a
   * finished order does on this till.
   *
   * The commit is asserted again first — it costs no round trip when the order
   * on screen is the one already recorded, and it is what records a corrected
   * order instead of finalising the old one.
   */
  const completeOrder = async (payment: FnbPaymentResult) => {
    if (!operator) return;
    // Can't print the receipt/pick-up ticket until this iPad is set up.
    if (!station) {
      promptSetupStation(navigate);
      return;
    }

    const epoch = orderEpochRef.current;
    const payload = commitPayload();
    let written: ApiSale | null = null;
    if (!payload) {
      saleWriter.declareUnwritten(unwritableReason());
    } else {
      const committed = await saleWriter.commit({ cart: payload, finalise: total === 0 });
      if (orderEpochRef.current !== epoch) return;
      if (!committed.ok) return; // the failure panel is showing; nothing is finalised
      if (committed.written) {
        written = committed.sale;
        if (written.status !== 'finalised') {
          /**
           * THE TENDER. The prototype's payment screen splits the amount into
           * credit, cash, card and QR buckets; the platform records the one
           * that settles the balance. Wallet credit is not a tender the ledger
           * can take yet (S2-14a), so an order paid from a band's balance is
           * closed as the remainder's method with the credit named on it —
           * which is what the panel beside it says in as many words.
           */
          const closed = await saleWriter.finalise({
            method: tenderMethodOf(payment),
            kind: tenderKindOf(payment),
            amountSatang: written.totals.grossSatang,
            tenderedSatang: written.totals.grossSatang,
            changeSatang: 0,
          });
          if (orderEpochRef.current !== epoch) return;
          if (!closed.ok) return;
          if (closed.written) written = closed.sale;
        }
      }
    }
    setPlatformSale(written);

    let balanceAfter: number | null = null;
    if (wristband && payment.creditUsed > 0) {
      balanceAfter = chargeFnbCredit(wristband.id, payment.creditUsed, operator?.name);
    } else if (wristband) {
      balanceAfter = wristband.creditBalanceTHB;
    }

    // Commit prepaid item redemptions — mirror chargeFnbCredit but for entitlements.
    if (wristband) {
      for (const line of lines.filter((l) => l.isPrepaid)) {
        redeemPrepaidItem(wristband.id, line.menuItem.id, line.qty);
      }
    }

    // Commit the staff benefit LAST, right before the order is finalized —
    // this is the one place usage/credit is actually consumed and audited
    // (the preview above never touches usage counters).
    let staffBenefit: FnbOrder['staffBenefit'];
    let committedDiscounts = manualDiscounts;
    if (benefitOperator) {
      const committed = commitStaffBenefit(benefitOperator, operator, lines);
      if (committed && benefitDiscount) {
        committedDiscounts = [...manualDiscounts, { ...benefitDiscount, amountTHB: committed.result.totalReliefTHB }];
        staffBenefit = {
          auditId: committed.auditId,
          scannedOperatorId: benefitOperator.id,
          scannedOperatorName: benefitOperator.name,
          isComp: committed.result.compedTHB > 0,
          compedTHB: committed.result.compedTHB,
          freeItemsTHB: committed.result.freeItemsTHB,
          creditTHB: committed.result.creditTHB,
          discountTHB: committed.result.discountTHB,
          totalReliefTHB: committed.result.totalReliefTHB,
        };
      }
    }

    /**
     * The record this till keeps, which History, Today and the reprint path
     * still read (S2-11 moves them onto the API). Its rows and its total are
     * the ones the guest was shown — the platform's, where the platform
     * priced the order — rather than a second arithmetic that happens to
     * agree.
     */
    const record: FnbOrder = {
      id: String(orderCounter++).padStart(4, '0'),
      operatorId: operator.id,
      operatorName: operator.name,
      wristband: wristband ?? undefined,
      lines: displayLines,
      manualDiscounts: committedDiscounts,
      total,
      pickupCode,
      orderNote: orderNote.trim() || undefined,
      payment,
      createdAt: new Date().toISOString(),
      status: 'paid',
      refunds: [],
      foodConsentOverride: foodOverride ?? undefined,
      staffBenefit,
    };
    recordFnbOrder(record);
    if (staffBenefit) attachBenefitAuditOrderId(staffBenefit.auditId, record.id);
    setCompletedOrder(record);
    setNewBalance(balanceAfter);
    setStage('confirmation');
    dispatchPrintJobs(fnbPrintJobs(station, record));
  };

  let customerStage: FnbCustomerStage;
  if (stage === 'confirmation') customerStage = 'thankyou';
  else if (stage === 'payment') customerStage = 'payment';
  else if (stage === 'order') customerStage = 'order';
  else customerStage = 'welcome';

  // The amount the customer must pay by Thai QR / PromptPay (full order, or the
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
      {/* Body */}
      <div className="flex-1 min-h-0">
        {stage === 'scan' && (
          <ScanWristband
            onLoadTab={(wb) => loadBand(wb)}
            onGuest={() => loadBand(null)}
          />
        )}

        {stage === 'order' && (
          <div className="flex h-full min-h-0">
            <div className="flex-1 min-w-0 flex flex-col p-6 border-r bg-card/20">
              {/* Staff-only safety banners — persist for the whole session. Never
                  rendered on the customer display. */}
              {wristband?.allergiesMedical && (
                <div className="mb-4 shrink-0 rounded-xl border border-red-500/50 bg-red-500/15 px-4 py-3 text-red-200">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
                    <div className="min-w-0">
                      <div className="text-sm font-bold uppercase tracking-wide text-red-300">
                        Allergy / medical alert
                        {wristband.holderName ? ` · ${wristband.holderName}` : ''}
                      </div>
                      <div className="font-semibold">{wristband.allergiesMedical}</div>
                      {wristband.foodRestrictions && (
                        <div className="text-sm text-red-200/80">
                          Restriction: {wristband.foodRestrictions}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {wristband?.mayOrderFood === false && (
                <div className="mb-4 shrink-0 rounded-xl border border-amber-500/50 bg-amber-500/15 px-4 py-3 text-amber-200">
                  <div className="flex items-start gap-2.5">
                    <Ban className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                    <div className="min-w-0">
                      <div className="text-sm font-bold uppercase tracking-wide text-amber-300">
                        Food not authorized
                      </div>
                      <div className="text-sm">
                        {foodOverride
                          ? `Overridden by ${foodOverride.byName} — orders allowed.`
                          : 'Parent did not authorize food orders for this child.'}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {/* Prepaid item entitlements — staff only, never on customer display */}
              {wristband?.foodProvision?.mode === 'prepaid_items' && wristband.foodProvision.items && wristband.foodProvision.items.length > 0 && (
                <div className="mb-4 shrink-0 rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Gift className="w-4 h-4 text-violet-400 shrink-0" />
                    <span className="text-xs font-bold uppercase tracking-wide text-violet-300">
                      Prepaid entitlements · {wristband.holderName ?? wristband.customerNickname}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {wristband.foodProvision.items.map((ent) => {
                      const alreadyPending = pendingPrepaidQty(ent.menuItemId);
                      const remaining = ent.qty - ent.redeemedQty - alreadyPending;
                      const fullyUsed = remaining <= 0;
                      return (
                        <button
                          key={ent.menuItemId}
                          type="button"
                          disabled={fullyUsed}
                          onClick={() => handleRedeemPrepaidItem(ent)}
                          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all
                            ${fullyUsed
                              ? 'cursor-not-allowed border-violet-500/20 text-violet-500/40 bg-violet-500/5'
                              : 'border-violet-500/50 text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 active:scale-[0.97]'
                            }`}
                        >
                          <Gift className="w-3.5 h-3.5 shrink-0" />
                          <span>{ent.menuItemName}</span>
                          <span className={`tabular-nums text-xs ${fullyUsed ? 'text-violet-500/40' : 'text-violet-400'}`}>
                            {fullyUsed ? 'Served' : `${remaining} left`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Prepaid credit info — shown when band carries child-tagged F&B credit */}
              {wristband?.foodProvision?.mode === 'prepaid_credit' && (
                <div className="mb-4 shrink-0 rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Gift className="w-4 h-4 text-violet-400 shrink-0" />
                    <div className="min-w-0">
                      <span className="text-xs font-bold uppercase tracking-wide text-violet-300">
                        Prepaid credit · {wristband.holderName ?? wristband.customerNickname}
                      </span>
                      <div className="text-sm text-violet-200/80 mt-0.5">
                        ฿{wristband.creditBalanceTHB} remaining — spends like credit at checkout.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/*
                WHAT THIS STATION STILL DOES ON ITS OWN. The menu, the prices
                and the order are the platform's from here on; three things on
                this screen are not, and each names the ticket that moves it
                rather than looking like part of the ledger.
              */}
              <div className="mb-4 shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-foreground/15 bg-foreground/5 px-4 py-2 text-xs text-muted-foreground">
                <span className="font-bold uppercase tracking-wide text-foreground/70">
                  This till&apos;s own record
                </span>
                <span>Stock counts and out-of-stock — S2-14b</span>
                <span>Wallet credit and prepaid items — S2-14a</span>
                <span>Kitchen, bar and receipt printing — S2-11</span>
                {!menuFromPlatform && (
                  <span className="text-amber-300">
                    Menu — this deployment has no menu route, so the ported catalogue is shown
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-0">
                <MenuGrid items={menuItems} quantities={quantities} onAdd={handleAdd} />
              </div>
            </div>
            <div className="w-[380px] shrink-0 bg-sidebar p-6">
              <FnbCart
                wristband={wristband}
                lines={displayLines}
                total={total}
                priceNote={
                  lines.length > 0 ? (
                    <div className="space-y-2">
                      <QuoteRefusalNote error={quoteRefusal} blocking />
                      <QuoteFaultNote error={quoteFault} />
                      <PriceSourceNote quote={order.quote} pending={order.pending} />
                    </div>
                  ) : null
                }
                chargeBlockedReason={quoteRefusal?.message ?? null}
                manualDiscounts={effectiveManualDiscounts}
                manualAmounts={manualAmounts}
                taxBreakdown={taxBreakdown}
                benefitBreakdown={
                  benefitOperator && benefitPreview && benefitPreview.totalReliefTHB > 0
                    ? {
                        scannedOperatorName: benefitOperator.name,
                        compedTHB: benefitPreview.compedTHB,
                        freeItemsTHB: benefitPreview.freeItemsTHB,
                        creditTHB: benefitPreview.creditTHB,
                        discountTHB: benefitPreview.discountTHB,
                        totalReliefTHB: benefitPreview.totalReliefTHB,
                      }
                    : null
                }
                onChangeQty={handleChangeQty}
                onEditLine={handleEditLine}
                onClear={handleClearCart}
                onCheckout={() => setShowPickupModal(true)}
                onSwitchTab={resetOrder}
                onAddManualDiscount={() => setShowDiscountModal(true)}
                onRemoveManualDiscount={handleRemoveManualDiscount}
                onScanStaffBenefit={() => setShowBenefitScan(true)}
              />
            </div>
          </div>
        )}

        {stage === 'payment' && (
          <div className="h-full min-h-0 overflow-y-auto">
            <FnbPayment
              total={total}
              wristband={wristband}
              pickupCode={pickupCode}
              method={payMethod}
              remainder={payRemainder}
              onMethodChange={setPayMethod}
              onRemainderChange={setPayRemainder}
              onConfirm={handleConfirmPayment}
              onBack={() => setStage('order')}
            />
            {/*
              What the platform has done with this order, in the same panels the
              till uses: saving, recorded-and-unpaid, or a refusal with what to
              press. Nothing is drawn while there is nothing to say.
            */}
            <div className="mx-auto w-full max-w-2xl px-6 pb-6">
              <SaleWriteFailure
                state={saleWriter.state}
                onRetry={() => void recordOrderOnPlatform(orderEpochRef.current)}
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
            <FnbConfirmation
              order={completedOrder}
              newBalance={newBalance}
              onNewOrder={resetOrder}
              receiptNumber={platformSale?.receiptNumber ?? null}
              flowLayout
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background overflow-hidden">
      {/* Test-harness banner */}
      <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor className="w-4 h-4 shrink-0" />
          <span className="truncate">
            Test harness — staff station (left) + customer display (right) share one live order. In
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

      <StationHeader active="fnb" />

      <div className="flex-1 flex min-h-0">
        <div className={`${showCustomerDisplay ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0`}>
          {staffStation}
        </div>
        {showCustomerDisplay && (
          <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
            <FnbCustomerDisplay
              stage={customerStage}
              wristband={wristband}
              lines={displayLines}
              orderNote={orderNote}
              manualDiscounts={effectiveManualDiscounts}
              total={total}
              taxBreakdown={taxBreakdown}
              promptpayAmount={promptpayAmount}
              completedOrder={completedOrder}
              newBalance={newBalance}
            />
          </div>
        )}
      </div>

      <PickupCodeModal
        open={showPickupModal}
        total={total}
        initialCode={pickupCode}
        onOpenChange={setShowPickupModal}
        onConfirm={handlePickupConfirm}
      />

      <BenefitScanModal
        open={showBenefitScan}
        onOpenChange={setShowBenefitScan}
        onScanned={(op) => setBenefitOperator(op)}
      />

      {operator && (
        <ManualDiscountModal
          open={showDiscountModal}
          onOpenChange={setShowDiscountModal}
          subtotal={subtotal}
          lines={lines.map((l) => ({
            id: l.id,
            label: `${l.qty}× ${l.menuItem.name}`,
            amount: l.lineTotal,
          }))}
          reasons={getDiscountReasons()}
          operatorId={operator.id}
          operatorName={operator.name}
          onApply={handleApplyManualDiscount}
        />
      )}

      <ModifierSheet
        open={sheetItem !== null}
        item={sheetItem}
        mode={sheetMode}
        initialSelections={
          sheetLineId ? cart.find((l) => l.id === sheetLineId)?.selectedModifiers : undefined
        }
        initialQty={sheetLineId ? cart.find((l) => l.id === sheetLineId)?.qty : 1}
        initialNote={sheetLineId ? cart.find((l) => l.id === sheetLineId)?.note : undefined}
        onClose={closeSheet}
        onSave={handleSheetSave}
      />

      <VariantPickerModal
        open={variantItem !== null}
        itemName={variantItem?.name ?? ''}
        variants={
          variantItem?.inventoryItemId
            ? getInventoryItem(variantItem.inventoryItemId)?.variants ?? []
            : []
        }
        onPick={handlePickVariant}
        onCancel={() => setVariantItem(null)}
      />

      <FoodConsentModal
        open={showFoodConsent}
        wristband={wristband}
        onOpenChange={(open) => {
          setShowFoodConsent(open);
          if (!open) setPendingItem(null);
        }}
        onOverride={handleFoodOverride}
      />
    </div>
  );
}
