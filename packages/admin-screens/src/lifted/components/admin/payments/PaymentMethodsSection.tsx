import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, ChevronUp, ChevronDown, GripVertical } from "lucide-react";
import { Button } from "../../ui/button";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";

import { type PaymentMethod, type PaymentMethodKind } from "../../../model/types";

import { TextInput } from "../discounts/fields";
import { useMoneyCapabilities, type PaymentMethodsSectionPorts } from '../../../runtime/money';

const KIND_OPTIONS: { value: PaymentMethodKind; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card / EDC' },
  { value: 'qr', label: 'QR / PromptPay' },
  { value: 'other', label: 'Other' },
];

// Slug a label into a stable token id, kept unique against existing methods.
// Run through normalizePaymentMethod so a label like "Credit Card" can never
// mint the legacy `credit_card` token (it would collapse to `card` at read-time).
function makeId(label: string, taken: Set<string>, normalizePaymentMethod: (label: string) => string): string {
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
  const runtime = useAdminScreenRuntime();
  const { paymentMethods, mutators } = useCatalogStore();
  const scope = useMoneyCapabilities(runtime.transport, runtime.session.operator?.id, Boolean(runtime.branch.branch.apiId), runtime.session.operator, runtime.branch.branch.apiId);
  return <PaymentMethodsSectionWithPorts ports={{ paymentMethods, paymentMethodUsage: runtime.api.catalogBridge.paymentMethodUsage, normalizePaymentMethod: runtime.domain.payments.normalizePaymentMethod, paymentMethodIcon: runtime.domain.payments.paymentMethodIcon, ...mutators, canManage: scope.canManageTenders, authorityMessage: scope.authorityMessage }} />;
}

