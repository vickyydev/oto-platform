import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  FnbOrder,
  FnbOrderLine,
  ManualDiscount,
  MenuItem,
  SelectedModifier,
  Wristband,
} from '@/types';
import { useOperator } from '@/auth/OperatorContext';
import { useStation } from '@/station/StationContext';
import {
  getMenuItems,
  chargeFnbCredit,
  redeemPrepaidItem,
  getDiscountReasons,
  recordFnbOrder,
} from '@/mockApi';
import {
  computeFnbTotals,
  computeLineTotal,
  hasModifiers,
  modifierSignature,
} from '@/lib/fnb';
import { dropDiscountsForRemovedLines } from '@/lib/manualDiscount';
import { dispatchPrintJobs, fnbPrintJobs, promptSetupStation } from '@/lib/printRouting';

import { ScanWristband } from '@/components/fnb/ScanWristband';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { ModifierSheet } from '@/components/fnb/ModifierSheet';
import { FnbPayment, FnbPaymentResult, FnbMethod, FnbRemainder } from '@/components/fnb/FnbPayment';
import { FnbConfirmation } from '@/components/fnb/FnbConfirmation';
import { FoodConsentModal } from '@/components/fnb/FoodConsentModal';
import { PickupCodeModal } from '@/components/fnb/PickupCodeModal';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { HandToCustomer } from '@/components/mobile/HandToCustomer';
import { useLanguage } from '@/i18n/LanguageContext';
import { MobileFnbCartSheet } from './MobileFnbCartSheet';

import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  Ban,
  Hash,
  Wallet,
  QrCode as QrCodeIcon,
  StickyNote,
  CheckCircle2,
  Gift,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Stage = 'scan' | 'order' | 'payment' | 'confirmation';
/** Which customer-facing content to show via HandToCustomer. */
type HandoffMode = 'review' | 'qr' | null;

let orderCounter = 100; // separate counter so mobile orders don't collide with iPad
let lineCounter = 100;

