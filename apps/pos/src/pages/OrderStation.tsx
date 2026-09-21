import { useEffect, useMemo, useState } from 'react';
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
  getMenuItems,
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
import { computeFnbTotals, computeLineTotal, hasModifiers, modifierSignature } from '@/lib/fnb';
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
import { Button } from '@/components/ui/button';
import { Monitor, AlertTriangle, Ban, Gift } from 'lucide-react';

const STAFF_BENEFIT_DISCOUNT_ID = 'staff-benefit';

type Stage = 'scan' | 'order' | 'payment' | 'confirmation';

let orderCounter = 1;
let lineCounter = 1;

export default function OrderStation() {
  const { operator } = useOperator();
  const { station } = useStation();
  const [, navigate] = useLocation();
  const menuItems = useMemo(() => getMenuItems(), []);

  const [stage, setStage] = useState<Stage>('scan');
  const [wristband, setWristband] = useState<Wristband | null>(null);
  const [cart, setCart] = useState<FnbOrderLine[]>([]);
  const [orderNote, setOrderNote] = useState('');
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<FnbOrder | null>(null);
  const [newBalance, setNewBalance] = useState<number | null>(null);

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

  // All F&B order totals flow through the shared tax + service engine. With the
  // seeded config (inclusive VAT, no service) `total` equals subtotal − discount,
  // so existing behaviour is unchanged; the breakdown is reported on the receipts.
  const fnbTotals = useMemo(
    () => computeFnbTotals(lines, effectiveManualDiscounts),
    [lines, effectiveManualDiscounts]
  );
  const { subtotal, total, manualAmounts, taxBreakdown } = fnbTotals;

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

  const handleConfirmPayment = (payment: FnbPaymentResult) => {
    if (!operator) return;
    // Can't print the receipt/pick-up ticket until this iPad is set up.
    if (!station) {
      promptSetupStation(navigate);
      return;
    }
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

    const order: FnbOrder = {
      id: String(orderCounter++).padStart(4, '0'),
      operatorId: operator.id,
      operatorName: operator.name,
      wristband: wristband ?? undefined,
      lines,
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
    recordFnbOrder(order);
    if (staffBenefit) attachBenefitAuditOrderId(staffBenefit.auditId, order.id);
    setCompletedOrder(order);
    setNewBalance(balanceAfter);
    setStage('confirmation');
    dispatchPrintJobs(fnbPrintJobs(station, order));
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

              <div className="flex-1 min-h-0">
                <MenuGrid items={menuItems} quantities={quantities} onAdd={handleAdd} />
              </div>
            </div>
            <div className="w-[380px] shrink-0 bg-sidebar p-6">
              <FnbCart
                wristband={wristband}
                lines={lines}
                total={total}
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
        )}

        {stage === 'confirmation' && completedOrder && (
          <FnbConfirmation order={completedOrder} newBalance={newBalance} onNewOrder={resetOrder} />
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
              lines={lines}
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
