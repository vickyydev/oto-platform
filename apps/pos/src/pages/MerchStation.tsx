import { useMemo, useState } from 'react';
import { StationHeader } from '@/components/shared/StationHeader';
import { ManualDiscount, MerchItem, MerchOrder, MerchOrderLine, Wristband } from '@/types';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import { getActiveMerchItems, chargeMerchCredit, getDiscountReasons, recordMerchOrder, getInventoryItem } from '@/mockApi';
import { computeMerchTotals, computeMerchLineTotal, isOutOfStock } from '@/lib/merch';
import { VariantPickerModal } from '@/components/shared/VariantPickerModal';
import { ScanWristband } from '@/components/fnb/ScanWristband';
import { MerchGrid } from '@/components/merch/MerchGrid';
import { MerchCart } from '@/components/merch/MerchCart';
import { FnbPayment, FnbPaymentResult, FnbMethod, FnbRemainder } from '@/components/fnb/FnbPayment';
import { MerchConfirmation } from '@/components/merch/MerchConfirmation';
import { MerchCustomerDisplay, MerchCustomerStage } from '@/components/merch/MerchCustomerDisplay';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { useOperator } from '@/auth/OperatorContext';
import { Button } from '@/components/ui/button';
import { Monitor } from 'lucide-react';

type Stage = 'scan' | 'order' | 'payment' | 'confirmation';

let orderCounter = 1;
let lineCounter = 1;

export default function MerchStation() {
  const { operator } = useOperator();

  const [stage, setStage] = useState<Stage>('scan');
  const [wristband, setWristband] = useState<Wristband | null>(null);
  const [cart, setCart] = useState<MerchOrderLine[]>([]);
  // Item awaiting variant selection (multi-variant inventory items).
  const [pendingVariantItem, setPendingVariantItem] = useState<MerchItem | null>(null);
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<MerchOrder | null>(null);
  const [newBalance, setNewBalance] = useState<number | null>(null);
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [customerTheme] = useCustomerTheme();
  const [payMethod, setPayMethod] = useState<FnbMethod | null>(null);
  const [payRemainder, setPayRemainder] = useState<FnbRemainder>('card');

  // Live snapshot of the SELLABLE (active) merch catalog. Re-read on each new sale
  // so on-hand stock reflects the previous sale's decrement; retired (inactive)
  // items are excluded from the sell surface (all data flows through the store).
  const [merchItems, setMerchItems] = useState<MerchItem[]>(() => getActiveMerchItems());

  const lines = cart;

  const totals = useMemo(
    () => computeMerchTotals(lines, manualDiscounts),
    [lines, manualDiscounts]
  );
  const { subtotal, total, manualAmounts, taxBreakdown } = totals;

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

  const handleClearCart = () => {
    setCart([]);
    setManualDiscounts([]);
  };

  const loadBand = (wb: Wristband | null) => {
    setWristband(wb);
    setStage('order');
  };

  const resetOrder = () => {
    setStage('scan');
    setWristband(null);
    setCart([]);
    setManualDiscounts([]);
    setCompletedOrder(null);
    setNewBalance(null);
    setPayMethod(null);
    setPayRemainder('card');
    setMerchItems(getActiveMerchItems()); // refresh on-hand stock after the sale's decrement
  };

  const handleCheckout = () => {
    // Wallet credit is one universal pool spendable at both stations.
    const balance = wristband?.creditBalanceTHB ?? 0;
    setPayMethod(balance > 0 ? 'credit' : null);
    setPayRemainder('card');
    setStage('payment');
  };

  const handleConfirmPayment = (payment: FnbPaymentResult) => {
    if (!operator) return;
    let balanceAfter: number | null = null;
    if (wristband && payment.creditUsed > 0) {
      balanceAfter = chargeMerchCredit(wristband.id, payment.creditUsed, operator.name);
    } else if (wristband) {
      balanceAfter = wristband.creditBalanceTHB ?? 0;
    }

    const order: MerchOrder = {
      id: String(orderCounter++).padStart(4, '0'),
      operatorId: operator.id,
      operatorName: operator.name,
      wristband: wristband ?? undefined,
      lines,
      manualDiscounts,
      total,
      payment,
      createdAt: new Date().toISOString(),
      status: 'paid',
      refunds: [],
    };
    recordMerchOrder(order); // decrements on-hand stock in the store
    setCompletedOrder(order);
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
              <div className="flex-1 min-h-0">
                <MerchGrid items={merchItems} quantities={quantities} onAdd={handleAdd} />
              </div>
            </div>
            <div className="w-[380px] shrink-0 bg-sidebar p-6">
              <MerchCart
                wristband={wristband}
                lines={lines}
                total={total}
                manualDiscounts={manualDiscounts}
                manualAmounts={manualAmounts}
                taxBreakdown={taxBreakdown}
                onChangeQty={handleChangeQty}
                onClear={handleClearCart}
                onCheckout={handleCheckout}
                onSwitchTab={resetOrder}
                onAddManualDiscount={() => setShowDiscountModal(true)}
                onRemoveManualDiscount={handleRemoveManualDiscount}
              />
            </div>
          </div>
        )}

        {stage === 'payment' && (
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
        )}

        {stage === 'confirmation' && completedOrder && (
          <MerchConfirmation
            order={completedOrder}
            newBalance={newBalance}
            onNewOrder={resetOrder}
          />
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
              lines={lines}
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