export function MobileOrderStation() {
  const { operator } = useOperator();
  const { station } = useStation();
  const { t } = useLanguage();
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
  const [pickupCode, setPickupCode] = useState('');
  const [showPickupModal, setShowPickupModal] = useState(false);
  const [showCartSheet, setShowCartSheet] = useState(false);
  const [payMethod, setPayMethod] = useState<FnbMethod | null>(null);
  const [payRemainder, setPayRemainder] = useState<FnbRemainder>('card');
  const [handoffMode, setHandoffMode] = useState<HandoffMode>(null);

  // Modifier sheet state
  const [sheetItem, setSheetItem] = useState<MenuItem | null>(null);
  const [sheetMode, setSheetMode] = useState<'add' | 'edit'>('add');
  const [sheetLineId, setSheetLineId] = useState<string | null>(null);

  // Food consent / override
  const [showFoodConsent, setShowFoodConsent] = useState(false);
  const [pendingItem, setPendingItem] = useState<MenuItem | null>(null);
  const [foodOverride, setFoodOverride] = useState<FnbOrder['foodConsentOverride'] | null>(null);

  const lines = cart;

  const fnbTotals = useMemo(
    () => computeFnbTotals(lines, manualDiscounts),
    [lines, manualDiscounts],
  );
  const { total, manualAmounts } = fnbTotals;

  const quantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of cart) map[line.menuItem.id] = (map[line.menuItem.id] ?? 0) + line.qty;
    return map;
  }, [cart]);

  // ── Cart manipulation ──────────────────────────────────────────────────────

  const makeLine = (
    item: MenuItem,
    selected: SelectedModifier[],
    qty: number,
    note?: string,
  ): FnbOrderLine => ({
    id: `mline-${lineCounter++}`,
    menuItem: item,
    qty,
    selectedModifiers: selected,
    lineTotal: computeLineTotal(item, selected, qty),
    note,
  });

  const addOrMerge = (item: MenuItem, selected: SelectedModifier[], qty: number, note?: string) => {
    const sig = modifierSignature(selected);
    setCart((prev) => {
      const idx = prev.findIndex(
        (l) =>
          l.menuItem.id === item.id &&
          modifierSignature(l.selectedModifiers) === sig &&
          (l.note ?? '') === (note ?? ''),
      );
      if (idx >= 0) {
        const next = [...prev];
        const merged = next[idx];
        const newQty = merged.qty + qty;
        next[idx] = { ...merged, qty: newQty, lineTotal: computeLineTotal(item, selected, newQty) };
        return next;
      }
      return [...prev, makeLine(item, selected, qty, note)];
    });
  };

  const proceedAdd = (item: MenuItem) => {
    if (hasModifiers(item)) {
      setSheetItem(item);
      setSheetMode('add');
      setSheetLineId(null);
      return;
    }
    addOrMerge(item, [], 1);
  };

  const handleAdd = (item: MenuItem) => {
    if (wristband?.mayOrderFood === false && !foodOverride) {
      setPendingItem(item);
      setShowFoodConsent(true);
      return;
    }
    proceedAdd(item);
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
      id: `mline-${lineCounter++}`,
      menuItem,
      qty: 1,
      selectedModifiers: [],
      lineTotal: 0,
      isPrepaid: true,
    };
    setCart((prev) => [...prev, line]);
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
        const twinIdx = prev.findIndex(
          (l) =>
            l.id !== editedId &&
            l.menuItem.id === item.id &&
            modifierSignature(l.selectedModifiers) === sig &&
            (l.note ?? '') === (note ?? ''),
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
            : l,
        );
      });
    } else {
      addOrMerge(item, selected, qty, note);
    }
    closeSheet();
  };

  const closeSheet = () => {
    setSheetItem(null);
    setSheetLineId(null);
  };

  const handleChangeQty = (lineId: string, qty: number) => {
    if (qty <= 0) {
      setManualDiscounts((prev) => prev.filter((md) => md.targetLineId !== lineId));
    }
    setCart((prev) => {
      if (qty <= 0) return prev.filter((l) => l.id !== lineId);
      return prev.map((l) =>
        l.id === lineId
          ? { ...l, qty, lineTotal: computeLineTotal(l.menuItem, l.selectedModifiers, qty) }
          : l,
      );
    });
  };

  const handleClearCart = () => {
    setCart([]);
    setOrderNote('');
    setManualDiscounts([]);
  };

  // ── Stage transitions ──────────────────────────────────────────────────────

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
    setCompletedOrder(null);
    setNewBalance(null);
    setPickupCode('');
    setShowPickupModal(false);
    setShowCartSheet(false);
    setPayMethod(null);
    setPayRemainder('card');
    setHandoffMode(null);
    setShowFoodConsent(false);
    setPendingItem(null);
    setFoodOverride(null);
    closeSheet();
  };

  // Pickup code confirmed → show customer review via HandToCustomer
  const handlePickupConfirm = (code: string) => {
    setPickupCode(code);
    setShowPickupModal(false);
    const balance = wristband?.creditBalanceTHB ?? 0;
    setPayMethod(balance > 0 ? 'credit' : null);
    setPayRemainder('card');
    // Show the order to the customer for review before charging
    setHandoffMode('review');
  };

  // Customer finished reviewing → proceed to payment step
  const handleReviewDone = () => {
    setHandoffMode(null);
    setStage('payment');
  };

  const handleConfirmPayment = (payment: FnbPaymentResult) => {
    if (!operator) return;
    // Station must be configured before we can record + dispatch print jobs.
    // Matches the iPad guard: the order is NOT recorded until station is set.
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

    const order: FnbOrder = {
      id: String(orderCounter++).padStart(4, '0'),
      operatorId: operator.id,
      operatorName: operator.name,
      wristband: wristband ?? undefined,
      lines,
      manualDiscounts,
      total,
      pickupCode,
      orderNote: orderNote.trim() || undefined,
      payment,
      createdAt: new Date().toISOString(),
      status: 'paid',
      refunds: [],
      foodConsentOverride: foodOverride ?? undefined,
    };
    recordFnbOrder(order);
    setCompletedOrder(order);
    setNewBalance(balanceAfter);
    setHandoffMode(null);
    setStage('confirmation');
    dispatchPrintJobs(fnbPrintJobs(station, order));
  };

  // When staff picks QR/PromptPay on the payment step, show the QR to the customer
  const handleMethodChange = (m: FnbMethod) => {
    setPayMethod(m);
    if (m === 'promptpay') {
      setHandoffMode('qr');
    } else {
      setHandoffMode(null);
    }
  };

  const balance = wristband?.creditBalanceTHB ?? 0;
  const creditUsedAmount = Math.min(balance, total);
  const remainderAfterCredit = total - creditUsedAmount;
  const promptpayAmount =
    payMethod === 'promptpay'
      ? total
      : payMethod === 'credit' && remainderAfterCredit > 0 && payRemainder === 'promptpay'
        ? remainderAfterCredit
        : null;

  // ── Customer-facing review content (no allergy info ever) ─────────────────

  const customerReviewContent = (
    <div className="min-h-full flex flex-col bg-slate-950 text-white p-6">
      <div className="flex flex-col items-center text-center mb-6">
        <div className="w-16 h-16 rounded-full bg-primary/20 text-primary flex items-center justify-center mb-3">
          <CheckCircle2 className="w-9 h-9" />
        </div>
        <h2 className="text-2xl font-black tracking-tight">Your Order</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Please review your items and total below.
        </p>
      </div>

      {pickupCode && (
        <div className="flex items-center justify-center gap-2 mb-5 px-4 py-2 rounded-full border border-white/20 bg-white/10 self-center">
          <Hash className="w-4 h-4 text-white/70" />
          <span className="text-sm text-white/70">Pick-up code</span>
          <span className="font-black text-white tracking-widest">{pickupCode}</span>
        </div>
      )}

      <div className="flex-1 space-y-2 mb-4">
        {lines.map((line) => (
          <div key={line.id} className="flex items-center justify-between gap-3 py-2 border-b border-white/10">
            <div className="min-w-0 flex-1">
              <span className="font-bold tabular-nums mr-1">{line.qty}×</span>
              <span className="font-medium">{line.menuItem.name}</span>
              {line.note && (
                <div className="flex items-start gap-1 mt-0.5 text-xs text-amber-300">
                  <StickyNote className="w-3 h-3 mt-px shrink-0" />
                  {line.note}
                </div>
              )}
            </div>
            <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
          </div>
        ))}
      </div>

      {wristband && balance > 0 && (
        <div className="flex items-center justify-between py-2 text-sm text-white/70 border-t border-white/10">
          <span className="flex items-center gap-1.5">
            <Wallet className="w-4 h-4" />
            Credit
          </span>
          <span className="tabular-nums">฿{balance} available</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-white/20">
        <span className="text-xl font-black">Total</span>
        <span className="text-3xl font-black tabular-nums text-primary">฿{total}</span>
      </div>
    </div>
  );

  const qrContent = (
    <div className="min-h-full flex flex-col items-center justify-center bg-slate-950 text-white p-8">
      <div className="text-center mb-6">
        <p className="text-muted-foreground text-sm mb-1">Scan to pay</p>
        <div className="text-4xl font-black tabular-nums text-primary">
          ฿{promptpayAmount ?? total}
        </div>
        {pickupCode && (
          <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full border border-white/20 bg-white/10 text-sm text-white/70">
            <Hash className="w-3.5 h-3.5" />
            Pick-up code{' '}
            <span className="font-black text-white tracking-widest">{pickupCode}</span>
          </div>
        )}
      </div>
      {/* QR placeholder — same pattern as MobileTill uses */}
      <div className="w-56 h-56 rounded-2xl bg-white flex items-center justify-center mb-6 shadow-xl">
        <div className="flex flex-col items-center gap-2 text-slate-800">
          <QrCodeIcon className="w-20 h-20" />
          <span className="text-xs font-bold text-slate-500">Thai QR / PromptPay</span>
        </div>
      </div>
      <p className="text-center text-sm text-muted-foreground max-w-xs">
        Ask the customer to scan this code with their banking app to pay.
      </p>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* ── Scan stage ── */}
      {stage === 'scan' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="min-h-full">
            <ScanWristband onLoadTab={loadBand} onGuest={() => loadBand(null)} />
          </div>
        </div>
      )}

      {/* ── Order stage ── */}
      {stage === 'order' && (
        <>
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Staff-only safety banners — NEVER shown in customer-facing content */}
            {(wristband?.allergiesMedical || wristband?.mayOrderFood === false) && (
              <div className="shrink-0 px-4 pt-3 space-y-2">
                {wristband.allergiesMedical && (
                  <div className="rounded-xl border border-red-500/50 bg-red-500/15 px-4 py-3 text-red-200">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
                      <div className="min-w-0">
                        <div className="text-xs font-bold uppercase tracking-wide text-red-300">
                          Allergy / medical alert
                          {wristband.holderName ? ` · ${wristband.holderName}` : ''}
                        </div>
                        <div className="font-semibold text-sm">{wristband.allergiesMedical}</div>
                        {wristband.foodRestrictions && (
                          <div className="text-xs text-red-200/80">
                            Restriction: {wristband.foodRestrictions}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {wristband?.mayOrderFood === false && (
                  <div className="rounded-xl border border-amber-500/50 bg-amber-500/15 px-4 py-3 text-amber-200">
                    <div className="flex items-start gap-2.5">
                      <Ban className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                      <div className="min-w-0">
                        <div className="text-xs font-bold uppercase tracking-wide text-amber-300">
                          Food not authorized
                        </div>
                        <div className="text-xs">
                          {foodOverride
                            ? `Overridden by ${foodOverride.byName} — orders allowed.`
                            : 'Parent did not authorize food orders for this child.'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Prepaid item entitlements — staff only, never on customer display */}
            {wristband?.foodProvision?.mode === 'prepaid_items' &&
              wristband.foodProvision.items &&
              wristband.foodProvision.items.length > 0 && (
                <div className="shrink-0 px-4 pt-3">
                  <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3">
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
                              ${
                                fullyUsed
                                  ? 'cursor-not-allowed border-violet-500/20 text-violet-500/40 bg-violet-500/5'
                                  : 'border-violet-500/50 text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 active:scale-[0.97]'
                              }`}
                          >
                            <Gift className="w-3.5 h-3.5 shrink-0" />
                            <span>{ent.menuItemName}</span>
                            <span
                              className={`tabular-nums text-xs ${fullyUsed ? 'text-violet-500/40' : 'text-violet-400'}`}
                            >
                              {fullyUsed ? 'Served' : `${remaining} left`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            {/* Prepaid credit info — shown when band carries child-tagged F&B credit */}
            {wristband?.foodProvision?.mode === 'prepaid_credit' && (
              <div className="shrink-0 px-4 pt-3">
                <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3">
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
              </div>
            )}

            {/* Order note bar */}
            <div className="shrink-0 px-4 pt-2 pb-1">
              <OrderNoteBar value={orderNote} onChange={setOrderNote} />
            </div>

            {/* Menu — fills remaining space */}
            <div className="flex-1 min-h-0 px-4 pt-2 pb-1">
              <MenuGrid items={menuItems} quantities={quantities} onAdd={handleAdd} />
            </div>
          </div>

          {/* Sticky cart bar + sheet */}
          <MobileFnbCartSheet
            open={showCartSheet}
            onOpenChange={setShowCartSheet}
            wristband={wristband}
            lines={lines}
            manualDiscounts={manualDiscounts}
            manualAmounts={manualAmounts}
            onChangeQty={handleChangeQty}
            onEditLine={handleEditLine}
            onClear={handleClearCart}
            onAddManualDiscount={() => setShowDiscountModal(true)}
            onRemoveManualDiscount={(id) =>
              setManualDiscounts((prev) => prev.filter((md) => md.id !== id))
            }
            onSwitchTab={resetOrder}
            onCheckout={() => setShowPickupModal(true)}
          />
        </>
      )}

      {/* ── Payment stage ── */}
      {stage === 'payment' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="min-h-full">
          <FnbPayment
            total={total}
            wristband={wristband}
            pickupCode={pickupCode}
            method={payMethod}
            remainder={payRemainder}
            onMethodChange={handleMethodChange}
            onRemainderChange={(r) => {
              setPayRemainder(r);
              if (r === 'promptpay') setHandoffMode('qr');
              else setHandoffMode(null);
            }}
            onConfirm={handleConfirmPayment}
            onBack={() => setStage('order')}
          />
          </div>
        </div>
      )}

      {/* ── Confirmation stage ── */}
      {stage === 'confirmation' && completedOrder && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <FnbConfirmation
            order={completedOrder}
            newBalance={newBalance}
            onNewOrder={resetOrder}
            flowLayout
          />
        </div>
      )}

      {/* ── Hand-to-customer overlay ── */}
      {handoffMode === 'review' && (
        <HandToCustomer
          title={t('handToCustomer.showOrderTitle')}
          subtitle={t('handToCustomer.showOrderSubtitle')}
          handBackLabel={t('handToCustomer.customerConfirmedHandBack')}
          onDone={handleReviewDone}
          onCancel={() => setHandoffMode(null)}
        >
          {customerReviewContent}
        </HandToCustomer>
      )}

      {handoffMode === 'qr' && (
        <HandToCustomer
          title={t('handToCustomer.scanQrTitle')}
          subtitle={t('handToCustomer.scanQrSubtitle')}
          handBackLabel={t('handToCustomer.paymentReceivedHandBack')}
          onDone={() => setHandoffMode(null)}
          onCancel={() => {
            setPayMethod(null);
            setHandoffMode(null);
          }}
        >
          {qrContent}
        </HandToCustomer>
      )}

      {/* ── Shared modals ── */}
      <PickupCodeModal
        open={showPickupModal}
        total={total}
        initialCode={pickupCode}
        onOpenChange={setShowPickupModal}
        onConfirm={handlePickupConfirm}
      />

      {operator && (
        <ManualDiscountModal
          open={showDiscountModal}
          onOpenChange={setShowDiscountModal}
          subtotal={fnbTotals.subtotal}
          lines={lines.map((l) => ({
            id: l.id,
            label: `${l.qty}× ${l.menuItem.name}`,
            amount: l.lineTotal,
          }))}
          reasons={getDiscountReasons()}
          operatorId={operator.id}
          operatorName={operator.name}
          onApply={(md) => setManualDiscounts((prev) => [...prev, md])}
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

// ── Order note bar (compact, inline) ──────────────────────────────────────────

function OrderNoteBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="flex gap-2 items-center">
        <input
          autoFocus
          className={cn(
            'flex-1 h-9 rounded-xl border bg-card px-3 text-sm outline-none',
            'focus:ring-1 focus:ring-primary focus:border-primary',
            'placeholder:text-muted-foreground',
          )}
          placeholder="Order note for kitchen / bar…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === 'Enter' && setEditing(false)}
          maxLength={200}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-9 px-3 text-xs"
          onClick={() => setEditing(false)}
        >
          Done
        </Button>
      </div>
    );
  }

  // Use a div + role for the row so we can nest the clear button without a
  // nested-button accessibility violation.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setEditing(true)}
      className={cn(
        'w-full flex items-center gap-2 h-9 px-3 rounded-xl border text-sm transition-colors cursor-pointer select-none',
        value
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          : 'border-dashed bg-card/50 text-muted-foreground hover:border-primary/50',
      )}
    >
      <StickyNote className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate flex-1">{value || 'Add order note…'}</span>
      {value && (
        <button
          type="button"
          className="ml-auto shrink-0 text-amber-400 hover:text-amber-200"
          onClick={(e) => {
            e.stopPropagation();
            onChange('');
          }}
          aria-label="Clear order note"
        >
          ×
        </button>
      )}
    </div>
  );
}
