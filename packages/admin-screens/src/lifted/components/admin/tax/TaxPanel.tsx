import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useEffect, useMemo, useRef, useState } from "react";
import { Info, Check, Plus, Trash2, AlertTriangle } from "lucide-react";
import { type CategoryTaxRule, type TaxableCategory, type TaxConfig, type TaxMode, type TaxRate } from "../../../model/types";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";
import { computeTaxBreakdown } from "@oto/shared";
import { type CategoryTaxLineBaht, type TaxBreakdownBaht } from "../../../lib/cartWire";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { useMoneyCapabilities, type TaxPanelPorts } from '../../../runtime/money';
import { errorView, type ErrorField } from '../../../../lib/errorView';

// Human labels for each taxable area. 'stored_value' is intentionally omitted
// from the editor — credit loads are never taxed at load (taxed on spend).
const CATEGORY_LABELS: Partial<Record<TaxableCategory, string>> = {
  tickets:    'Tickets',
  fnb:        'F&B',
  bar:        'Bar (alcohol)',
  drop_off:   'Drop-off / nanny',
  parties:    'Parties / events',
  addons:     'Add-ons',
  merch:      'Retail / merch',
};

const TAX_MODE_OPTIONS: { value: TaxMode; label: string }[] = [
  { value: 'inclusive', label: 'VAT included in price' },
  { value: 'exclusive', label: 'VAT added on top' },
  { value: 'none',      label: 'No tax' },
];

// Compact default-mode options for a rate row. '__no_default__' clears the hint.
const NO_DEFAULT_MODE = '__no_default__';
const RATE_DEFAULT_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: NO_DEFAULT_MODE, label: 'No default' },
  { value: 'inclusive',     label: 'Default: included' },
  { value: 'exclusive',     label: 'Default: added on top' },
];

const EXAMPLE_CATEGORIES: { value: TaxableCategory; label: string }[] = [
  { value: 'fnb',     label: 'F&B' },
  { value: 'bar',     label: 'Bar (alcohol)' },
  { value: 'tickets', label: 'Tickets' },
  { value: 'addons',  label: 'Add-ons' },
  { value: 'merch',   label: 'Retail / merch' },
];

type ServiceDraft = Record<string, string>;
type Recovery = { needsRead: boolean; reading: boolean; waitUntil: number; readError: unknown; notice: string | null; saved?: TaxConfig | null };

const serviceDraftFrom = (rules: CategoryTaxRule[]): ServiceDraft =>
  Object.fromEntries(
    rules.map((r) => [r.category, String(r.serviceChargePercent ?? 0)])
  );

const NO_RATE = '__none__';

// JSONB does not retain object-key order; compare the saved configuration by value.
const configKey = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(configKey).join(',') + ']';
  if (typeof value === 'object' && value !== null) return '{' + Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => JSON.stringify(key) + ':' + configKey(entry)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
};

/**
 * Admin editing screen for the tax configuration. Reads the live shared catalog
 * store and writes back through `updateTaxConfig`, so changes flow to the tax
 * engine (@oto/shared, through lib/cartWire.ts) on the next computation. Every taxable area is editable —
 * including the retail/merch category, which the owner's accountant can tax
 * independently of F&B.
 */
export function TaxPanel() {
  const runtime = useAdminScreenRuntime();
  const { taxConfig, mutators } = useCatalogStore();
  const scope = useMoneyCapabilities(runtime.transport, runtime.session.operator?.id, Boolean(runtime.branch.branch.apiId), runtime.session.operator, runtime.branch.branch.apiId);
  return <TaxPanelWithPorts ports={{ taxConfig, taxEngine: runtime.domain.cartWire, updateTaxConfig: mutators.updateTaxConfig, canManage: scope.canManageTax, authorityMessage: scope.authorityMessage }} />;
}

