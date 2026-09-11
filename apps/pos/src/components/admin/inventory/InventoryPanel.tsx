import { useState } from 'react';
import { Package, AlertTriangle, Pencil, Plus, MapPin } from 'lucide-react';
import { InventoryItem, InventoryVariant, MerchItem, AddOn, MenuItem } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InventoryItemFormDialog } from './InventoryItemFormDialog';
import { StockAdjustModal } from './StockAdjustModal';
import { StockLocationsPanel } from './StockLocationsPanel';
import { recordInventoryAdjustment } from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { getRestockAlerts } from '@/lib/inventory';

type Tab = 'items' | 'locations';

function variantStockBadge(v: InventoryVariant) {
  if (v.stock <= 0) {
    return (
      <Badge variant="destructive" className="gap-1 text-[11px]">
        <AlertTriangle className="w-3 h-3" />
        Out
      </Badge>
    );
  }
  if (v.lowStockThreshold !== undefined && v.stock <= v.lowStockThreshold) {
    return (
      <Badge className="gap-1 text-[11px] bg-amber-500 hover:bg-amber-500">
        <AlertTriangle className="w-3 h-3" />
        Low · {v.stock}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[11px] tabular-nums">
      {v.stock}
    </Badge>
  );
}

/**
 * Unified Inventory admin panel with two tabs:
 *   Items     — every InventoryItem with variants, stock, and edit/adjust actions.
 *   Locations — manager-only: add/edit/toggle stock locations + sell-point designation.
 */
export function InventoryPanel() {
  const {
    inventory,
    stockLocations,
    merchItems,
    addOns,
    menuItems,
    mutators,
  } = useCatalogStore();
  const { operator } = useOperator();

  const [tab, setTab] = useState<Tab>('items');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [adjusting, setAdjusting] = useState<{
    item: InventoryItem;
    variant: InventoryVariant;
  } | null>(null);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (item: InventoryItem) => {
    setEditing(item);
    setFormOpen(true);
  };

  const openAdjust = (item: InventoryItem, variant: InventoryVariant) => {
    setAdjusting({ item, variant });
  };

  const handleAdjust = (delta: number, reason: string) => {
    if (!adjusting || !operator) return;
    recordInventoryAdjustment({
      inventoryItemId: adjusting.item.id,
      variantId: adjusting.variant.id,
      delta,
      reason,
      operator: operator.name,
      operatorId: operator.id,
    });
    setAdjusting(null);
  };

  // All locations (active + retired) for the form's par inputs
  const activeLocations = stockLocations.filter((l) => l.active);

  const merch = inventory.filter((i) => i.linkedKind === 'merch');
  const addon = inventory.filter((i) => i.linkedKind === 'addon');
  const menu = inventory.filter((i) => i.linkedKind === 'menu');
  const alerts = getRestockAlerts(inventory);

  const renderItem = (item: InventoryItem) => (
    <div
      key={item.id}
      className={`rounded-2xl border bg-foreground/[0.02] p-4 ${
        item.active === false ? 'opacity-50 border-foreground/6' : 'border-foreground/10'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        {item.photoUrl && (
          <img
            src={item.photoUrl}
            alt={item.name}
            className="w-14 h-14 shrink-0 rounded-lg object-cover border border-foreground/10"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{item.name}</span>
            {item.sku && (
              <span className="text-[10px] font-mono text-foreground/40">{item.sku}</span>
            )}
            <span className="text-[11px] rounded-full bg-foreground/5 px-2 py-0.5 text-foreground/40">
              {item.linkedKind === 'merch'
                ? 'Merch'
                : item.linkedKind === 'menu'
                  ? 'F&B'
                  : 'Add-on'}
            </span>
            {item.category && (
              <span className="text-[11px] rounded-full bg-foreground/5 px-2 py-0.5 text-foreground/40">
                {item.category}
              </span>
            )}
            {item.active === false && (
              <Badge variant="outline" className="text-[11px] text-foreground/40">Retired</Badge>
            )}
            <span className="text-[11px] text-foreground/35 font-mono">{item.linkedId}</span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {item.variants.map((v) => (
              <div key={v.id} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-sm font-medium">{v.label}</span>
                {v.sku && (
                  <span className="text-[10px] font-mono text-foreground/35">{v.sku}</span>
                )}
                {variantStockBadge(v)}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-foreground/60"
                  onClick={() => openAdjust(item, v)}
                >
                  Adjust
                </Button>
              </div>
            ))}
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          onClick={() => openEdit(item)}
          aria-label={`Edit ${item.name}`}
        >
          <Pencil className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Tab strip */}
      <div className="flex gap-1 border-b border-foreground/10 -mb-2">
        <TabButton active={tab === 'items'} onClick={() => setTab('items')}>
          <Package className="w-3.5 h-3.5" />
          Items
        </TabButton>
        <TabButton active={tab === 'locations'} onClick={() => setTab('locations')}>
          <MapPin className="w-3.5 h-3.5" />
          Locations
          <span className="ml-1 text-[10px] font-normal text-foreground/40">(manager)</span>
        </TabButton>
      </div>

      {/* ── Items tab ── */}
      {tab === 'items' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-foreground/50">
              {inventory.length} items · {inventory.reduce((s, i) => s + i.variants.length, 0)} variants
            </p>
            <Button onClick={openAdd}>
              <Plus className="w-4 h-4" />
              New item
            </Button>
          </div>

          {inventory.length === 0 && (
            <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
              No inventory items yet.
            </div>
          )}

          {alerts.length > 0 && (
            <div className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-4">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider">
                  Needs restocking · {alerts.length}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
                {alerts.map(({ item, variant, status }) => (
                  <div key={`${item.id}-${variant.id}`} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{item.name}</span>
                    {item.variants.length > 1 && (
                      <span className="text-foreground/50">· {variant.label}</span>
                    )}
                    {status === 'out' ? (
                      <Badge variant="destructive" className="text-[11px]">Out</Badge>
                    ) : (
                      <Badge className="text-[11px] bg-amber-500 hover:bg-amber-500">Low · {variant.stock}</Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {merch.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/40">
                <Package className="w-3.5 h-3.5" />
                Merch items
              </h3>
              <div className="flex flex-col gap-2">{merch.map(renderItem)}</div>
            </section>
          )}

          {addon.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/40">
                <Package className="w-3.5 h-3.5" />
                Stocked add-ons
              </h3>
              <div className="flex flex-col gap-2">{addon.map(renderItem)}</div>
            </section>
          )}

          {menu.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/40">
                <Package className="w-3.5 h-3.5" />
                Stocked F&amp;B items
              </h3>
              <div className="flex flex-col gap-2">{menu.map(renderItem)}</div>
            </section>
          )}

          <p className="text-xs text-foreground/35">
            Sale decrements and refund restores happen automatically. Use "Adjust" for
            receive, shrinkage, or recount corrections — these are stamped with your operator ID.
          </p>
        </>
      )}

      {/* ── Locations tab ── */}
      {tab === 'locations' && <StockLocationsPanel />}

      {/* Dialogs (always mounted so state survives tab switch) */}
      <InventoryItemFormDialog
        open={formOpen}
        item={editing}
        stockLocations={activeLocations}
        merchItems={merchItems}
        addOns={addOns}
        menuItems={menuItems}
        onClose={() => setFormOpen(false)}
        onSave={(newItem) => {
          mutators.upsertInventoryItem(newItem);

          // Keep the sellable-product's inventoryItemId in sync with the link.
          // Stock decrement flows read product.inventoryItemId, NOT InventoryItem.linkedId,
          // so both sides must be consistent after a link change.

          const oldItem = editing;
          const linkChanged =
            !oldItem ||
            oldItem.linkedKind !== newItem.linkedKind ||
            oldItem.linkedId !== newItem.linkedId;

          if (linkChanged) {
            // Clear inventoryItemId from the old product (if remapping)
            if (oldItem && (oldItem.linkedKind !== newItem.linkedKind || oldItem.linkedId !== newItem.linkedId)) {
              if (oldItem.linkedKind === 'merch') {
                const p = merchItems.find((m) => m.id === oldItem.linkedId);
                if (p) mutators.upsertMerchItem({ ...p, inventoryItemId: undefined } as MerchItem);
              } else if (oldItem.linkedKind === 'addon') {
                const p = addOns.find((a) => a.id === oldItem.linkedId);
                if (p) mutators.upsertAddOn({ ...p, inventoryItemId: undefined } as AddOn);
              } else if (oldItem.linkedKind === 'menu') {
                const p = menuItems.find((m) => m.id === oldItem.linkedId);
                if (p) mutators.upsertMenuItem({ ...p, inventoryItemId: undefined } as MenuItem);
              }
            }

            // Set inventoryItemId on the new linked product
            if (newItem.linkedKind === 'merch') {
              const p = merchItems.find((m) => m.id === newItem.linkedId);
              if (p) mutators.upsertMerchItem({ ...p, inventoryItemId: newItem.id });
            } else if (newItem.linkedKind === 'addon') {
              const p = addOns.find((a) => a.id === newItem.linkedId);
              if (p) mutators.upsertAddOn({ ...p, inventoryItemId: newItem.id });
            } else if (newItem.linkedKind === 'menu') {
              const p = menuItems.find((m) => m.id === newItem.linkedId);
              if (p) mutators.upsertMenuItem({ ...p, inventoryItemId: newItem.id });
            }
          }

          setFormOpen(false);
        }}
      />

      {adjusting && (
        <StockAdjustModal
          open
          itemName={adjusting.item.name}
          variantLabel={adjusting.variant.label}
          currentStock={adjusting.variant.stock}
          onClose={() => setAdjusting(null)}
          onAdjust={handleAdjust}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-foreground/50 hover:text-foreground/80'
      }`}
    >
      {children}
    </button>
  );
}
