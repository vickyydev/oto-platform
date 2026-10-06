import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Clock, Timer } from 'lucide-react';
import {
  baht,
  createSaleExtension,
  newActionId,
  parseHistorySearch,
  readSaleExtensions,
  reselectExtensionBands,
  type ExtensionBand,
  type ExtensionSelection,
  type SaleExtension,
  type SaleExtensionBody,
  type SaleExtensionsRead,
} from '@/api/history';
import { ApiError } from '@/api/client';
import { finaliseSale, salesApi, type ApiSale } from '@/api/sales';
import { useOperator } from '@/auth/OperatorContext';
import { useStation } from '@/station/StationContext';
import { usePaymentStage } from '@/lib/usePaymentStage';
import { getEnabledPaymentMethods, paymentMethodIcon, paymentMethodLabel } from '@/lib/payments';
import { LEDGER_ONLY_NOTICE } from '@/components/history/ledgerNotice';
import { Card } from '@/components/ui/card';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { PaymentTenderPanel } from '@/components/till/PaymentTenderPanel';

export function extensionBandFromScan(
  raw: string,
  bands: readonly ExtensionBand[],
): ExtensionBand | null {
  const parsed = parseHistorySearch(raw);
  return parsed.kind === 'band'
    ? (bands.find((band) => band.shortCode.toUpperCase() === parsed.label.toUpperCase()) ?? null)
    : null;
}

const plural = (count: number) => `${count} bracelet${count === 1 ? '' : 's'}`;

/**
 * Add time on a ticket sale: a separate paid charge scoped to this receipt;
 * the original money is never edited. Returns the approved History screen's
 * three pieces so each sits where the approved design put it: the 'Time
 * added' card among the histories, the Add time button beside Reprint, and
 * the dialogs.
 */
export function useSaleExtensions({
  saleId,
  enabled,
  eligible,
  offline,
  fmt,
  compact = false,
}: {
  saleId: string;
  /** A ticket admission with bracelets; a time charge itself has no Add time. */
  enabled: boolean;
  eligible: boolean;
  offline: boolean;
  fmt: (iso: string) => string;
  /** The phone layout's smaller action buttons. */
  compact?: boolean;
}): { card: ReactNode; button: ReactNode; dialogs: ReactNode } {
  const { can, operator } = useOperator();
  const { active: station } = useStation();
  const [data, setData] = useState<SaleExtensionsRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [resume, setResume] = useState<SaleExtension | null>(null);
  const [revision, setRevision] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    setFlash(null);
  }, [saleId]);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setOpen(false);
    setResume(null);
    if (!enabled) return;
    readSaleExtensions(saleId)
      .then((answer) => {
        if (!cancelled) setData(answer);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Time additions could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [saleId, revision, enabled]);
  if (!enabled) return { card: null, button: null, dialogs: null };
  const allowed = can('pos:sale:create') && Boolean(station) && !offline;
  const pending = data?.extensions.some((entry) => entry.status === 'pending') ?? false;
  const close = () => {
    setOpen(false);
    setRevision((value) => value + 1);
  };
  const card = (
    <>
      {flash && (
        <div
          role="status"
          className="shrink-0 rounded-lg border p-3 text-sm font-medium flex items-center gap-2 border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
        >
          <Check className="w-4 h-4 shrink-0" />
          {flash}
        </div>
      )}
      {data && data.extensions.length > 0 && (
        <Card className="p-4 shrink-0 bg-card/50" aria-label="Time added">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
            Time added
          </div>
          <div className="space-y-2">
            {data.extensions.map((entry) => (
              <div key={entry.id} className="text-sm border-l-2 border-primary/40 pl-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold flex items-center gap-1.5">
                    <Timer className="w-3.5 h-3.5 text-primary" />
                    {entry.label}
                  </span>
                  <span className="font-semibold tabular-nums">฿{baht(entry.amountSatang)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {[
                    plural(entry.braceletCount),
                    ...(entry.paymentMethods?.length
                      ? [entry.paymentMethods.map((method) => paymentMethodLabel(method)).join(' + ')]
                      : []),
                    fmt(entry.createdAt),
                    `by ${entry.createdByName ?? 'recorded staff'}`,
                  ].join(' · ')}
                </div>
                {(entry.status !== 'applied' || entry.needsReselection) && (
                  <div className="text-xs text-muted-foreground">
                    {entry.status === 'voided'
                      ? 'Voided'
                      : entry.status === 'pending'
                        ? 'Payment unfinished'
                        : 'Replacement bracelets needed'}
                  </div>
                )}
                {(entry.status === 'pending' || entry.needsReselection) && (
                  <Button
                    variant="outline"
                    className="mt-1"
                    disabled={!allowed}
                    onClick={() => {
                      setResume(entry);
                      setOpen(true);
                    }}
                  >
                    {entry.needsReselection ? 'Update replacement bracelets' : 'Resume payment'}
                  </Button>
                )}
              </div>
            ))}
          </div>
          {pending && (
            <p className="mt-2 text-xs text-muted-foreground">
              Resume the unfinished payment before adding more time.
            </p>
          )}
        </Card>
      )}
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}{' '}
          <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
    </>
  );
  const button = (
    <Button
      variant="outline"
      className={compact ? 'h-12 gap-2' : 'h-14 text-base gap-2'}
      disabled={!eligible || !allowed || !data || data.eligibleBands.length === 0 || pending}
      title={offline ? LEDGER_ONLY_NOTICE : undefined}
      onClick={() => {
        setFlash(null);
        setResume(null);
        setOpen(true);
      }}
    >
      <Timer className={compact ? 'w-4 h-4' : 'w-5 h-5'} />
      Add time
    </Button>
  );
  const dialogs = (
    <>
      {open && data && station && resume?.needsReselection && (
        <ExtensionBandRecovery
          key={`${saleId}:${station.id}:${resume.id}`}
          saleId={saleId}
          stationId={station.id}
          entry={resume}
          bands={data.eligibleBands}
          onClose={close}
        />
      )}
      {open && data && station && !resume?.needsReselection && (
        <ExtensionPayment
          key={`${saleId}:${station.id}:${resume?.id ?? 'new'}`}
          saleId={saleId}
          stationId={station.id}
          data={data}
          resume={resume}
          operatorName={operator?.name ?? 'this account'}
          onClose={close}
          onPaid={({ label, braceletCount }) => {
            const total = data.eligibleBands.length;
            setFlash(`Added ${label} to ${braceletCount} of ${plural(total)}`);
          }}
        />
      )}
    </>
  );
  return { card, button, dialogs };
}