export function TaxPanelWithPorts({ ports }: { ports: TaxPanelPorts }) {
  const { breakdownToBaht, engineTaxConfig, toSatang } = ports.taxEngine;
  const { taxConfig } = ports;
  const mutators = ports;

  const editableRules = useMemo(
    () => taxConfig.categoryRules.filter((r) => r.category !== 'stored_value'),
    [taxConfig]
  );

  // ── draft state ────────────────────────────────────────────────────────────
  const [rates, setRates] = useState<TaxRate[]>(taxConfig.rates);
  const [rules, setRules] = useState<CategoryTaxRule[]>(editableRules);
  const [service, setService] = useState<ServiceDraft>(() => serviceDraftFrom(editableRules));
  const [discountPlacement, setDiscountPlacement] = useState<TaxConfig['discountPlacement']>(
    taxConfig.discountPlacement
  );
  const [saved, setSaved] = useState(false);
  const canManage = ports.canManage !== false;
  const manageRef = useRef(canManage);
  manageRef.current = canManage;
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const [writeError, setWriteError] = useState<unknown>(null);
  const [recovery, setRecovery] = useState<Recovery>({ needsRead: false, reading: false, waitUntil: 0, readError: null, notice: null });
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const [now, setNow] = useState(Date.now);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const confirmedConfig = useRef<TaxConfig | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // New-rate form
  const [newRateName, setNewRateName] = useState('');
  const [newRatePercent, setNewRatePercent] = useState('');
  const [newRateError, setNewRateError] = useState('');

  // Delete-rate confirmation (id of the rate being considered for deletion)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Live example
  const [exampleCategory, setExampleCategory] = useState<TaxableCategory>('fnb');

  // Re-seed from the store whenever it changes externally.
  useEffect(() => {
    setRates(taxConfig.rates);
    setRules(editableRules);
    setService(serviceDraftFrom(editableRules));
    setDiscountPlacement(taxConfig.discountPlacement);
    setSaved(confirmedConfig.current !== null && configKey(confirmedConfig.current) === configKey(taxConfig));
  }, [editableRules, taxConfig]);

  const fields = useMemo(() => {
    const result: Record<string, ErrorField> = {};
    rates.forEach((_, index) => {
      result[`/rates/${index}/name`] = { label: 'Rate name', id: `tax-rate-name-${index}` };
      result[`/rates/${index}/percent`] = { label: 'Rate percent', id: `tax-rate-percent-${index}` };
      result[`/rates/${index}/defaultMode`] = { label: 'Rate default mode', id: `tax-rate-default-${index}` };
    });
    rules.forEach((rule, index) => {
      const label = CATEGORY_LABELS[rule.category] ?? 'Tax area';
      result[`/categoryRules/${index}/serviceChargePercent`] = { label: `${label} service charge`, id: `tax-svc-${rule.category}` };
      result[`/categoryRules/${index}/taxMode`] = { label: `${label} tax mode`, id: `tax-mode-${rule.category}` };
      result[`/categoryRules/${index}/taxRateId`] = { label: `${label} tax rate`, id: `tax-rate-${rule.category}` };
    });
    return result;
  }, [rates, rules]);
  const failure = writeError === null ? null : errorView(writeError, { operation: 'write', fields });
  const readFailure = recovery.readError === null ? null : errorView(recovery.readError);
  const focusId = failure?.fieldIssues[0]?.id;
  useEffect(() => {
    if (!saving && focusId) document.getElementById(focusId)?.focus();
  }, [writeError, saving, focusId]);
  useEffect(() => {
    if (!recovery.waitUntil || Date.now() >= recovery.waitUntil) return;
    const timer = setInterval(() => { const at = Date.now(); setNow(at); if (at >= recovery.waitUntil) clearInterval(timer); }, 250);
    return () => clearInterval(timer);
  }, [recovery.waitUntil]);
  const waiting = Math.max(0, Math.ceil((recovery.waitUntil - now) / 1000));
  const invalid = (id: string) => failure?.fieldIssues.some(issue => issue.id === id)
    ? { 'aria-invalid': true as const, 'aria-describedby': `error-${id}` } : {};

  // ── derived: which categories reference a given rate ────────────────────
  const rateUsers = useMemo(() => {
    const map = new Map<string, TaxableCategory[]>();
    for (const r of rules) {
      if (r.taxRateId) {
        const list = map.get(r.taxRateId) ?? [];
        list.push(r.category);
        map.set(r.taxRateId, list);
      }
    }
    return map;
  }, [rules]);

  // ── derived: build the "current draft" config for the live example ───────
  const draftConfig = useMemo((): TaxConfig => {
    const mergedEditable = rules.map((r) => {
      const raw = service[r.category];
      const num = Number(raw);
      const serviceChargePercent = !raw || Number.isNaN(num) || num < 0 ? 0 : num;
      return { ...r, serviceChargePercent };
    });
    const untouched = taxConfig.categoryRules.filter(
      (r) => !mergedEditable.some((m) => m.category === r.category)
    );
    return {
      rates,
      categoryRules: [...mergedEditable, ...untouched],
      discountPlacement,
    };
  }, [rates, rules, service, discountPlacement, taxConfig.categoryRules]);

  // ── live example computation (always from the engine — never re-implemented) ─
  // The platform's satang engine since SCRUM-271: the example is priced exactly
  // as a sale under this draft would be, and only converted to baht to show it.
  const liveExample = useMemo(() => {
    const EXAMPLE_BASE = 100;
    const bd = breakdownToBaht(
      computeTaxBreakdown(
        [{ category: exampleCategory, base: toSatang(EXAMPLE_BASE) }],
        0,
        engineTaxConfig(draftConfig)
      )
    );
    const cat = bd.categories[0]!;
    return { bd, cat, base: EXAMPLE_BASE };
  }, [exampleCategory, draftConfig, breakdownToBaht, engineTaxConfig, toSatang]);

  // ── rule helpers ──────────────────────────────────────────────────────────
  const setRule = (category: TaxableCategory, patch: Partial<CategoryTaxRule>) => {
    setRules((prev) =>
      prev.map((r) => (r.category === category ? { ...r, ...patch } : r))
    );
    setSaved(false);
  };

  const setServiceField = (category: TaxableCategory, raw: string) => {
    setService((prev) => ({ ...prev, [category]: raw }));
    setSaved(false);
  };

  // ── rate helpers ──────────────────────────────────────────────────────────
  const updateRate = (id: string, patch: Partial<TaxRate>) => {
    setRates((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  const addRate = () => {
    const name = newRateName.trim();
    const pct = Number(newRatePercent);
    if (!name) { setNewRateError('Enter a rate name.'); return; }
    if (!newRatePercent.trim() || Number.isNaN(pct) || pct < 0) {
      setNewRateError('Enter a valid percent (0 or more).');
      return;
    }
    setRates((prev) => [...prev, { id: crypto.randomUUID(), name, percent: pct }]);
    setNewRateName('');
    setNewRatePercent('');
    setNewRateError('');
    setSaved(false);
  };

  const confirmDeleteRate = (id: string) => {
    const users = rateUsers.get(id) ?? [];
    if (users.length > 0) {
      setPendingDeleteId(id);
    } else {
      doDeleteRate(id);
    }
  };

  const doDeleteRate = (id: string) => {
    setRates((prev) => prev.filter((r) => r.id !== id));
    // Clear the taxRateId on any rule that referenced it.
    setRules((prev) =>
      prev.map((r) => (r.taxRateId === id ? { ...r, taxRateId: undefined } : r))
    );
    setPendingDeleteId(null);
    setSaved(false);
  };

  // ── save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (busyRef.current || !manageRef.current || recoveryRef.current.needsRead || recoveryRef.current.reading || Date.now() < recoveryRef.current.waitUntil) return;
    const mergedEditable = rules.map((r) => {
      const raw = service[r.category];
      const num = Number(raw);
      const serviceChargePercent = !raw || Number.isNaN(num) || num < 0 ? 0 : num;
      return { ...r, serviceChargePercent };
    });
    const untouched = taxConfig.categoryRules.filter(
      (r) => !mergedEditable.some((m) => m.category === r.category)
    );
    const submitted: TaxConfig = { rates, categoryRules: [...mergedEditable, ...untouched], discountPlacement };
    busyRef.current = true;
    confirmedConfig.current = null;
    setSaving(true);
    setWriteError(null);
    setCopyNote(null);
    const reset = { ...recoveryRef.current, readError: null, notice: null, saved: undefined };
    recoveryRef.current = reset;
    setRecovery(reset);
    try {
      await mutators.updateTaxConfig(submitted);
      if (mounted.current && manageRef.current) {
        confirmedConfig.current = submitted;
        setSaved(true);
      }
    } catch (err) {
      if (mounted.current) {
        confirmedConfig.current = null;
        setSaved(false);
        const view = errorView(err, { operation: 'write' });
        const at = Date.now();
        const next = { needsRead: view.requiresFreshRead, reading: false,
          waitUntil: view.retryAfterSeconds === undefined ? 0 : at + view.retryAfterSeconds * 1000, readError: null, notice: null };
        recoveryRef.current = next;
        setRecovery(next);
        setNow(at);
        setWriteError(err ?? new Error('The save could not be confirmed.'));
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const readCurrent = async () => {
    if (!ports.readCurrent || !manageRef.current || !recoveryRef.current.needsRead || recoveryRef.current.reading || busyRef.current) return;
    const pending = { ...recoveryRef.current, reading: true, readError: null, notice: null };
    recoveryRef.current = pending; setRecovery(pending);
    try {
      const saved = await ports.readCurrent();
      if (!mounted.current || !manageRef.current) return;
      const next = { ...recoveryRef.current, needsRead: false, reading: false, readError: null, saved,
        notice: 'Current settings were read. Review your retained draft before saving.' };
      recoveryRef.current = next; setRecovery(next); setWriteError(null); setCopyNote(null);
    } catch (error) {
      if (!mounted.current || !manageRef.current) return;
      const next = { ...recoveryRef.current, reading: false, readError: error ?? new Error('The current settings could not be read.') };
      recoveryRef.current = next; setRecovery(next);
    } finally {
      if (mounted.current && recoveryRef.current.reading) {
        const next = { ...recoveryRef.current, reading: false };
        recoveryRef.current = next; setRecovery(next);
      }
    }
  };

  const copyReference = (reference: string) => {
    if (!navigator.clipboard) { setCopyNote('Copy is unavailable. Select and copy the reference.'); return; }
    void navigator.clipboard.writeText(reference).then(() => setCopyNote('Reference copied.'),
      () => setCopyNote('Copy did not work. Select and copy the reference.'));
  };

  return (
    <div className="flex flex-col gap-6">
      {ports.authorityMessage && <p className="text-sm text-foreground/60">{ports.authorityMessage}</p>}
      {failure && <div role="alert" className="flex flex-col gap-2 text-sm text-destructive">
        <p>{failure.message}</p>
        {failure.fieldIssues.length > 0 && <ul className="list-disc pl-5">{failure.fieldIssues.map(issue =>
          <li key={issue.path} id={issue.id ? `error-${issue.id}` : undefined}><strong>{issue.label}:</strong> {issue.message}</li>)}</ul>}
        {failure.supportReference && <p className="flex flex-wrap items-center gap-2 text-xs">
          <span>Reference: <code>{failure.supportReference}</code></span>
          <button type="button" className="underline" onClick={() => copyReference(failure.supportReference!)}>Copy reference</button>
        </p>}
        {waiting > 0 && <p>{waiting}s remaining before saving again.</p>}
        {recovery.needsRead && (ports.readCurrent
          ? <Button type="button" variant="outline" className="self-start" disabled={recovery.reading || !canManage} onClick={() => void readCurrent()}>
            {recovery.reading ? 'Reading current settings…' : 'Read current settings'}</Button>
          : <p>Reload this page to read the current settings before saving again. Your draft is kept here until you leave.</p>)}
        {readFailure && <div><p>{readFailure.message}</p>{readFailure.supportReference && <p className="flex flex-wrap items-center gap-2 text-xs">
          <span>Read reference: <code>{readFailure.supportReference}</code></span>
          <button type="button" className="underline" onClick={() => copyReference(readFailure.supportReference!)}>Copy read reference</button>
        </p>}</div>}
      </div>}
      {copyNote && <p role="status" className="text-sm">{copyNote}</p>}
      {recovery.notice && <p role="status" className="text-sm text-foreground/60">{recovery.notice}</p>}
      {recovery.saved !== undefined && <SavedTaxSettings config={recovery.saved} draft={draftConfig} />}

      {/* ── 1. Global rates ──────────────────────────────────────────────── */}
      <fieldset disabled={!canManage || saving} className="min-w-0 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Global tax rates</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Named rates that per-category rules reference. Each rate has a name (e.g. "VAT") and a
          percent. Deleting a rate that a category still uses will reset that category to "no rate".
        </p>

        <div className="mt-4 flex flex-col gap-3">
          {rates.map((rate, index) => {
            const users = rateUsers.get(rate.id) ?? [];
            const isPendingDelete = pendingDeleteId === rate.id;
            return (
              <div key={rate.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    id={`tax-rate-name-${index}`}
                    {...invalid(`tax-rate-name-${index}`)}
                    aria-label="Rate name"
                    value={rate.name}
                    onChange={(e) => updateRate(rate.id, { name: e.target.value })}
                    className="w-32"
                    placeholder="VAT"
                  />
                  <Input
                    id={`tax-rate-percent-${index}`}
                    {...invalid(`tax-rate-percent-${index}`)}
                    aria-label="Rate percent"
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={rate.percent}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v) && v >= 0) updateRate(rate.id, { percent: v });
                    }}
                    className="w-24"
                    placeholder="7"
                  />
                  <span className="text-sm text-foreground/50">%</span>
                  <div className="w-44">
                    <Select
                      value={rate.defaultMode ?? NO_DEFAULT_MODE}
                      onValueChange={(v) =>
                        updateRate(rate.id, {
                          defaultMode: v === NO_DEFAULT_MODE ? undefined : (v as TaxMode),
                        })
                      }
                    >
                      <SelectTrigger id={`tax-rate-default-${index}`} {...invalid(`tax-rate-default-${index}`)} aria-label="Rate default mode" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RATE_DEFAULT_MODE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {users.length > 0 && (
                    <span className="text-xs text-foreground/40">
                      used by {users.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}
                    </span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto text-destructive hover:text-destructive"
                    onClick={() => confirmDeleteRate(rate.id)}
                    aria-label="Delete rate"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {isPendingDelete && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <div className="flex flex-col gap-2">
                      <p className="text-amber-700">
                        <strong>{rate.name}</strong> is assigned to{' '}
                        {(rateUsers.get(rate.id) ?? [])
                          .map((c) => CATEGORY_LABELS[c] ?? c)
                          .join(', ')}
                        . Those categories will revert to "no tax rate" if deleted.
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" variant="destructive" onClick={() => doDeleteRate(rate.id)}>
                          Delete anyway
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPendingDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Add new rate */}
          <div className="mt-1 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Input
                aria-label="New rate name"
                value={newRateName}
                onChange={(e) => { setNewRateName(e.target.value); setNewRateError(''); }}
                placeholder="Rate name"
                className="w-32"
              />
              <Input
                aria-label="New rate percent"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={newRatePercent}
                onChange={(e) => { setNewRatePercent(e.target.value); setNewRateError(''); }}
                placeholder="0"
                className="w-24"
              />
              <span className="text-sm text-foreground/50">%</span>
              <Button size="sm" variant="outline" onClick={addRate} className="ml-1">
                <Plus className="h-3.5 w-3.5" />
                Add rate
              </Button>
            </div>
            {newRateError && <p className="text-xs text-destructive">{newRateError}</p>}
          </div>
        </div>
      </fieldset>

      {/* ── 2. Tax per area ───────────────────────────────────────────────── */}
      <fieldset disabled={!canManage || saving} className="min-w-0 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Tax per area</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Set how each part of the business is taxed and service-charged. Retail / merch is its own
          area so it can be taxed independently of F&amp;B.
        </p>

        <div className="mt-5 flex flex-col gap-4">
          {rules.map((r) => (
            <div
              key={r.category}
              className="flex flex-col gap-3 rounded-xl bg-foreground/[0.02] p-4"
            >
              <span className="font-medium">
                {CATEGORY_LABELS[r.category] ?? r.category}
              </span>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {/* Tax mode */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`tax-mode-${r.category}`} className="text-xs">
                    Tax mode
                  </Label>
                  <Select
                    value={r.taxMode}
                    onValueChange={(v) => {
                      const mode = v as TaxMode;
                      setRule(r.category, {
                        taxMode: mode,
                        taxRateId: mode === 'none' ? undefined : (r.taxRateId ?? rates[0]?.id),
                      });
                    }}
                  >
                    <SelectTrigger id={`tax-mode-${r.category}`} {...invalid(`tax-mode-${r.category}`)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TAX_MODE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Rate picker */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`tax-rate-${r.category}`} className="text-xs">
                    Tax rate
                  </Label>
                  <Select
                    value={r.taxRateId ?? NO_RATE}
                    onValueChange={(v) => {
                      if (v === NO_RATE) {
                        setRule(r.category, { taxRateId: undefined });
                        return;
                      }
                      const picked = rates.find((rt) => rt.id === v);
                      // Assigning a rate lifts the area off "No tax" so the rate
                      // actually applies — using the rate's default mode if set.
                      setRule(r.category, {
                        taxRateId: v,
                        taxMode:
                          r.taxMode === 'none'
                            ? (picked?.defaultMode ?? 'inclusive')
                            : r.taxMode,
                      });
                    }}
                  >
                    <SelectTrigger id={`tax-rate-${r.category}`} {...invalid(`tax-rate-${r.category}`)}>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_RATE}>No rate</SelectItem>
                      {rates.map((rate) => (
                        <SelectItem key={rate.id} value={rate.id}>
                          {rate.name} ({rate.percent}%)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Service charge */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`tax-svc-${r.category}`} className="text-xs">
                    Service charge %
                  </Label>
                  <Input
                    id={`tax-svc-${r.category}`}
                    {...invalid(`tax-svc-${r.category}`)}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    value={service[r.category] ?? '0'}
                    onChange={(e) => setServiceField(r.category, e.target.value)}
                  />
                </div>

                {/* Tax-on-service-charge toggle */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-foreground/70">Tax on service charge</span>
                  <div className="flex items-center gap-2 pt-1">
                    <Switch
                      id={`tax-on-tax-${r.category}`}
                      checked={!!r.taxOnServiceCharge}
                      disabled={r.taxMode === 'none' || !(Number(service[r.category]) > 0)}
                      onCheckedChange={(checked) =>
                        setRule(r.category, { taxOnServiceCharge: checked })
                      }
                    />
                    <Label
                      htmlFor={`tax-on-tax-${r.category}`}
                      className="cursor-pointer text-xs"
                    >
                      {r.taxOnServiceCharge ? 'On (tax on tax)' : 'Off'}
                    </Label>
                  </div>
                </div>
              </div>

              {/* Additional (second) tax — its own included / added-on-top mode */}
              <div className="flex flex-col gap-1.5 border-t border-foreground/10 pt-3">
                <Label className="text-xs">
                  Additional tax
                  <span className="ml-1 font-normal text-foreground/40">
                    — a second tax on this area, included in the price or added on top
                  </span>
                </Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select
                    value={r.secondaryTaxRateId ?? NO_RATE}
                    onValueChange={(v) => {
                      if (v === NO_RATE) {
                        setRule(r.category, { secondaryTaxRateId: undefined });
                        return;
                      }
                      const picked = rates.find((rt) => rt.id === v);
                      // Seed the second tax's mode from the rate's default the first
                      // time it's assigned; keep an explicit choice if already set.
                      setRule(r.category, {
                        secondaryTaxRateId: v,
                        secondaryTaxMode:
                          r.secondaryTaxMode ?? picked?.defaultMode ?? 'exclusive',
                      });
                    }}
                  >
                    <SelectTrigger id={`tax-secondary-${r.category}`}>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_RATE}>None</SelectItem>
                      {rates
                        .filter((rate) => rate.id !== r.taxRateId)
                        .map((rate) => (
                          <SelectItem key={rate.id} value={rate.id}>
                            {rate.name} ({rate.percent}%)
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={r.secondaryTaxMode ?? 'exclusive'}
                    disabled={!r.secondaryTaxRateId}
                    onValueChange={(v) =>
                      setRule(r.category, { secondaryTaxMode: v as TaxMode })
                    }
                  >
                    <SelectTrigger aria-label="Additional tax mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inclusive">Included in price</SelectItem>
                      <SelectItem value="exclusive">Added on top</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {/* ── 3. Discount placement ─────────────────────────────────────────── */}
      <fieldset disabled={!canManage || saving} className="min-w-0 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Discount placement</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Whether manual discounts apply before or after tax is computed.
        </p>
        <div className="mt-3 max-w-xs">
          <Select
            value={discountPlacement}
            onValueChange={(v) => {
              setDiscountPlacement(v as TaxConfig['discountPlacement']);
              setSaved(false);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="before_tax">Before tax</SelectItem>
              <SelectItem value="after_tax">After tax</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </fieldset>

      {/* ── 4. Live example ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Live example</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Computed by the tax engine from the settings above (including unsaved changes). Use this
          to sanity-check a configuration before saving.
        </p>

        <div className="mt-3 flex items-center gap-3">
          <Label className="text-xs shrink-0">Category to preview</Label>
          <div className="w-44">
            <Select
              value={exampleCategory}
              onValueChange={(v) => setExampleCategory(v as TaxableCategory)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXAMPLE_CATEGORIES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 rounded-xl bg-foreground/5 p-4 font-mono text-sm leading-6">
          <ExampleBreakdown
            category={exampleCategory}
            base={liveExample.base}
            cat={liveExample.cat}
            bd={liveExample.bd}
            rates={rates}
          />
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-700/80">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Tax rules and sequences should be validated with a qualified accountant before going live.
        </p>
      </div>

      {/* ── Save ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void handleSave()} disabled={!canManage || saving || recovery.needsRead || recovery.reading || waiting > 0}>
          <Check className="w-4 h-4" />
          Save changes
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
            <Check className="w-4 h-4" />
            Saved — live in the till.
          </span>
        )}
      </div>

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Changes are saved to the database and audited.
      </p>
    </div>
  );
}

// ── Live example breakdown display ─────────────────────────────────────────

/** Recorded values from the recovery read, beside the unchanged editor draft. */
function SavedTaxSettings({ config, draft }: { config: TaxConfig | null; draft: TaxConfig }) {
  const matches = config !== null && configKey(config) === configKey(draft);
  const mode = (value: TaxMode | undefined) => TAX_MODE_OPTIONS.find(option => option.value === value)?.label ?? 'Not recorded';
  const rate = (id: string | undefined) => {
    if (!id) return 'None';
    const saved = config?.rates.find(value => value.id === id);
    return saved ? `${saved.name} (${saved.percent}%)` : 'Unavailable rate';
  };
  return <section aria-label="Saved tax settings" className="rounded-xl border border-foreground/15 p-4 text-sm">
    <h3 className="font-semibold">Saved settings from the recovery read</h3>
    <p className="mt-1">{config === null ? 'No tax settings are stored for this park. Your draft is retained.'
      : matches ? 'This draft matches the saved settings.' : 'This draft differs from the saved settings. Your draft is retained for review.'}</p>
    {config && <details open={!matches} className="mt-2">
      <summary className="cursor-pointer font-medium">Inspect saved values</summary>
      <div className="mt-2 flex flex-col gap-3">
        <div><h4 className="font-medium">Rates</h4>{config.rates.length === 0 ? <p>No saved rates.</p> : <ul>{config.rates.map(value =>
          <li key={value.id}>{value.name}: <span>{value.percent}%</span>{value.defaultMode ? ` · ${mode(value.defaultMode)}` : ' · No default'}</li>)}</ul>}</div>
        <ul className="flex flex-col gap-2">{config.categoryRules.map(value => <li key={value.category}>
          <p className="font-medium">{value.category === 'stored_value' ? 'Stored value (read only)' : CATEGORY_LABELS[value.category] ?? 'Other tax area'}</p>
          <p>{mode(value.taxMode)} · Rate: {rate(value.taxRateId)}</p>
          <p>Service charge: <span>{value.serviceChargePercent === undefined ? 'Not recorded' : `${value.serviceChargePercent}%`}</span>
            {' · '}Tax on service charge: {value.taxOnServiceCharge === undefined ? 'Not recorded' : value.taxOnServiceCharge ? 'Yes' : 'No'}</p>
          {value.secondaryTaxRateId && <p>Additional rate: {rate(value.secondaryTaxRateId)} · {mode(value.secondaryTaxMode)}</p>}
        </li>)}</ul>
        <p>Discount placement: {config.discountPlacement === 'before_tax' ? 'Before tax' : config.discountPlacement === 'after_tax' ? 'After tax' : 'Not recorded'}</p>
      </div>
    </details>}
  </section>;
}

interface ExampleBreakdownProps {
  category: TaxableCategory;
  base: number;
  cat: CategoryTaxLineBaht;
  bd: TaxBreakdownBaht;
  rates: TaxRate[];
}

/** A baht figure from the engine — a whole number of satang — to two places. */
function fmt(n: number) {
  return `฿${n.toFixed(2)}`;
}

function ExampleBreakdown({ category, base, cat }: ExampleBreakdownProps) {
  const label = CATEGORY_LABELS[category] ?? category;
  const rateLabel =
    cat.taxMode === 'none'
      ? 'no tax'
      : cat.taxName
      ? `${cat.taxName} ${cat.taxPercent}% ${cat.taxMode}`
      : 'no rate assigned';

  const rows: { label: string; value: string; dim?: boolean }[] = [
    { label: `${label} base`, value: fmt(base) },
  ];

  if (cat.serviceCharge > 0) {
    rows.push({ label: `+ service charge`, value: fmt(cat.serviceCharge) });
  }

  if (cat.taxMode === 'exclusive' && cat.tax > 0) {
    rows.push({ label: `+ ${rateLabel}`, value: fmt(cat.tax) });
  } else if (cat.taxMode === 'inclusive' && cat.tax > 0) {
    rows.push({ label: `  ${cat.taxName ?? 'Tax'} included (${cat.taxPercent}%)`, value: fmt(cat.tax), dim: true });
  } else if (cat.taxMode === 'none') {
    rows.push({ label: `  (no tax applied)`, value: '—', dim: true });
  }

  if (cat.secondaryTax > 0) {
    const secName = cat.secondaryTaxName ?? 'Tax';
    if (cat.secondaryTaxMode === 'inclusive') {
      rows.push({
        label: `  ${secName} included (${cat.secondaryTaxPercent}%)`,
        value: fmt(cat.secondaryTax),
        dim: true,
      });
    } else {
      rows.push({
        label: `+ ${secName} ${cat.secondaryTaxPercent}% (on top)`,
        value: fmt(cat.secondaryTax),
      });
    }
  }

  rows.push({ label: `= total`, value: fmt(cat.gross) });

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, i) => (
        <div key={i} className={`flex justify-between gap-4 ${row.dim ? 'text-foreground/40' : ''}`}>
          <span>{row.label}</span>
          <span>{row.value}</span>
        </div>
      ))}
      {cat.taxMode === 'inclusive' && cat.tax > 0 && (
        <div className="mt-1 border-t border-foreground/10 pt-1 text-xs text-foreground/40">
          The included {cat.taxName ?? 'tax'} is reported on the receipt but already inside the price.
        </div>
      )}
    </div>
  );
}
