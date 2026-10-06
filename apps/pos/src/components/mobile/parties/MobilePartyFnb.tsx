import { useMemo, useState } from 'react';
import { FnbOrderLine, ManualDiscount, MenuItem, PartyBooking, SelectedModifier } from '@/types';
import { useOperator } from '@/auth/OperatorContext';
import { getDiscountReasons, getMenuItems } from '@/mockApi';
import { fnbLineTotal, itemOrderTotals } from '@/lib/cartWire';
import {
  describeModifiers,
  hasModifiers,
  modifierSignature,
} from '@/lib/fnb';
import { dropDiscountsForRemovedLines } from '@/lib/manualDiscount';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { ModifierSheet } from '@/components/fnb/ModifierSheet';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { MobileFnbCartSheet } from '@/components/mobile/order-station/MobileFnbCartSheet';
import { ArrowLeft, PartyPopper } from 'lucide-react';

let partyMobileLineCounter = 1;

interface MobilePartyFnbProps {
  party: PartyBooking;
  operatorName: string;
  onCharge: (items: { name: string; qty: number; lineTotal: number }[], total: number) => void;
  onBack: () => void;
}

export function MobilePartyFnb({
  party,
  onCharge,
  onBack,
}: MobilePartyFnbProps) {
  const { operator } = useOperator();
  const menuItems = useMemo(() => getMenuItems(), []);

  const [cart, setCart] = useState<FnbOrderLine[]>([]);
  const [, setOrderNote] = useState('');
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [showCartSheet, setShowCartSheet] = useState(false);

  const [sheetItem, setSheetItem] = useState<MenuItem | null>(null);
  const [sheetMode, setSheetMode] = useState<'add' | 'edit'>('add');
  const [sheetLineId, setSheetLineId] = useState<string | null>(null);

  const lines = cart;

  const { subtotal, total, manualAmounts } = useMemo(
    () => itemOrderTotals(lines, manualDiscounts),
    [lines, manualDiscounts],
  );

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
    id: `pmline-${partyMobileLineCounter++}`,
    menuItem: item,
    qty,
    selectedModifiers: selected,
    lineTotal: fnbLineTotal(item, selected, qty),
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
        next[idx] = { ...merged, qty: newQty, lineTotal: fnbLineTotal(item, selected, newQty) };
        return next;
      }
      return [...prev, makeLine(item, selected, qty, note)];
    });
  };

  const handleAdd = (item: MenuItem) => {
    if (hasModifiers(item)) {
      setSheetItem(item);
      setSheetMode('add');
      setSheetLineId(null);
      return;
    }
    addOrMerge(item, [], 1);
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
    if (qty <= 0) {
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

  const handleClearCart = () => {
    setCart([]);
    setOrderNote('');
    setManualDiscounts([]);
  };

  const handleCharge = () => {
    if (cart.length === 0) return;
    const items = cart.map((l) => {
      const mods = describeModifiers(l.menuItem, l.selectedModifiers);
      return {
        name: mods.length > 0 ? `${l.menuItem.name} (${mods.join(', ')})` : l.menuItem.name,
        qty: l.qty,
        lineTotal: l.lineTotal,
      };
    });
    onCharge(items, total);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-3 border-b flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold text-sm">Add F&amp;B to party</h2>
          <p className="text-xs text-muted-foreground truncate">
            Charging to: {party.title}
            {party.childName ? ` (${party.childName})` : ''}
          </p>
        </div>
        <PartyPopper className="w-4 h-4 text-primary shrink-0" />
      </div>

      {/* Menu grid */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <MenuGrid items={menuItems} quantities={quantities} onAdd={handleAdd} />
      </div>

      {/* Cart sheet (sticky bar + bottom sheet) */}
      <MobileFnbCartSheet
        open={showCartSheet}
        onOpenChange={setShowCartSheet}
        wristband={null}
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
        onSwitchTab={onBack}
        onCheckout={handleCharge}
      />

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
          onApply={(md) => setManualDiscounts((prev) => [...prev, md])}
        />
      )}
    </div>
  );
}
