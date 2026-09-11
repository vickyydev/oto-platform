import { useEffect, useRef, useState } from 'react';
import { Trash2, Plus, X, ImagePlus, ShoppingCart, AlertCircle } from 'lucide-react';
import {
  InventoryItem,
  InventoryVariant,
  StockUnit,
  StockLocation,
  INVENTORY_DEFAULT_VARIANT_ID,
  ReorderSettings,
  MerchItem,
  AddOn,
  MenuItem,
} from '@/types';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface InventoryItemFormDialogProps {
  open: boolean;
  item: InventoryItem | null;
  stockLocations: StockLocation[];
  merchItems: MerchItem[];
  addOns: AddOn[];
  menuItems: MenuItem[];
  onClose: () => void;
  onSave: (item: InventoryItem) => void;
}

interface VariantRow {
  id: string;
  label: string;
  sku: string;
  /** Reference to the sellable product's variant identifier — documents which
   *  product variant (by label or ID) this inventory variant maps to.
   *  Consumed by the backend swap seam when products gain formal variants. */
  productVariantRef: string;
  stock: string;
  threshold: string;
  /** locationId → par string value */
  parByLoc: Record<string, string>;
  /** Per-location stock counts carried through from the original variant so that
   *  admin saves do not erase location-tracked stock state. Set by fromVariant;
   *  always undefined for newly-added variants (they start at 0 per location). */
  stockByLocation?: Record<string, number>;
}

interface UnitRow {
  id: string;
  label: string;
  eaches: string;
}

const blankVariantRow = (id: string): VariantRow => ({
  id,
  label: '',
  sku: '',
  productVariantRef: '',
  stock: '0',
  threshold: '',
  parByLoc: {},
});

const fromVariant = (v: InventoryVariant): VariantRow => {
  const parByLoc: Record<string, string> = {};
  if (v.parByLocation) {
    for (const [locId, val] of Object.entries(v.parByLocation)) {
      parByLoc[locId] = String(val);
    }
  }
  return {
    id: v.id,
    label: v.label,
    sku: v.sku ?? '',
    productVariantRef: v.productVariantRef ?? '',
    stock: String(v.stock),
    threshold: v.lowStockThreshold != null ? String(v.lowStockThreshold) : '',
    parByLoc,
    // Carry stockByLocation through unchanged — admin edits must not erase
    // location-tracked stock. Dedicated location-stock ops (transfer, stock-take)
    // are the correct path for adjusting per-location counts.
    stockByLocation: v.stockByLocation,
  };
};

const fromUnit = (u: StockUnit): UnitRow => ({
  id: u.id,
  label: u.label,
  eaches: String(u.eaches),
});

const blankUnitRow = (): UnitRow => ({
  id: `u-${Math.random().toString(36).slice(2, 7)}`,
  label: '',
  eaches: '1',
});

/**
 * Create/edit dialog for a unified InventoryItem. Supports:
 * - Basic fields: name, SKU, category, active flag
 * - Multiple named variants with per-variant SKU
 * - Pack/unit definitions (Case = 24, Dozen = 12…)
 * - Per-location par levels for ALL active stock locations
 * - Unit cost with "unset" warning
 * - Reorder settings (supplier, point, lead time, default qty)
 * - Linked sellable-product selection from catalog
 */