export function PaymentMethodsSectionWithPorts({ ports }: { ports: PaymentMethodsSectionPorts }) {
  const { paymentMethods, paymentMethodUsage, normalizePaymentMethod, paymentMethodIcon } = ports;
  const mutators = ports;
  const [newLabel, setNewLabel] = useState('');
  /**
   * The label being typed, held here until the field is left.
   *
   * The prototype wrote every keystroke straight into the store, which cost
   * nothing when the store was a variable in the tab. Each one is now a PATCH
   * and a re-read of the catalogue, so a five-letter correction would be five
   * writes, five audit rows and five reloads racing each other back into the
   * input. The field looks and behaves the same; it saves when you leave it or
   * press Enter.
   */
  const [draft, setDraft] = useState<{ id: string; label: string } | null>(null);
  const [newKind, setNewKind] = useState<PaymentMethodKind>('other');
  const canManage = ports.canManage !== false;
  const manageRef = useRef(canManage);
  manageRef.current = canManage;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const draftEpoch = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const write = async (work: () => void | Promise<void>, accepted?: () => void) => {
    if (!manageRef.current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setWriteError(null);
    try {
      await work();
      if (mounted.current && manageRef.current) accepted?.();
    } catch (err) {
      if (mounted.current) setWriteError(err instanceof Error ? err.message : 'The payment method was not saved.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const sorted = [...paymentMethods].sort((a, b) => a.sortOrder - b.sortOrder);

  const add = async () => {
    const label = newLabel.trim();
    if (!label) return;
    const taken = new Set(paymentMethods.map((m) => m.id));
    const id = makeId(label, taken, normalizePaymentMethod);
    const sortOrder = sorted.length ? sorted[sorted.length - 1]!.sortOrder + 1 : 0;
    const epoch = draftEpoch.current;
    await write(() => mutators.upsertPaymentMethod({ id, label, kind: newKind, enabled: true, sortOrder }), () => {
      if (draftEpoch.current !== epoch) return;
      setNewLabel('');
      setNewKind('other');
    });
  };

  const patch = (m: PaymentMethod, fields: Partial<PaymentMethod>) =>
    write(() => mutators.upsertPaymentMethod({ ...m, ...fields }));

  /** Commit the label being typed, if it changed and is not empty. */
  const commitLabel = async (m: PaymentMethod) => {
    const label = draft?.id === m.id ? draft.label.trim() : null;
    const ownedDraft = draft;
    if (!label || label === m.label) { setDraft(null); return; }
    await write(() => mutators.upsertPaymentMethod({ ...m, label }), () => {
      if (draftRef.current === ownedDraft) setDraft(null);
    });
  };

  const changeKind = (m: PaymentMethod, kind: PaymentMethodKind) => {
    patch(m, { kind });
  };

  /**
   * Remove a tender after the approved warning (SCRUM-495, item 15).
   *
   * The platform archives the row, so the active till list loses it while the
   * old ledger rows keep their original method code.
   *
   * The count is the platform's, read on the last hydration. It is used to
   * choose the question, never to authorise the archive: the server still
   * checks who may change the operator's method list.
   */
  const remove = (m: PaymentMethod) => {
    const used = paymentMethodUsage(m.id);
    if (used > 0) {
      const ok = window.confirm(
        `“${m.label}” is referenced by ${used} transaction${used === 1 ? '' : 's'}. ` +
          `Deleting it may leave those records labelled by their raw token in reports. ` +
          `Delete anyway? (Disabling it instead hides it at checkout but keeps reporting clean.)`,
      );
      if (!ok) return;
    }
    void write(() => mutators.deletePaymentMethod(m.id));
  };

  // Reorder is a swap of two sort orders, and the swap is one write: the store
  // moves the row under the finger and the platform does the same swap in one
  // transaction, so a till reading the list never sees both rows on one number.
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= sorted.length) return;
    void write(() => mutators.movePaymentMethod(sorted[index]!.id, dir === -1 ? 'up' : 'down'));
  };

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div>
        <h2 className="text-lg font-bold">Payment methods</h2>
        <p className="text-sm text-foreground/50">
          The tenders staff can take at checkout (till, F&amp;B, parties, add-time).
          Order is the order shown to staff. Disable a method to hide it at
          checkout while keeping its history in reports.
        </p>
      </div>
      {ports.authorityMessage && <p className="mt-3 text-sm text-foreground/60">{ports.authorityMessage}</p>}
      {writeError && <p role="alert" className="mt-3 text-sm text-destructive">{writeError}</p>}

      {/* Add row */}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <TextInput
          value={newLabel}
          placeholder="New method (e.g. Bank transfer)"
          disabled={!canManage}
          onChange={(e) => { draftEpoch.current++; setNewLabel(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
          className="flex-1"
        />
        <select
          value={newKind}
          disabled={!canManage}
          onChange={(e) => { draftEpoch.current++; setNewKind(e.target.value as PaymentMethodKind); }}
          className="h-10 shrink-0 rounded-xl border border-foreground/10 bg-foreground/5 px-3 text-sm text-foreground/90 outline-none focus:border-foreground/30"
          aria-label="New method kind"
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <Button
          onClick={() => void add()}
          disabled={!canManage || busy || !newLabel.trim()}
          className="shrink-0"
        >
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
              className={`flex items-center gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-3 py-2 ${
                m.enabled ? '' : 'opacity-60'
              }`}
            >
              <GripVertical className="w-4 h-4 shrink-0 text-foreground/25" />
              <Icon className="w-4 h-4 shrink-0 text-foreground/50" />
              <TextInput
                value={draft?.id === m.id ? draft.label : m.label}
                disabled={!canManage}
                onChange={(e) => setDraft({ id: m.id, label: e.target.value })}
                onBlur={() => void commitLabel(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="flex-1"
              />
              <select
                value={m.kind}
                disabled={!canManage || busy}
                onChange={(e) => changeKind(m, e.target.value as PaymentMethodKind)}
                className="h-10 shrink-0 rounded-xl border border-foreground/10 bg-foreground/5 px-2 text-sm text-foreground/90 outline-none focus:border-foreground/30"
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
                disabled={!canManage || busy}
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
                  disabled={!canManage || busy || i === 0}
                  aria-label="Move up"
                >
                  <ChevronUp className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => move(i, 1)}
                  disabled={!canManage || busy || i === sorted.length - 1}
                  aria-label="Move down"
                >
                  <ChevronDown className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(m)}
                  disabled={!canManage || busy}
                  aria-label="Remove method"
                >
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
