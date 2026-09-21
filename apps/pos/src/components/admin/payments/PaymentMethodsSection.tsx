import { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { countTransactionsUsingPaymentMethod } from '@/mockApi';
import type { PaymentMethod, PaymentMethodKind } from '@/types';
import { paymentMethodIcon, normalizePaymentMethod } from '@/lib/payments';
import { NotSavedNotice } from '../NotSavedNotice';
import { TextInput } from '../discounts/fields';

const KIND_OPTIONS: { value: PaymentMethodKind; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card / EDC' },
  { value: 'qr', label: 'QR / PromptPay' },
  { value: 'other', label: 'Other' },
];

// Slug a label into a stable token id, kept unique against existing methods.
// Run through normalizePaymentMethod so a label like "Credit Card" can never
// mint the legacy `credit_card` token (it would collapse to `card` at read-time).
function makeId(label: string, taken: Set<string>): string {
  const base =
    normalizePaymentMethod(
      label
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, ''),
    ) || 'method';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

export function PaymentMethodsSection() {
  const { paymentMethods, mutators } = useCatalogStore();
  const [newLabel, setNewLabel] = useState('');
  const [newKind, setNewKind] = useState<PaymentMethodKind>('other');

  const sorted = [...paymentMethods].sort((a, b) => a.sortOrder - b.sortOrder);

  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    const taken = new Set(paymentMethods.map((m) => m.id));
    const id = makeId(label, taken);
    const sortOrder = sorted.length ? sorted[sorted.length - 1].sortOrder + 1 : 0;
    mutators.upsertPaymentMethod({ id, label, kind: newKind, enabled: true, sortOrder });
    setNewLabel('');
    setNewKind('other');
  };

  const patch = (m: PaymentMethod, fields: Partial<PaymentMethod>) =>
    mutators.upsertPaymentMethod({ ...m, ...fields });

  const remove = (m: PaymentMethod) => {
    const used = countTransactionsUsingPaymentMethod(m.id);
    if (used > 0) {
      const ok = window.confirm(
        `“${m.label}” is referenced by ${used} transaction${used === 1 ? '' : 's'}. ` +
          `Deleting it will leave those records labelled by their raw token in reports. ` +
          `Delete anyway? (Disabling it instead hides it at checkout but keeps reporting clean.)`,
      );
      if (!ok) return;
    }
    mutators.deletePaymentMethod(m.id);
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= sorted.length) return;
    const a = sorted[index];
    const b = sorted[target];
    // Swap their sort orders so the configured checkout order changes.
    patch(a, { sortOrder: b.sortOrder });
    patch(b, { sortOrder: a.sortOrder });
  };

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div className="mb-5">
        <NotSavedNotice
          mutators={['upsertPaymentMethod', 'deletePaymentMethod']}
          what="the tender list, its order and which methods are enabled"
        />
      </div>

      <div>
        <h2 className="text-lg font-bold">Payment methods</h2>
        <p className="text-sm text-foreground/50">
          The tenders staff can take at checkout (till, F&amp;B, parties, add-time).
          Order is the order shown to staff. Disable a method to hide it at
          checkout while keeping its history in reports.
        </p>
      </div>

      {/* Add row */}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <TextInput
          value={newLabel}
          placeholder="New method (e.g. Bank transfer)"
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="flex-1"
        />
        <select
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as PaymentMethodKind)}
          className="h-10 shrink-0 rounded-xl border border-foreground/10 bg-black/30 px-3 text-sm text-foreground/90 outline-none focus:border-foreground/30"
          aria-label="New method kind"
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <Button onClick={add} disabled={!newLabel.trim()} className="shrink-0">
          <Plus className="w-4 h-4" />
          Add
        </Button>
      </div>

      {/* Methods list */}
      <div className="mt-4 flex flex-col gap-2">
        {sorted.length === 0 && (
          <p className="rounded-2xl border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-foreground/40">
            No payment methods yet. Add one above.
          </p>
        )}
        {sorted.map((m, i) => {
          const Icon = paymentMethodIcon(m.kind);
          return (
            <div
              key={m.id}
              className={`flex items-center gap-2 rounded-2xl border border-foreground/10 bg-black/20 px-3 py-2 ${
                m.enabled ? '' : 'opacity-60'
              }`}
            >
              <GripVertical className="w-4 h-4 shrink-0 text-foreground/25" />
              <Icon className="w-4 h-4 shrink-0 text-foreground/50" />
              <TextInput
                value={m.label}
                onChange={(e) => patch(m, { label: e.target.value })}
                className="flex-1"
              />
              <select
                value={m.kind}
                onChange={(e) => patch(m, { kind: e.target.value as PaymentMethodKind })}
                className="h-10 shrink-0 rounded-xl border border-foreground/10 bg-black/30 px-2 text-sm text-foreground/90 outline-none focus:border-foreground/30"
                aria-label={`${m.label} kind`}
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <Button
                variant={m.enabled ? 'outline' : 'ghost'}
                size="sm"
                onClick={() => patch(m, { enabled: !m.enabled })}
                className="shrink-0"
              >
                {m.enabled ? 'Enabled' : 'Disabled'}
              </Button>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                >
                  <ChevronUp className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => move(i, 1)}
                  disabled={i === sorted.length - 1}
                  aria-label="Move down"
                >
                  <ChevronDown className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(m)}
                  aria-label="Remove method"
                  className="text-rose-300 hover:text-rose-200"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
