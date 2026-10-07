import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { FnbCart } from '@/components/fnb/FnbCart';
import { ModifierSheet } from '@/components/fnb/ModifierSheet';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { FnbCustomerDisplay, FnbCustomerStage } from '@/components/fnb/FnbCustomerDisplay';
import { FnbOrderLine, ManualDiscount, MenuItem, PartyBooking, SelectedModifier } from '@/types';
import { getDiscountReasons, getMenuItems } from '@/mockApi';
import { fnbLineTotal, itemOrderTotals } from '@/lib/cartWire';
import {
  describeModifiers,
  hasModifiers,
  modifierSignature,
} from '@/lib/fnb';
import { dropDiscountsForRemovedLines } from '@/lib/manualDiscount';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import { useOperator } from '@/auth/OperatorContext';
import type { PartyChargeConfirmation, PartyChargeLine } from '@/api/parties';
import { PartyChargeHeldNote } from './PartyChargeHeldNote';
import { usePartyChargeHold } from './usePartyChargeHold';
import { Monitor, PartyPopper } from 'lucide-react';

interface PartyFnbModalProps {
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

// The party F&B builder is the F&B order-station "order" stage verbatim: same
// MenuGrid + FnbCart + ModifierSheet + manual-discount flow on the left, and the
// same live FnbCustomerDisplay on the right (test-harness split). The only
// difference from the station is the outcome — instead of taking payment, the
// built order is charged to the party tab as an extra charge.
let partyLineCounter = 1;

export function PartyFnbModal({
  open,
  onOpenChange,
  party,
  operatorName,
  onCharge,
}: PartyFnbModalProps) {
  const { operator } = useOperator();
  const menuItems = useMemo(() => getMenuItems(), []);

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

  const [cart, setCart] = useState<FnbOrderLine[]>([]);
  const [orderNote, setOrderNote] = useState('');
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [customerTheme] = useCustomerTheme();

  // Modifier selection sheet. lineId is set when editing an existing cart line.
  const [sheetItem, setSheetItem] = useState<MenuItem | null>(null);
  const [sheetMode, setSheetMode] = useState<'add' | 'edit'>('add');
  const [sheetLineId, setSheetLineId] = useState<string | null>(null);

  // S2-20 E4 — from the charge press until the platform says yes or no, the
  // order is held exactly as it was sent: nothing adds to it, changes, clears
  // or leaves it meanwhile (each is refused with "Order held"), and after an
  // answer that never came the charge press sends it again.
  const hold = usePartyChargeHold();
  const whileHeld = hold.refused;

  const lines = cart;

  // Same shared tax + service engine as the standalone F&B station.
  const { subtotal, total, manualAmounts, taxBreakdown } = useMemo(
    () => itemOrderTotals(lines, manualDiscounts),
    [lines, manualDiscounts]
  );

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
  ): FnbOrderLine => ({
    id: `pline-${partyLineCounter++}`,
    menuItem: item,
    qty,
    selectedModifiers: selected,
    lineTotal: fnbLineTotal(item, selected, qty),
    note,
  });

