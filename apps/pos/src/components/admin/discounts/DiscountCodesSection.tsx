import { useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  Percent,
  Banknote,
  Download,
  Gift,
  ToggleLeft,
  ToggleRight,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { QrCode } from '@/components/till/QrCode';
import type { Discount, DiscountTarget } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { formatDiscountTargetLabel } from '@/lib/discountTarget';
import { formatWWPrice } from '@/lib/pricingMode';
import { Field, TextInput, SelectInput } from './fields';
import { DiscountTargetPicker } from './DiscountTargetPicker';
import { downloadDiscountQr } from './qrDownload';

interface DraftState {
  originalCode: string | null;
  code: string;
  label: string;
  type: Discount['type'];
  value: string;
  target: DiscountTarget;
  active: boolean;
  stackable: boolean;
  validFrom: string;
  validUntil: string;
  usageLimit: string;
  perCustomerLimit: string;
  freeItemId: string;
  freeItemKind: 'menu' | 'merch';
}

const emptyDraft: DraftState = {
  originalCode: null,
  code: '',
  label: '',
  type: 'percent',
  value: '',
  target: { kind: 'everything' },
  active: true,
  stackable: false,
  validFrom: '',
  validUntil: '',
  usageLimit: '',
  perCustomerLimit: '',
  freeItemId: '',
  freeItemKind: 'menu',
};

function fmtValue(d: Discount): string {
  if (d.type === 'free_item') return 'Free';
  return d.type === 'percent' ? `${d.value}%` : `฿${d.value}`;
}

function typeIcon(d: Discount) {
  if (d.type === 'free_item') return <Gift className="w-4 h-4" />;
  if (d.type === 'percent') return <Percent className="w-4 h-4" />;
  return <Banknote className="w-4 h-4" />;
}

export function DiscountCodesSection() {
  const { discounts, menuItems, merchItems, mutators } = useCatalogStore();
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const startAdd = () => setDraft({ ...emptyDraft });
  const startEdit = (d: Discount) =>
    setDraft({
      originalCode: d.code,
      code: d.code,
      label: d.label,
      type: d.type ?? 'percent',
      value: d.type === 'free_item' ? '0' : String(d.value),
      target: d.target ?? { kind: 'everything' },
      active: d.active !== false,
      stackable: d.stackable === true,
      validFrom: d.validFrom ?? '',
      validUntil: d.validUntil ?? '',
      usageLimit: d.usageLimit != null ? String(d.usageLimit) : '',
      perCustomerLimit: d.perCustomerLimit != null ? String(d.perCustomerLimit) : '',
      freeItemId: d.freeItemId ?? '',
      freeItemKind: d.freeItemKind ?? 'menu',
    });
  const cancel = () => setDraft(null);

  const trimmedCode = draft?.code.trim().toUpperCase() ?? '';
  const trimmedLabel = draft?.label.trim() ?? '';
  const isFreeItem = draft?.type === 'free_item';
  const numericValue = isFreeItem ? 0 : (draft ? Number(draft.value) : NaN);

  const codeError = !trimmedCode
    ? 'Code is required.'
    : draft &&
        draft.originalCode?.toUpperCase() !== trimmedCode &&
        discounts.some((d) => d.code.toUpperCase() === trimmedCode)
      ? 'That code already exists.'
      : '';
  const labelError = !trimmedLabel ? 'Label is required.' : '';
  const valueError = isFreeItem
    ? ''
    : draft?.value.trim() === '' || Number.isNaN(numericValue)
      ? 'Enter a value.'
      : numericValue < 0
        ? 'Value cannot be negative.'
        : draft?.type === 'percent' && numericValue > 100
          ? 'Percent cannot exceed 100.'
          : '';
  const freeItemError = isFreeItem && !draft?.freeItemId
    ? 'Select a free item.'
    : '';
  const usageLimitNum = draft?.usageLimit ? Number(draft.usageLimit) : undefined;
  const perCustLimitNum = draft?.perCustomerLimit ? Number(draft.perCustomerLimit) : undefined;
  const usageLimitError =
    draft?.usageLimit && (Number.isNaN(usageLimitNum) || (usageLimitNum ?? 0) < 1)
      ? 'Must be a positive number.'
      : '';
  const perCustLimitError =
    draft?.perCustomerLimit && (Number.isNaN(perCustLimitNum) || (perCustLimitNum ?? 0) < 1)
      ? 'Must be a positive number.'
      : '';
  const dateError =
    draft?.validFrom && draft?.validUntil && draft.validUntil < draft.validFrom
      ? '"Valid until" must be after "Valid from".'
      : '';

  const canSave =
    !codeError && !labelError && !valueError && !freeItemError &&
    !usageLimitError && !perCustLimitError && !dateError;

  const save = () => {
    if (!draft || !canSave) return;
    if (
      draft.originalCode &&
      draft.originalCode.toUpperCase() !== trimmedCode
    ) {
      mutators.deleteDiscount(draft.originalCode);
    }

    // Preserve usage counters from the existing discount so an admin edit
    // does not reset usedCount or per-customer usage history.
    const existing = discounts.find(
      (d) => d.code.toUpperCase() === trimmedCode
    ) ?? (draft.originalCode
      ? discounts.find((d) => d.code.toUpperCase() === draft.originalCode!.toUpperCase())
      : undefined);

    const payload: Discount = {
      code: trimmedCode,
      label: trimmedLabel,
      type: draft.type,
      value: numericValue,
      // For free_item: target auto-derived from item kind (menu → menuItems target;
      // merch has no dedicated target kind so falls back to everything).
      target: isFreeItem
        ? draft.freeItemKind === 'menu'
          ? { kind: 'menuItems', menuItemIds: [draft.freeItemId] }
          : { kind: 'everything' }
        : draft.target,
      active: draft.active,
      ...(draft.stackable ? { stackable: true } : {}),
      ...(draft.validFrom ? { validFrom: draft.validFrom } : {}),
      ...(draft.validUntil ? { validUntil: draft.validUntil } : {}),
      ...(usageLimitNum != null ? { usageLimit: usageLimitNum } : {}),
      ...(perCustLimitNum != null ? { perCustomerLimit: perCustLimitNum } : {}),
      ...(isFreeItem && draft.freeItemId
        ? {
            freeItemId: draft.freeItemId,
            freeItemKind: draft.freeItemKind,
          }
        : {}),
      // Carry forward live usage counters — never wipe on admin edit.
      ...(existing?.usedCount != null ? { usedCount: existing.usedCount } : {}),
      ...(existing?.perCustomerUsage && Object.keys(existing.perCustomerUsage).length > 0
        ? { perCustomerUsage: existing.perCustomerUsage }
        : {}),
    };
    mutators.upsertDiscount(payload);
    setDraft(null);
  };

  const confirmDelete = (code: string) => {
    mutators.deleteDiscount(code);
    setPendingDelete(null);
  };

  const activeMenuItems = menuItems;
  const activeMerchItems = merchItems.filter((m) => m.active);
  // Combined catalog for display-name lookup (list view).
  const allFreeItems = [...menuItems, ...merchItems];

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Discount codes</h2>
          <p className="text-sm text-foreground/50">
            Percentage, fixed, or free-item promo codes. Set validity windows,
            usage caps, and per-customer limits. Each code has a downloadable QR.
          </p>
        </div>
        {!draft && (
          <Button onClick={startAdd} size="sm">
            <Plus className="w-4 h-4" />
            Add code
          </Button>
        )}
      </div>

      {/* Add / edit form */}
      {draft && (
        <div className="mt-5 rounded-2xl border border-primary/30 bg-primary/[0.06] p-4 sm:p-5 space-y-4">

          {/* Row 1: Code + Label */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Code" htmlFor="disc-code" error={codeError}>
              <TextInput
                id="disc-code"
                value={draft.code}
                invalid={!!codeError}
                placeholder="ICECREAM50"
                autoCapitalize="characters"
                onChange={(e) =>
                  setDraft({ ...draft, code: e.target.value.toUpperCase() })
                }
              />
            </Field>
            <Field label="Label" htmlFor="disc-label" error={labelError}>
              <TextInput
                id="disc-label"
                value={draft.label}
                invalid={!!labelError}
                placeholder="Free ice cream promo"
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </Field>
          </div>

          {/* Row 2: Type + Value / Free item picker */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="disc-type">
              <SelectInput
                id="disc-type"
                value={draft.type}
                onChange={(e) =>
                  setDraft({ ...draft, type: e.target.value as Discount['type'], value: '', freeItemId: '' })
                }
              >
                <option value="percent">Percent (%)</option>
                <option value="fixed">Fixed (฿)</option>
                <option value="free_item">Free item</option>
              </SelectInput>
            </Field>
            {isFreeItem ? (
              <Field label="Free item" htmlFor="disc-free-item" error={freeItemError}>
                <SelectInput
                  id="disc-free-item"
                  value={draft.freeItemId}
                  onChange={(e) => {
                    const id = e.target.value;
                    const isMerch = activeMerchItems.some((m) => m.id === id);
                    setDraft({
                      ...draft,
                      freeItemId: id,
                      freeItemKind: isMerch ? 'merch' : 'menu',
                    });
                  }}
                >
                  <option value="">— select item —</option>
                  <optgroup label="Menu items">
                    {activeMenuItems.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} — {formatWWPrice(m.price)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Merch">
                    {activeMerchItems.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} — {formatWWPrice(m.price)}
                      </option>
                    ))}
                  </optgroup>
                </SelectInput>
              </Field>
            ) : (
              <Field
                label={draft.type === 'percent' ? 'Value (%)' : 'Value (฿)'}
                htmlFor="disc-value"
                error={valueError}
                hint={
                  draft.type === 'percent' && Number(draft.value) === 100
                    ? 'Tip: use "Free item" type for cleaner free-item promos.'
                    : undefined
                }
              >
                <TextInput
                  id="disc-value"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={draft.type === 'percent' ? 100 : undefined}
                  value={draft.value}
                  invalid={!!valueError}
                  placeholder="10"
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                />
              </Field>
            )}
          </div>

          {/* Validity window */}
          <div className="border-t border-foreground/10 pt-4">
            <p className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-3">
              Validity window (optional)
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Valid from" htmlFor="disc-from">
                <TextInput
                  id="disc-from"
                  type="date"
                  value={draft.validFrom}
                  onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })}
                />
              </Field>
              <Field label="Valid until" htmlFor="disc-until" error={dateError}>
                <TextInput
                  id="disc-until"
                  type="date"
                  value={draft.validUntil}
                  invalid={!!dateError}
                  onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })}
                />
              </Field>
            </div>
          </div>

          {/* Usage limits */}
          <div className="border-t border-foreground/10 pt-4">
            <p className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-3">
              Usage limits (optional — leave blank for unlimited)
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Total uses" htmlFor="disc-usage-limit" error={usageLimitError}
                hint="Max total redemptions across all customers.">
                <TextInput
                  id="disc-usage-limit"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={draft.usageLimit}
                  invalid={!!usageLimitError}
                  placeholder="e.g. 100"
                  onChange={(e) => setDraft({ ...draft, usageLimit: e.target.value })}
                />
              </Field>
              <Field label="Per customer" htmlFor="disc-per-cust" error={perCustLimitError}
                hint="Max uses per phone number.">
                <TextInput
                  id="disc-per-cust"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={draft.perCustomerLimit}
                  invalid={!!perCustLimitError}
                  placeholder="e.g. 1"
                  onChange={(e) => setDraft({ ...draft, perCustomerLimit: e.target.value })}
                />
              </Field>
            </div>
          </div>

          {/* Scope / target (hidden for free_item — auto-derived from the item) */}
          {!isFreeItem && (
            <div className="border-t border-foreground/10 pt-4">
              <DiscountTargetPicker
                value={draft.target}
                onChange={(target) => setDraft({ ...draft, target })}
              />
            </div>
          )}

          {/* Active toggle */}
          <div className="border-t border-foreground/10 pt-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-foreground/50">
                Inactive codes are rejected at checkout without revealing they exist.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, active: !draft.active })}
              className="text-primary"
              aria-label={draft.active ? 'Deactivate code' : 'Activate code'}
            >
              {draft.active
                ? <ToggleRight className="w-8 h-8" />
                : <ToggleLeft className="w-8 h-8 text-foreground/30" />}
            </button>
          </div>

          {/* Stackable toggle */}
          <div className="border-t border-foreground/10 pt-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Stackable</p>
              <p className="text-xs text-foreground/50">
                Allow combining with other codes. Multiple codes apply only when every
                code on the cart — including this one — is stackable.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, stackable: !draft.stackable })}
              className="text-primary"
              aria-label={draft.stackable ? 'Make exclusive' : 'Make stackable'}
            >
              {draft.stackable
                ? <ToggleRight className="w-8 h-8" />
                : <ToggleLeft className="w-8 h-8 text-foreground/30" />}
            </button>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={cancel}>
              <X className="w-4 h-4" />
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!canSave}>
              <Check className="w-4 h-4" />
              {draft.originalCode ? 'Save changes' : 'Add code'}
            </Button>
          </div>
        </div>
      )}

      {/* Codes list */}
      <div className="mt-5 flex flex-col gap-2">
        {discounts.length === 0 && (
          <p className="rounded-2xl border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-foreground/40">
            No discount codes yet. Add one above.
          </p>
        )}
        {discounts.map((d) => {
          const usedCount = d.usedCount ?? 0;
          const hasLimit = d.usageLimit != null;
          const isExpired = d.validUntil
            ? new Date().toISOString().slice(0, 10) > d.validUntil
            : false;
          const isNotYetValid = d.validFrom
            ? new Date().toISOString().slice(0, 10) < d.validFrom
            : false;
          const isInactive = d.active === false;

          return (
            <div
              key={d.code}
              className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${
                isInactive || isExpired
                  ? 'border-foreground/10 bg-black/10 opacity-60'
                  : 'border-foreground/10 bg-black/20'
              }`}
            >
              {/* QR preview */}
              <QrCode seed={d.code} className="h-14 w-14 sm:h-16 sm:w-16" />

              {/* Type icon */}
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-foreground/5 text-foreground/70">
                {typeIcon(d)}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-bold tracking-wide">
                    {d.code}
                  </span>
                  <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-semibold text-foreground/60">
                    {fmtValue(d)}
                  </span>
                  <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
                    {d.type === 'free_item'
                      ? `Free: ${allFreeItems.find((m) => m.id === d.freeItemId)?.name ?? d.freeItemId ?? 'item'}`
                      : formatDiscountTargetLabel(d.target)}
                  </span>
                  {isInactive && (
                    <span className="rounded-full bg-rose-400/10 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
                      Inactive
                    </span>
                  )}
                  {!isInactive && isExpired && (
                    <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                      Expired
                    </span>
                  )}
                  {!isInactive && isNotYetValid && (
                    <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                      Not yet valid
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-0.5">
                  <span className="truncate text-xs text-foreground/50">{d.label}</span>
                  {(hasLimit || d.perCustomerLimit != null || d.validFrom || d.validUntil) && (
                    <span className="flex items-center gap-1 text-[11px] text-foreground/40">
                      {hasLimit && (
                        <>
                          <Users className="w-3 h-3" />
                          {usedCount}/{d.usageLimit} used
                        </>
                      )}
                      {d.perCustomerLimit != null && (
                        <span className="ml-1">· {d.perCustomerLimit}/cust</span>
                      )}
                      {d.validFrom && <span className="ml-1">· from {d.validFrom}</span>}
                      {d.validUntil && <span>· until {d.validUntil}</span>}
                    </span>
                  )}
                </div>
              </div>

              {pendingDelete === d.code ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground/60">Delete?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => confirmDelete(d.code)}
                  >
                    Yes
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPendingDelete(null)}
                  >
                    No
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      downloadDiscountQr(d.code, `discount-${d.code}.png`, d.label)
                    }
                    aria-label={`Download QR for ${d.code}`}
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => startEdit(d)}
                    aria-label={`Edit ${d.code}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(d.code)}
                    aria-label={`Delete ${d.code}`}
                    className="text-rose-300 hover:text-rose-200"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