export function ExtensionPayment({
  saleId,
  stationId,
  data,
  resume,
  operatorName,
  onClose,
  onPaid,
}: {
  saleId: string;
  stationId: string;
  data: SaleExtensionsRead;
  resume: SaleExtension | null;
  operatorName: string;
  onClose: () => void;
  /** The approved History flash once the charge is paid: what was added, to how many. */
  onPaid?: (paid: { label: string; braceletCount: number }) => void;
}) {
  const { offlineUnlock, locked: operatorLocked } = useOperator();
  const [optionId, setOptionId] = useState(resume?.optionId ?? '');
  const [mode, setMode] = useState<'bands' | 'count'>(resume?.selection.mode ?? 'bands');
  const [bandIds, setBandIds] = useState<string[]>(
    resume?.selection.mode === 'bands'
      ? (resume.currentBandIds ?? resume.selection.bandIds)
      : data.eligibleBands.map((band) => band.id),
  );
  const [count, setCount] = useState(resume?.braceletCount ?? data.eligibleBands.length);
  const [scan, setScan] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(Boolean(resume));
  const bodyRef = useRef<SaleExtensionBody | null>(null);
  const chargeRef = useRef<ApiSale | null>(null);
  const [charge, setCharge] = useState<ApiSale | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const option = data.options.find((item) => item.id === optionId);
  const quantity = mode === 'bands' ? bandIds.length : count;
  const totalSatang =
    charge?.totals.grossSatang ??
    resume?.amountSatang ??
    (option ? option.unitSatang * quantity : 0);
  const selection: ExtensionSelection =
    mode === 'bands' ? { mode, bandIds } : { mode, braceletCount: count };
  const outcome = (sale: ApiSale): SaleWriteOutcome => ({
    ok: true,
    written: true,
    sale,
    saleId: sale.id,
    replay: true,
  });
  const prepare = async (): Promise<SaleWriteOutcome> => {
    if (chargeRef.current) return outcome(chargeRef.current);
    if (resume) {
      const result = await salesApi.get(resume.chargeSaleId);
      chargeRef.current = result.sale;
      return outcome(result.sale);
    }
    if (!option || quantity < 1)
      return {
        ok: false,
        saleId,
        message: 'Choose a duration and bracelets first.',
        retryable: false,
      };
    bodyRef.current ??= { actionId: newActionId(), stationId, optionId, selection };
    setFrozen(true);
    const result = await createSaleExtension(saleId, bodyRef.current);
    chargeRef.current = result.sale;
    if (current.current) setCharge(result.sale);
    return outcome(result.sale);
  };
  const prepareCharge = async () => {
    if (preparing || operatorLocked || offlineUnlock) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      await prepare();
    } catch (err) {
      if (!current.current) return;
      setPrepareError(err instanceof Error ? err.message : 'The charge could not be confirmed.');
      if (err instanceof ApiError && err.status < 500 && err.code !== 'IDEMPOTENCY_IN_FLIGHT') {
        bodyRef.current = null;
        setFrozen(false);
      }
    } finally {
      if (current.current) setPreparing(false);
    }
  };
  const stage = usePaymentStage({
    scope: `${saleId}:${stationId}:${resume?.id ?? charge?.id ?? 'preparing'}`,
    isCurrentScope: () => current.current,
    paused: operatorLocked || Boolean(offlineUnlock),
    active: Boolean(charge || resume),
    totalSatang,
    resumeSaleId: resume?.chargeSaleId ?? charge?.id,
    prepareSale: prepare,
    finaliseSale: async (tender, actionId) => {
      const chargeId = chargeRef.current?.id ?? resume?.chargeSaleId;
      if (!chargeId || !actionId)
        return {
          ok: false,
          saleId,
          message: 'The time charge has not been recorded.',
          retryable: true,
        };
      try {
        const answer = await finaliseSale(chargeId, actionId, tender);
        return { ok: true, written: true, saleId: chargeId, ...answer };
      } catch (err) {
        return {
          ok: false,
          saleId: chargeId,
          message: err instanceof Error ? err.message : 'The payment could not be confirmed.',
          retryable:
            !(err instanceof ApiError) || err.status >= 500 || err.code === 'IDEMPOTENCY_IN_FLIGHT',
          ...(err instanceof ApiError ? { code: err.code } : {}),
        };
      }
    },
    onComplete: () => {
      const label = option?.label ?? resume?.label;
      if (label) onPaid?.({ label, braceletCount: resume?.braceletCount ?? quantity });
      if (current.current) onClose();
    },
  });
  useEffect(() => {
    if (stage.state.error?.includes('Choose the replacement bracelets')) onClose();
  }, [stage.state.error, onClose]);
  const locked =
    frozen || preparing || operatorLocked || Boolean(offlineUnlock) || stage.busy || stage.locked;
  const addScan = () => {
    const match = extensionBandFromScan(scan, data.eligibleBands);
    setScan('');
    if (!match) {
      setScanError('This bracelet is not eligible on this receipt.');
      return;
    }
    setScanError(null);
    setBandIds((ids) => (ids.includes(match.id) ? ids : [...ids, match.id]));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !preparing && stage.canBack && (!frozen || chargeRef.current || resume))
          onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Add time
          </DialogTitle>
          <DialogDescription>
            By {operatorName} · extend some or all of the {plural(data.eligibleBands.length)} on
            this booking.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={locked} className="space-y-5 py-2">
          <p className="text-sm font-medium text-muted-foreground">How many bracelets?</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={mode === 'bands' ? 'default' : 'outline'}
              onClick={() => setMode('bands')}
            >
              Select or scan bracelets
            </Button>
            <Button
              variant={mode === 'count' ? 'default' : 'outline'}
              onClick={() => setMode('count')}
            >
              Count only
            </Button>
          </div>
          {mode === 'count' ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Records payment for this quantity. No individual bracelet is selected or changed.
              </p>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <QuantityStepper
                    value={count}
                    onChange={setCount}
                    min={1}
                    max={data.eligibleBands.length}
                    ariaLabel="bracelet"
                  />
                  <span className="text-sm text-muted-foreground">
                    of {data.eligibleBands.length}
                  </span>
                </div>
                <Button
                  type="button"
                  variant={count >= data.eligibleBands.length ? 'default' : 'outline'}
                  className="h-11"
                  onClick={() => setCount(data.eligibleBands.length)}
                >
                  All {data.eligibleBands.length}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  aria-label="Scan bracelet"
                  type="password"
                  autoComplete="off"
                  value={scan}
                  onChange={(event) => setScan(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addScan();
                    }
                  }}
                />
                <Button onClick={addScan}>Add bracelet</Button>
              </div>
              {scanError && (
                <p role="alert" className="text-sm text-destructive">
                  {scanError}
                </p>
              )}
              {data.eligibleBands.map((band) => (
                <label key={band.id} className="flex items-center gap-3 p-2 border rounded">
                  <input
                    type="checkbox"
                    checked={bandIds.includes(band.id)}
                    onChange={(event) =>
                      setBandIds((ids) =>
                        event.target.checked
                          ? [...ids, band.id]
                          : ids.filter((id) => id !== band.id),
                      )
                    }
                  />
                  {band.shortCode}
                </label>
              ))}
              <Button
                variant="outline"
                onClick={() => setBandIds(data.eligibleBands.map((band) => band.id))}
              >
                All {data.eligibleBands.length}
              </Button>
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">How much time?</p>
            <div className="space-y-2">
              {data.options.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setOptionId(item.id)}
                  className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                    optionId === item.id
                      ? 'border-primary ring-1 ring-primary bg-primary/5'
                      : 'hover:bg-muted'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{item.label}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      ฿{baht(item.unitSatang)} × {plural(quantity)}
                    </span>
                  </span>
                  <span className="font-bold tabular-nums shrink-0">
                    ฿{baht(item.unitSatang * quantity)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </fieldset>
        <div className="rounded-lg bg-muted p-4 flex items-center justify-between">
          <span className="text-muted-foreground">Amount to charge</span>
          <span className="text-2xl font-black tabular-nums">฿{baht(totalSatang)}</span>
        </div>
        {prepareError && (
          <p role="alert" className="text-sm text-destructive">
            {prepareError}
          </p>
        )}
        {!charge && !resume ? (
          <>
            <p className="text-xs text-muted-foreground">
              The payment total, including applicable tax and service charge, is confirmed before
              collection.
            </p>
            <Button
              className="w-full h-14"
              disabled={
                !option ||
                quantity < 1 ||
                preparing ||
                operatorLocked ||
                Boolean(offlineUnlock) ||
                !stage.online
              }
              onClick={() => void prepareCharge()}
            >
              {preparing
                ? 'Preparing charge…'
                : prepareError && frozen
                  ? 'Check original charge'
                  : !option
                    ? 'Choose a duration'
                    : 'Continue to payment'}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-muted-foreground">
              Payment <span className="text-destructive">*</span>
            </p>
            <div className="grid grid-cols-3 gap-2">
              {getEnabledPaymentMethods().map((method) => {
                const Icon = paymentMethodIcon(method.kind);
                return (
                  <Button
                    key={method.id}
                    variant={stage.state.method === method.id ? 'default' : 'outline'}
                    className="h-14 flex-col gap-1"
                    disabled={stage.locked || stage.busy}
                    onClick={() => stage.selectMethod(method.id)}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs">{method.label}</span>
                  </Button>
                );
              })}
            </div>
            <PaymentTenderPanel stage={stage} />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Play time only. Supervised check-in timers are unchanged.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** Repair only the invalid credential slots on the existing paid or pending
 * charge. Its original selection and money remain on the ledger. */
export function ExtensionBandRecovery({ saleId, stationId, entry, bands, onClose }: {
  saleId: string; stationId: string; entry: SaleExtension; bands: ExtensionBand[]; onClose: () => void;
}) {
  const { locked, offlineUnlock } = useOperator();
  const fixed = (entry.currentBandIds ?? []).filter((id) => bands.some((band) => band.id === id));
  const [selected, setSelected] = useState<string[]>(fixed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frozen = useRef<{ actionId: string; stationId: string; bandIds: string[] } | null>(null);
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const submit = async () => {
    if (busy || locked || offlineUnlock || selected.length !== entry.braceletCount) return;
    frozen.current ??= { actionId: newActionId(), stationId, bandIds: selected };
    setBusy(true); setError(null);
    try {
      await reselectExtensionBands(saleId, entry.id, frozen.current);
      if (current.current) onClose();
    } catch (err) {
      if (!current.current) return;
      setError(err instanceof Error ? err.message : 'The replacement bracelets could not be saved.');
      if (err instanceof ApiError && err.status < 500 && err.code !== 'IDEMPOTENCY_IN_FLIGHT') frozen.current = null;
    } finally { if (current.current) setBusy(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !frozen.current) onClose(); }}>
    <DialogContent><DialogHeader><DialogTitle>Update replacement bracelets</DialogTitle>
      <DialogDescription>Select {entry.braceletCount} bracelets for this time addition. Active selections stay fixed. The amount and paid minutes do not change.</DialogDescription>
    </DialogHeader>
    <div className="space-y-2">{bands.map((band) => <label key={band.id} className="flex gap-3 items-center p-3 border rounded">
      <input type="checkbox" checked={selected.includes(band.id)} disabled={busy || Boolean(frozen.current) || locked || Boolean(offlineUnlock) || fixed.includes(band.id)}
        onChange={() => setSelected((ids) => ids.includes(band.id) ? ids.filter((id) => id !== band.id) : [...ids, band.id])} />
      {band.shortCode}{fixed.includes(band.id) ? ' (still active)' : ''}
    </label>)}</div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button disabled={busy || locked || Boolean(offlineUnlock) || selected.length !== entry.braceletCount} onClick={() => void submit()}>
      {busy ? 'Saving replacement bracelets...' : 'Save replacement bracelets'}
    </Button>
    </DialogContent>
  </Dialog>;
}