export function InventoryItemFormDialog({
  open,
  item,
  stockLocations,
  merchItems,
  addOns,
  menuItems,
  onClose,
  onSave,
}: InventoryItemFormDialogProps) {
  // Basics
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('');
  const [active, setActive] = useState(true);

  // Linked product
  const [linkedKind, setLinkedKind] = useState<'merch' | 'addon' | 'menu'>('merch');
  const [linkedId, setLinkedId] = useState('');

  // Variants
  const [variants, setVariants] = useState<VariantRow[]>([
    blankVariantRow(INVENTORY_DEFAULT_VARIANT_ID),
  ]);

  // Units
  const [units, setUnits] = useState<UnitRow[]>([]);

  // Photo
  const [photoUrl, setPhotoUrl] = useState('');
  const [showPhotoInPos, setShowPhotoInPos] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Unit cost
  const [unitCostTHB, setUnitCostTHB] = useState('');

  // Reorder settings
  const [reorderEnabled, setReorderEnabled] = useState(false);
  const [reorderPoint, setReorderPoint] = useState('');
  const [leadTimeDays, setLeadTimeDays] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [supplierContact, setSupplierContact] = useState('');
  // When no pack units are defined: plain eaches value.
  // When pack units are defined: packs are entered per unit; reorderQty is
  // derived on save. reorderQtyPacks maps unitId → pack count string.
  const [reorderQty, setReorderQty] = useState('');
  const [reorderQtyPacks, setReorderQtyPacks] = useState<Record<string, string>>({});
  const [reorderQtyRemainder, setReorderQtyRemainder] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Active stock locations (for par inputs)
  const activeLocations = stockLocations.filter((l) => l.active);

  /**
   * Decompose a total-eaches value into pack counts + remainder using the
   * provided unit list (sorted by eaches descending, greedy fill).
   * Returns { packs: Record<unitId, count>, remainder: number }.
   */
  const decomposeEaches = (
    totalEaches: number,
    unitList: UnitRow[]
  ): { packs: Record<string, string>; remainder: string } => {
    const sorted = [...unitList].sort((a, b) => Number(b.eaches) - Number(a.eaches));
    const packs: Record<string, string> = {};
    let remaining = Math.max(0, Math.round(totalEaches));
    for (const u of sorted) {
      const each = Math.round(Number(u.eaches) || 1);
      const count = Math.floor(remaining / each);
      packs[u.id] = String(count);
      remaining -= count * each;
    }
    return { packs, remainder: String(remaining) };
  };

  /**
   * Compute total eaches from current pack counts + remainder.
   * Used both for display and on validate when units exist.
   */
  const computePackTotal = (
    packCounts: Record<string, string>,
    remainder: string,
    unitList: UnitRow[]
  ): number => {
    let total = Math.max(0, Math.round(Number(remainder) || 0));
    for (const u of unitList) {
      total += Math.max(0, Math.round(Number(packCounts[u.id] || 0))) * Math.round(Number(u.eaches) || 1);
    }
    return total;
  };

  const resetReorderQtyFields = (totalEaches: number, unitList: UnitRow[]) => {
    if (unitList.length > 0) {
      const { packs, remainder } = decomposeEaches(totalEaches, unitList);
      setReorderQtyPacks(packs);
      setReorderQtyRemainder(remainder);
      setReorderQty('');
    } else {
      setReorderQtyPacks({});
      setReorderQtyRemainder('');
      setReorderQty(totalEaches > 0 ? String(totalEaches) : '');
    }
  };

  useEffect(() => {
    if (!open) return;
    if (item) {
      setName(item.name);
      setSku(item.sku ?? '');
      setCategory(item.category ?? '');
      setActive(item.active !== false);
      setLinkedKind(item.linkedKind);
      setLinkedId(item.linkedId);
      setVariants(item.variants.map(fromVariant));
      const unitList = item.units ? item.units.map(fromUnit) : [];
      setUnits(unitList);
      setPhotoUrl(item.photoUrl ?? '');
      setShowPhotoInPos(item.showPhotoInPos ?? false);
      setUnitCostTHB(item.unitCostTHB != null ? String(item.unitCostTHB) : '');
      const rs = item.reorderSettings;
      if (rs) {
        setReorderEnabled(true);
        setReorderPoint(String(rs.reorderPoint));
        setLeadTimeDays(String(rs.leadTimeDays));
        setSupplierName(rs.supplierName);
        setSupplierContact(rs.supplierContact ?? '');
        resetReorderQtyFields(rs.reorderQty, unitList);
      } else {
        setReorderEnabled(false);
        setReorderPoint('');
        setLeadTimeDays('');
        setSupplierName('');
        setSupplierContact('');
        setReorderQty('');
        setReorderQtyPacks({});
        setReorderQtyRemainder('');
      }
    } else {
      setName('');
      setSku('');
      setCategory('');
      setActive(true);
      setLinkedKind('merch');
      setLinkedId('');
      setVariants([blankVariantRow(INVENTORY_DEFAULT_VARIANT_ID)]);
      setUnits([]);
      setPhotoUrl('');
      setShowPhotoInPos(false);
      setUnitCostTHB('');
      setReorderEnabled(false);
      setReorderPoint('');
      setReorderQtyPacks({});
      setReorderQtyRemainder('');
      setLeadTimeDays('');
      setSupplierName('');
      setSupplierContact('');
      setReorderQty('');
    }
    setErrors({});
  }, [open, item]);

  const handlePhotoFile = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setPhotoUrl(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const updateVariant = (idx: number, field: keyof Omit<VariantRow, 'parByLoc'>, val: string) => {
    setVariants((prev) => prev.map((v, i) => (i === idx ? { ...v, [field]: val } : v)));
  };

  const updateVariantPar = (idx: number, locId: string, val: string) => {
    setVariants((prev) =>
      prev.map((v, i) =>
        i === idx ? { ...v, parByLoc: { ...v.parByLoc, [locId]: val } } : v
      )
    );
  };

  const addVariant = () => {
    const id = `v-${Math.random().toString(36).substring(2, 7)}`;
    setVariants((prev) => [...prev, blankVariantRow(id)]);
  };

  const removeVariant = (idx: number) => {
    if (variants.length <= 1) return;
    setVariants((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateUnit = (idx: number, field: keyof UnitRow, val: string) => {
    setUnits((prev) => prev.map((u, i) => (i === idx ? { ...u, [field]: val } : u)));
  };

  const addUnit = () => setUnits((prev) => [...prev, blankUnitRow()]);
  const removeUnit = (idx: number) => setUnits((prev) => prev.filter((_, i) => i !== idx));

  const validate = (): InventoryItem | null => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Name is required.';
    if (!linkedId.trim()) next.linkedId = 'Linked product is required.';

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (!v.label.trim()) next[`v${i}label`] = 'Label required.';
      if (v.stock.trim() === '' || isNaN(Number(v.stock)) || Number(v.stock) < 0)
        next[`v${i}stock`] = 'Stock must be ≥ 0.';
      if (v.threshold.trim() !== '' && (isNaN(Number(v.threshold)) || Number(v.threshold) < 0))
        next[`v${i}threshold`] = 'Threshold must be ≥ 0.';
      for (const [locId, parStr] of Object.entries(v.parByLoc)) {
        if (parStr.trim() !== '' && (isNaN(Number(parStr)) || Number(parStr) < 0))
          next[`v${i}par${locId}`] = 'Par must be ≥ 0.';
      }
    }

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.label.trim()) next[`u${i}label`] = 'Unit name required.';
      if (!u.eaches.trim() || isNaN(Number(u.eaches)) || Number(u.eaches) < 1)
        next[`u${i}eaches`] = 'Must be ≥ 1.';
    }

    if (reorderEnabled) {
      if (!supplierName.trim()) next.supplierName = 'Supplier name is required.';
      if (!reorderPoint.trim() || isNaN(Number(reorderPoint)) || Number(reorderPoint) < 0)
        next.reorderPoint = 'Reorder point must be ≥ 0.';
      if (!leadTimeDays.trim() || isNaN(Number(leadTimeDays)) || Number(leadTimeDays) < 1)
        next.leadTimeDays = 'Lead time must be ≥ 1 day.';
      if (units.length > 0) {
        // Pack-aware: compute total from pack counts + remainder
        const packTotal = computePackTotal(reorderQtyPacks, reorderQtyRemainder, units);
        if (packTotal < 1) next.reorderQty = 'Reorder qty must be at least 1 each. Enter packs or remaining eaches.';
      } else {
        if (!reorderQty.trim() || isNaN(Number(reorderQty)) || Number(reorderQty) < 1)
          next.reorderQty = 'Reorder qty must be ≥ 1.';
      }
    }

    if (Object.keys(next).length) { setErrors(next); return null; }

    const parsedVariants: InventoryVariant[] = variants.map((v) => {
      const parByLocation: Record<string, number> = {};
      for (const [locId, parStr] of Object.entries(v.parByLoc)) {
        if (parStr.trim()) parByLocation[locId] = Math.round(Number(parStr));
      }
      return {
        id: v.id,
        label: v.label.trim(),
        ...(v.sku.trim() ? { sku: v.sku.trim() } : {}),
        ...(v.productVariantRef.trim() ? { productVariantRef: v.productVariantRef.trim() } : {}),
        stock: Math.max(0, Math.round(Number(v.stock))),
        ...(v.threshold.trim() ? { lowStockThreshold: Math.round(Number(v.threshold)) } : {}),
        ...(Object.keys(parByLocation).length > 0 ? { parByLocation } : {}),
        // Carry location-tracked stock through unchanged so admin saves do not
        // erase per-location counts. The total `stock` field remains the
        // manager-visible on-hand count; stockByLocation is owned by stock ops.
        ...(v.stockByLocation ? { stockByLocation: v.stockByLocation } : {}),
      };
    });

    const parsedUnits: StockUnit[] | undefined =
      units.length > 0
        ? units.map((u) => ({
            id: u.id,
            label: u.label.trim(),
            eaches: Math.round(Number(u.eaches)),
          }))
        : undefined;

    const parsedReorderQty =
      units.length > 0
        ? computePackTotal(reorderQtyPacks, reorderQtyRemainder, units)
        : Math.round(Number(reorderQty));

    const parsedReorder: ReorderSettings | undefined = reorderEnabled
      ? {
          reorderPoint: Math.round(Number(reorderPoint)),
          leadTimeDays: Math.round(Number(leadTimeDays)),
          supplierName: supplierName.trim(),
          ...(supplierContact.trim() ? { supplierContact: supplierContact.trim() } : {}),
          reorderQty: parsedReorderQty,
        }
      : undefined;

    const parsedUnitCost =
      unitCostTHB.trim() !== '' && !isNaN(Number(unitCostTHB)) && Number(unitCostTHB) > 0
        ? Number(unitCostTHB)
        : undefined;

    const id = item?.id ?? `inv-${linkedId.trim().replace(/\s+/g, '-')}`;
    return {
      id,
      name: name.trim(),
      ...(sku.trim() ? { sku: sku.trim() } : {}),
      ...(category.trim() ? { category: category.trim() } : {}),
      active,
      linkedKind,
      linkedId: linkedId.trim(),
      variants: parsedVariants,
      ...(parsedUnits ? { units: parsedUnits } : {}),
      ...(photoUrl ? { photoUrl, showPhotoInPos } : {}),
      ...(parsedUnitCost != null ? { unitCostTHB: parsedUnitCost } : {}),
      ...(parsedReorder ? { reorderSettings: parsedReorder } : {}),
    };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validate();
    if (result) onSave(result);
  };

  const isSingleDefault =
    variants.length === 1 && variants[0].id === INVENTORY_DEFAULT_VARIANT_ID;

  // Linked product options by kind
  const linkedOptions = linkedKind === 'merch'
    ? merchItems.map((m) => ({ id: m.id, label: m.name }))
    : linkedKind === 'addon'
    ? addOns.map((a) => ({ id: a.id, label: a.name }))
    : menuItems.map((m) => ({ id: m.id, label: m.name }));

  const costIsUnset = unitCostTHB.trim() === '' || Number(unitCostTHB) <= 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit inventory item' : 'New inventory item'}</DialogTitle>
          <DialogDescription>
            Configure everything the stock module uses: basics, variants, par levels, units, cost, and reorder settings.
          </DialogDescription>
        </DialogHeader>

        <form id="inv-form" onSubmit={handleSubmit} className="flex flex-col gap-6 pt-1">

          {/* ── Basics ── */}
          <section className="flex flex-col gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Basics</h3>

            {/* Name + Active toggle */}
            <div className="flex items-start gap-3">
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="inv-name">Display name *</Label>
                <Input
                  id="inv-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Grip Socks"
                />
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>
              <div className="flex flex-col gap-1.5 pt-0.5">
                <Label>Active</Label>
                <label className="flex items-center gap-2 h-9 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={(e) => setActive(e.target.checked)}
                    className="w-4 h-4 accent-primary"
                  />
                  <span className="text-sm">{active ? 'Active' : 'Retired'}</span>
                </label>
              </div>
            </div>

            {/* SKU + Category */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-sku">Item SKU (optional)</Label>
                <Input
                  id="inv-sku"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="e.g. OTO-SOCK"
                />
                <p className="text-[11px] text-foreground/40">Product-line code. Variants have their own SKUs below.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-category">Category (optional)</Label>
                <Input
                  id="inv-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Apparel"
                />
                <p className="text-[11px] text-foreground/40">For admin grouping and reports.</p>
              </div>
            </div>
          </section>

          {/* ── Product photo ── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Product photo</h3>
            <div className="flex items-start gap-3">
              {photoUrl ? (
                <div className="relative shrink-0">
                  <img
                    src={photoUrl}
                    alt="Product"
                    className="w-20 h-20 rounded-lg object-cover border border-foreground/10"
                  />
                  <button
                    type="button"
                    onClick={() => { setPhotoUrl(''); setShowPhotoInPos(false); }}
                    className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow"
                    aria-label="Remove photo"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-20 h-20 shrink-0 rounded-lg border border-dashed border-foreground/25 flex flex-col items-center justify-center gap-1 text-foreground/40 hover:text-foreground/70 hover:border-foreground/40 transition-colors"
                >
                  <ImagePlus className="w-5 h-5" />
                  <span className="text-[10px] font-medium">Add photo</span>
                </button>
              )}
              <div className="flex flex-col gap-2 pt-1">
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showPhotoInPos}
                    disabled={!photoUrl}
                    onChange={(e) => setShowPhotoInPos(e.target.checked)}
                    className="w-4 h-4 accent-primary disabled:opacity-40"
                  />
                  Show photo in POS
                </label>
                <p className="text-[11px] text-foreground/40 max-w-[260px]">
                  Always shown in Inventory and the stock module. Tick to also show it on the sell tile in the POS.
                </p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                handlePhotoFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </section>

          {/* ── Linked product ── */}
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Linked sellable product</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-kind">Product type *</Label>
                <select
                  id="inv-kind"
                  value={linkedKind}
                  onChange={(e) => {
                    setLinkedKind(e.target.value as 'merch' | 'addon' | 'menu');
                    setLinkedId('');
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  <option value="merch">Merch item</option>
                  <option value="addon">Add-on</option>
                  <option value="menu">F&B menu item</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-linkedid">Product *</Label>
                <select
                  id="inv-linkedid"
                  value={linkedId}
                  onChange={(e) => setLinkedId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  <option value="">— pick a product —</option>
                  {linkedOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label} ({opt.id})</option>
                  ))}
                </select>
                {errors.linkedId && <p className="text-xs text-destructive">{errors.linkedId}</p>}
              </div>
            </div>
            <p className="text-[11px] text-foreground/40">
              Sales of the linked product decrement this inventory item's stock. One inventory item per sellable product. Changing the linked product on an existing item remaps stock tracking.
            </p>
          </section>

          {/* ── Variants ── */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Variants &amp; par levels</h3>
              {!isSingleDefault && (
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={addVariant}>
                  <Plus className="w-3.5 h-3.5" />
                  Add variant
                </Button>
              )}
            </div>

            {variants.map((v, i) => (
              <div
                key={v.id}
                className="rounded-lg border border-foreground/10 p-3 flex flex-col gap-3"
              >
                {/* Row 1: Label + SKU + Threshold + Remove */}
                <div className="flex items-start gap-2">
                  <div className="flex-1 flex flex-col gap-1">
                    <Label className="text-[10px] text-foreground/40 uppercase tracking-wider">Label *</Label>
                    <Input
                      value={v.label}
                      onChange={(e) => updateVariant(i, 'label', e.target.value)}
                      placeholder={isSingleDefault ? 'Default' : 'S / M / L…'}
                    />
                    {errors[`v${i}label`] && (
                      <p className="text-xs text-destructive">{errors[`v${i}label`]}</p>
                    )}
                  </div>
                  <div className="w-28 flex flex-col gap-1">
                    <Label className="text-[10px] text-foreground/40 uppercase tracking-wider">Variant SKU</Label>
                    <Input
                      value={v.sku}
                      onChange={(e) => updateVariant(i, 'sku', e.target.value)}
                      placeholder="e.g. OTO-SK-M"
                    />
                  </div>
                  <div className="w-36 flex flex-col gap-1">
                    <Label className="text-[10px] text-foreground/40 uppercase tracking-wider">Product variant ref</Label>
                    <Input
                      value={v.productVariantRef}
                      onChange={(e) => updateVariant(i, 'productVariantRef', e.target.value)}
                      placeholder="e.g. Medium"
                      title="The label or ID of the product variant this inventory variant maps to. Used when the linked product has formal variants."
                    />
                  </div>
                  <div className="w-20 flex flex-col gap-1">
                    <Label className="text-[10px] text-foreground/40 uppercase tracking-wider">Total stock</Label>
                    <Input
                      type="number"
                      min={0}
                      value={v.stock}
                      onChange={(e) => updateVariant(i, 'stock', e.target.value)}
                    />
                    {errors[`v${i}stock`] && (
                      <p className="text-xs text-destructive">{errors[`v${i}stock`]}</p>
                    )}
                  </div>
                  <div className="w-20 flex flex-col gap-1">
                    <Label className="text-[10px] text-foreground/40 uppercase tracking-wider">Alert at</Label>
                    <Input
                      type="number"
                      min={0}
                      value={v.threshold}
                      onChange={(e) => updateVariant(i, 'threshold', e.target.value)}
                      placeholder="—"
                    />
                    {errors[`v${i}threshold`] && (
                      <p className="text-xs text-destructive">{errors[`v${i}threshold`]}</p>
                    )}
                  </div>
                  {variants.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-5 h-8 w-8 text-destructive shrink-0"
                      onClick={() => removeVariant(i)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  ) : (
                    <div className="w-8 shrink-0" />
                  )}
                </div>

                {/* Row 2: Per-location par inputs */}
                {activeLocations.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-[10px] text-foreground/40 font-semibold uppercase tracking-wider">
                      Par levels (target qty per location)
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {activeLocations.map((loc) => (
                        <div key={loc.id} className="flex flex-col gap-1 w-28">
                          <Label className="text-[10px] text-foreground/50 truncate" title={loc.name}>
                            {loc.name}
                            {loc.sellPoint && (
                              <span className="ml-1 text-[9px] text-primary font-bold">SELL</span>
                            )}
                          </Label>
                          <Input
                            type="number"
                            min={0}
                            value={v.parByLoc[loc.id] ?? ''}
                            onChange={(e) => updateVariantPar(i, loc.id, e.target.value)}
                            placeholder="—"
                          />
                          {errors[`v${i}par${loc.id}`] && (
                            <p className="text-xs text-destructive">{errors[`v${i}par${loc.id}`]}</p>
                          )}
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-foreground/35">
                      Transfer suggestions fire when a location's stock drops below its par. Leave blank = no par set for that location.
                    </p>
                  </div>
                )}
              </div>
            ))}

            {isSingleDefault && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 self-start text-xs"
                onClick={addVariant}
              >
                <Plus className="w-3.5 h-3.5" />
                Add size variants (S / M / L…)
              </Button>
            )}
          </section>

          {/* ── Pack / unit definitions ── */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Pack units</h3>
                <p className="text-[11px] text-foreground/40 mt-0.5">
                  e.g. Case = 24, Dozen = 12. Enables "1 Case + 3" entry at receive/transfer.
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs shrink-0" onClick={addUnit}>
                <Plus className="w-3.5 h-3.5" />
                Add unit
              </Button>
            </div>

            {units.length > 0 && (
              <div className="flex flex-col gap-2">
                {units.map((u, i) => (
                  <div
                    key={u.id}
                    className="grid grid-cols-[1fr_80px_auto] gap-2 items-start rounded-lg border border-foreground/10 p-3"
                  >
                    <div className="flex flex-col gap-1">
                      <Label className="text-[11px] text-foreground/50">Unit name</Label>
                      <Input
                        value={u.label}
                        onChange={(e) => updateUnit(i, 'label', e.target.value)}
                        placeholder="Case / Dozen…"
                      />
                      {errors[`u${i}label`] && (
                        <p className="text-xs text-destructive">{errors[`u${i}label`]}</p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-[11px] text-foreground/50">Eaches</Label>
                      <Input
                        type="number"
                        min={1}
                        value={u.eaches}
                        onChange={(e) => updateUnit(i, 'eaches', e.target.value)}
                        placeholder="24"
                      />
                      {errors[`u${i}eaches`] && (
                        <p className="text-xs text-destructive">{errors[`u${i}eaches`]}</p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-5 h-8 w-8 text-destructive"
                      onClick={() => removeUnit(i)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Unit cost ── */}
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Unit cost</h3>
            <div className="relative max-w-[180px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-foreground/50">฿</span>
              <Input
                id="inv-unitcost"
                type="number"
                min={0}
                step="0.01"
                value={unitCostTHB}
                onChange={(e) => setUnitCostTHB(e.target.value)}
                placeholder="0.00"
                className="pl-7"
              />
            </div>
            {costIsUnset ? (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                No cost set — this item will show qty only (no value) in the Stock Value report.
              </div>
            ) : (
              <p className="text-[11px] text-foreground/40">
                Cost per each · used in the Stock Value report (cost × on-hand qty = value).
              </p>
            )}
          </section>

          {/* ── Reorder settings ── */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/40">
                  <ShoppingCart className="w-3.5 h-3.5 text-violet-400" />
                  Reorder settings
                  <span className="text-[10px] font-normal normal-case ml-1">(manager · optional)</span>
                </h3>
                <p className="text-[11px] text-foreground/40 mt-0.5">
                  When total on-hand ≤ reorder point the item appears in Stock → Suggestions as "Needs reordering".
                </p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none shrink-0 ml-4">
                <input
                  type="checkbox"
                  checked={reorderEnabled}
                  onChange={(e) => setReorderEnabled(e.target.checked)}
                  className="w-4 h-4 accent-primary"
                />
                <span className="text-sm">Enable</span>
              </label>
            </div>

            {reorderEnabled && (
              <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] p-4 flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="rs-supplier">Supplier name *</Label>
                    <Input
                      id="rs-supplier"
                      value={supplierName}
                      onChange={(e) => setSupplierName(e.target.value)}
                      placeholder="Bangkok Merch Co."
                    />
                    {errors.supplierName && <p className="text-xs text-destructive">{errors.supplierName}</p>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="rs-contact">Contact (optional)</Label>
                    <Input
                      id="rs-contact"
                      value={supplierContact}
                      onChange={(e) => setSupplierContact(e.target.value)}
                      placeholder="phone / email / LINE"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="rs-point">Reorder point *</Label>
                    <Input
                      id="rs-point"
                      type="number"
                      min={0}
                      value={reorderPoint}
                      onChange={(e) => setReorderPoint(e.target.value)}
                      placeholder="20"
                    />
                    <p className="text-[10px] text-foreground/40">total eaches on hand</p>
                    {errors.reorderPoint && <p className="text-xs text-destructive">{errors.reorderPoint}</p>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="rs-leadtime">Lead time (days) *</Label>
                    <Input
                      id="rs-leadtime"
                      type="number"
                      min={1}
                      value={leadTimeDays}
                      onChange={(e) => setLeadTimeDays(e.target.value)}
                      placeholder="7"
                    />
                    <p className="text-[10px] text-foreground/40">order → delivery</p>
                    {errors.leadTimeDays && <p className="text-xs text-destructive">{errors.leadTimeDays}</p>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="rs-qty">Default order qty *</Label>
                    {units.length > 0 ? (
                      /* Pack-aware input: one field per pack unit + eaches remainder */
                      <div className="flex flex-col gap-2">
                        {units.map((u) => (
                          <div key={u.id} className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              value={reorderQtyPacks[u.id] ?? '0'}
                              onChange={(e) =>
                                setReorderQtyPacks((prev) => ({ ...prev, [u.id]: e.target.value }))
                              }
                              className="w-20"
                              aria-label={`${u.label} count`}
                            />
                            <span className="text-xs text-foreground/60 shrink-0">
                              {u.label} ({u.eaches} ea)
                            </span>
                          </div>
                        ))}
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={0}
                            value={reorderQtyRemainder}
                            onChange={(e) => setReorderQtyRemainder(e.target.value)}
                            className="w-20"
                            aria-label="Remaining eaches"
                          />
                          <span className="text-xs text-foreground/60 shrink-0">eaches</span>
                        </div>
                        <p className="text-[10px] text-foreground/40">
                          Total: {computePackTotal(reorderQtyPacks, reorderQtyRemainder, units)} eaches
                        </p>
                      </div>
                    ) : (
                      <Input
                        id="rs-qty"
                        type="number"
                        min={1}
                        value={reorderQty}
                        onChange={(e) => setReorderQty(e.target.value)}
                        placeholder="48"
                      />
                    )}
                    {units.length === 0 && (
                      <p className="text-[10px] text-foreground/40">eaches</p>
                    )}
                    {errors.reorderQty && <p className="text-xs text-destructive">{errors.reorderQty}</p>}
                  </div>
                </div>

                <p className="text-[11px] text-foreground/35 leading-relaxed">
                  <span className="font-medium text-foreground/50">Future:</span> auto-trigger will use stock ≤ usage rate × lead time
                  once consumption history is tracked server-side. This prototype uses the static reorder point.
                </p>
              </div>
            )}
          </section>
        </form>

        <DialogFooter className="mt-4">
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="inv-form">
            {item ? 'Save changes' : 'Create item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