  const addOrMerge = (item: MenuItem, selected: SelectedModifier[], qty: number, note?: string) => {
    const sig = modifierSignature(selected);
    setCart((prev) => {
      // Only merge into a twin with the SAME note — distinct notes stay separate.
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
        next[idx] = { ...merged, qty: newQty, lineTotal: fnbLineTotal(item, selected, newQty) };
        return next;
      }
      return [...prev, makeLine(item, selected, qty, note)];
    });
  };

  const handleAdd = (item: MenuItem) => {
    if (whileHeld()) return;
    if (hasModifiers(item)) {
      setSheetItem(item);
      setSheetMode('add');
      setSheetLineId(null);
      return;
    }
    addOrMerge(item, [], 1);
  };

  const handleEditLine = (line: FnbOrderLine) => {
    if (whileHeld()) return;
    // Every line opens the edit sheet — even no-modifier items — so staff can add
    // or change a free-text note (qty is still also editable inline via the stepper).
    setSheetItem(line.menuItem);
    setSheetMode('edit');
    setSheetLineId(line.id);
  };

  const handleSheetSave = (selected: SelectedModifier[], qty: number, note?: string) => {
    const item = sheetItem;
    if (!item || whileHeld()) return;
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
              return { ...l, qty: newQty, lineTotal: fnbLineTotal(item, selected, newQty) };
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
                lineTotal: fnbLineTotal(item, selected, qty),
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
    if (whileHeld()) return;
    if (qty <= 0) {
      // Line is being removed — drop any manual discount that targeted it.
      setManualDiscounts((prev) => prev.filter((md) => md.targetLineId !== lineId));
    }
    setCart((prev) => {
      if (qty <= 0) return prev.filter((l) => l.id !== lineId);
      return prev.map((l) =>
        l.id === lineId
          ? { ...l, qty, lineTotal: fnbLineTotal(l.menuItem, l.selectedModifiers, qty) }
          : l,
      );
    });
  };

  const handleApplyManualDiscount = (md: ManualDiscount) => {
    if (whileHeld()) return;
    setManualDiscounts((prev) => [...prev, md]);
  };

  const handleRemoveManualDiscount = (id: string) => {
    if (whileHeld()) return;
    setManualDiscounts((prev) => prev.filter((md) => md.id !== id));
  };

  const handleClearCart = () => {
    if (whileHeld()) return;
    setCart([]);
    setOrderNote('');
    setManualDiscounts([]);
  };

  const reset = () => {
    setCart([]);
    setOrderNote('');
    setManualDiscounts([]);
    setShowDiscountModal(false);
    hold.release();
    closeSheet();
  };

  const handleCharge = async () => {
    if (cart.length === 0) return;
    const items = cart.map((l) => {
      const mods = describeModifiers(l.menuItem, l.selectedModifiers);
      return {
        name: mods.length > 0 ? `${l.menuItem.name} (${mods.join(', ')})` : l.menuItem.name,
        qty: l.qty,
        lineTotal: l.lineTotal,
      };
    });
    // Held from here: the order on screen is the order sent. On its way
    // already (a second press), nothing more is sent.
    const result = await hold.charge(() => onCharge(items, total));
    // No answer: still held as sent. A definite no: the order is staff's again.
    if (!result?.charged) return;
    reset();
    onOpenChange(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (whileHeld()) return;
      reset();
    }
    onOpenChange(next);
  };

  // Customer display stage mirrors the order stage of the F&B station.
  const customerStage: FnbCustomerStage = 'order';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-none w-screen h-[100dvh] p-0 gap-0 border-0 rounded-none overflow-hidden flex flex-col bg-background">
        <DialogTitle className="sr-only">Add F&amp;B to {party.title}</DialogTitle>
        <DialogDescription className="sr-only">
          Build an F&amp;B order on the staff station; the customer display mirrors it live. The order
          is charged to the party tab.
        </DialogDescription>

        {/* Test-harness banner — identical to the F&B order station */}
        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <Monitor className="w-4 h-4 shrink-0" />
            <span className="truncate">
              Adding F&amp;B to {party.title} — staff station (left) + customer display (right) share
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
            {/* Staff station — F&B order stage */}
            <div className="flex flex-col h-full min-h-0 bg-background text-foreground">
              <div className="shrink-0 flex items-center gap-2 bg-primary/10 border-b border-primary/20 px-6 py-3">
                <PartyPopper className="w-5 h-5 text-primary shrink-0" />
                <span className="font-semibold">
                  Charging to: {party.title}
                  {party.childName ? ` (${party.childName})` : ''}
                </span>
              </div>
              <div className="flex-1 flex min-h-0">
                <div className="flex-1 min-w-0 p-6 border-r bg-card/20">
                  <MenuGrid items={menuItems} quantities={quantities} onAdd={handleAdd} />
                </div>
                <div className="w-[380px] shrink-0 bg-sidebar p-6">
                  <FnbCart
                  wristband={null}
                  chargeTarget={chargeTarget}
                  lines={lines}
                  total={total}
                  manualDiscounts={manualDiscounts}
                  manualAmounts={manualAmounts}
                  taxBreakdown={taxBreakdown}
                  onChangeQty={handleChangeQty}
                  onEditLine={handleEditLine}
                  onClear={handleClearCart}
                  onCheckout={() => void handleCharge()}
                  onSwitchTab={() => handleOpenChange(false)}
                  onAddManualDiscount={() => {
                    if (!whileHeld()) setShowDiscountModal(true);
                  }}
                  onRemoveManualDiscount={handleRemoveManualDiscount}
                  priceNote={hold.unanswered ? <PartyChargeHeldNote /> : undefined}
                />
                </div>
              </div>
            </div>
          </div>

          {showCustomerDisplay && (
            <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
              <FnbCustomerDisplay
                stage={customerStage}
                chargeTarget={chargeTarget}
                wristband={null}
                lines={lines}
                orderNote={orderNote}
                manualDiscounts={manualDiscounts}
                total={total}
                taxBreakdown={taxBreakdown}
                promptpayAmount={null}
                completedOrder={null}
                newBalance={null}
              />
            </div>
          )}
        </div>
      </DialogContent>

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
    </Dialog>
  );
}
