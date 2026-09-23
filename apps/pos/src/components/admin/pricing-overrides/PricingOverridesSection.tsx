import { useEffect, useState } from 'react';
import { CalendarRange, Plus, Trash2, Pencil, X, Check } from 'lucide-react';
import type { PricingOverride } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { getActiveBranch } from '@/store/catalogStore';
import { holidaySaleCounts } from '@/api/catalogBridge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Field, TextInput } from '@/components/admin/discounts/fields';

interface DraftForm {
  id?: string;
  name: string;
  startDate: string;
  endDate: string;
}

const EMPTY_DRAFT: DraftForm = { name: '', startDate: '', endDate: '' };

/**
 * Admin CRUD for named holiday/weekend-override date ranges. Any date inside
 * one of these ranges resolves to weekend pricing park-wide — see
 * getRateModeForDate in lib/pricingMode.ts (the ONE resolver every price read
 * flows through).
 */
export function PricingOverridesSection() {
  const { pricingOverrides, mutators } = useCatalogStore();
  const [draft, setDraft] = useState<DraftForm | null>(null);
  const [error, setError] = useState<string | undefined>();

  /**
   * Sales priced by each range (SCRUM-309). Once the park has traded on a
   * range the platform freezes its DATES — the receipts have to keep saying
   * which days it covered — while its NAME stays correctable, which is the
   * whole point: before this, the panel's edit was a delete and a create, and
   * the first ticket sold under a mistyped holiday made the typo permanent.
   *
   * Read beside the calendar so the form can say so instead of the manager
   * finding out by being refused. If it cannot be read the form stays fully
   * editable and the platform's own refusal reaches the screen as a toast —
   * which is what happened before this existed.
   */
  const [pricedSales, setPricedSales] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    void holidaySaleCounts(getActiveBranch().id)
      .then((counts) => live && setPricedSales(counts))
      .catch(() => live && setPricedSales({}));
    return () => {
      live = false;
    };
  }, [pricingOverrides]);

  const editingSales = draft?.id ? (pricedSales[draft.id] ?? 0) : 0;
  const datesFrozen = editingSales > 0;

  const sorted = [...pricingOverrides].sort((a, b) => a.startDate.localeCompare(b.startDate));

  const startAdd = () => {
    setDraft({ ...EMPTY_DRAFT });
    setError(undefined);
  };

  const startEdit = (o: PricingOverride) => {
    setDraft({ id: o.id, name: o.name, startDate: o.startDate, endDate: o.endDate });
    setError(undefined);
  };

  const cancel = () => {
    setDraft(null);
    setError(undefined);
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError('Enter a name for this range.');
      return;
    }
    if (!draft.startDate || !draft.endDate) {
      setError('Enter both a start and an end date.');
      return;
    }
    if (draft.endDate < draft.startDate) {
      setError('End date must be on or after the start date.');
      return;
    }
    mutators.upsertPricingOverride({
      id: draft.id ?? `override-${Date.now().toString(36)}`,
      name,
      startDate: draft.startDate,
      endDate: draft.endDate,
    });
    setDraft(null);
    setError(undefined);
  };

  // Deleting a holiday range flips its dates back to weekday pricing —
  // destructive enough to warrant a confirm (failing-case rule).
  const [pendingDelete, setPendingDelete] = useState<PricingOverride | null>(null);
  const remove = (id: string) => mutators.deletePricingOverride(id);

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Holidays / weekend overrides</h2>
          <p className="text-sm text-foreground/50">
            Named date ranges (e.g. Songkran) that bill at weekend rates even on a
            weekday. Every price on the till resolves via one active mode for
            today's date — override, then Sat/Sun, then weekday.
          </p>
        </div>
        {!draft && (
          <Button onClick={startAdd} className="shrink-0">
            <Plus className="w-4 h-4" />
            Add range
          </Button>
        )}
      </div>

      {draft && (
        <div className="mt-5 rounded-2xl border border-primary/30 bg-primary/[0.04] p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="po-name">
              <TextInput
                id="po-name"
                value={draft.name}
                placeholder="e.g. Songkran"
                onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                invalid={!!error && !draft.name.trim()}
              />
            </Field>
            <Field label="Start date" htmlFor="po-start">
              <TextInput
                id="po-start"
                type="date"
                value={draft.startDate}
                disabled={datesFrozen}
                onChange={(e) => setDraft((d) => (d ? { ...d, startDate: e.target.value } : d))}
                invalid={!!error && !draft.startDate}
              />
            </Field>
            <Field label="End date" htmlFor="po-end">
              <TextInput
                id="po-end"
                type="date"
                value={draft.endDate}
                disabled={datesFrozen}
                onChange={(e) => setDraft((d) => (d ? { ...d, endDate: e.target.value } : d))}
                invalid={!!error && (!draft.endDate || draft.endDate < draft.startDate)}
              />
            </Field>
          </div>
          {datesFrozen && (
            <p className="mt-2 text-xs text-foreground/50">
              {editingSales === 1 ? '1 sale was' : `${editingSales} sales were`} priced by this
              range, so its dates are fixed — those receipts have to keep saying which days it
              covered. The name can still be corrected.
            </p>
          )}
          {error && <p className="mt-2 text-xs font-medium text-destructive">{error}</p>}
          <div className="mt-4 flex gap-2">
            <Button onClick={save}>
              <Check className="w-4 h-4" />
              Save
            </Button>
            <Button variant="outline" onClick={cancel}>
              <X className="w-4 h-4" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {sorted.length === 0 && !draft && (
          <p className="rounded-2xl border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-foreground/40">
            No holiday overrides yet. Every day resolves by Sat/Sun until you add one.
          </p>
        )}
        {sorted.map((o) => (
          <div
            key={o.id}
            className="flex items-center gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3"
          >
            <CalendarRange className="w-4 h-4 shrink-0 text-foreground/40" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{o.name}</div>
              <div className="text-xs text-foreground/50">
                {o.startDate} – {o.endDate}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startEdit(o)}
                aria-label={`Edit ${o.name}`}
              >
                <Pencil className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingDelete(o)}
                aria-label={`Remove ${o.name}`}
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `${pendingDelete.startDate} – ${pendingDelete.endDate} will bill at normal weekday/weekend rates again.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) remove(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Remove holiday
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
