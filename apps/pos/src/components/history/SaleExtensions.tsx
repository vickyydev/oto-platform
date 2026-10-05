import { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import {
  baht,
  createSaleExtension,
  newActionId,
  parseHistorySearch,
  readSaleExtensions,
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
import { getEnabledPaymentMethods, paymentMethodIcon } from '@/lib/payments';
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

/** A separate paid charge, scoped to this receipt; original money is never edited. */
export function SaleExtensions({
  saleId,
  eligible,
  offline,
}: {
  saleId: string;
  eligible: boolean;
  offline: boolean;
}) {
  const { can, operator } = useOperator();
  const { active: station } = useStation();
  const [data, setData] = useState<SaleExtensionsRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [resume, setResume] = useState<SaleExtension | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setOpen(false);
    setResume(null);
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
  }, [saleId, revision]);
  const allowed = can('pos:sale:create') && Boolean(station) && !offline;
  return (
    <section className="space-y-3" aria-label="Time added">
      {data && data.extensions.length > 0 && (
        <div className="rounded-lg border p-3 space-y-3">
          <h3 className="font-semibold">Time added</h3>
          {data.extensions.map((entry) => (
            <div key={entry.id} className="text-sm space-y-1">
              <div className="flex justify-between gap-3">
                <span>
                  {entry.label} · {entry.braceletCount} bracelets
                </span>
                <strong>฿{baht(entry.amountSatang)}</strong>
              </div>
              <p className="text-muted-foreground">
                {entry.selection.mode === 'count'
                  ? 'Count only — no individual bracelet selected'
                  : 'Selected bracelets'}{' '}
                ·{' '}
                {entry.status === 'applied'
                  ? 'Paid'
                  : entry.status === 'voided'
                    ? 'Voided'
                    : 'Payment unfinished'}
              </p>
              <p className="text-xs text-muted-foreground">
                {entry.createdByName ?? 'Recorded staff'} ·{' '}
                {new Date(entry.createdAt).toLocaleString()}
              </p>
              {entry.status === 'pending' && (
                <Button
                  variant="outline"
                  disabled={!allowed}
                  onClick={() => {
                    setResume(entry);
                    setOpen(true);
                  }}
                >
                  Resume payment
                </Button>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            These charges are separate from the original receipt.
          </p>
        </div>
      )}
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}{' '}
          <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      <Button
        variant="outline"
        className="w-full h-14 gap-2"
        disabled={
          !eligible ||
          !allowed ||
          !data ||
          data.eligibleBands.length === 0 ||
          data.extensions.some((entry) => entry.status === 'pending')
        }
        onClick={() => {
          setResume(null);
          setOpen(true);
        }}
      >
        <Timer className="w-5 h-5" />
        Add time{offline ? ' — online only' : ''}
      </Button>
      {data?.extensions.some((entry) => entry.status === 'pending') && (
        <p className="text-xs text-muted-foreground">
          Resume the unfinished payment before adding more time.
        </p>
      )}
      {open && data && station && (
        <ExtensionPayment
          key={`${saleId}:${station.id}:${resume?.id ?? 'new'}`}
          saleId={saleId}
          stationId={station.id}
          data={data}
          resume={resume}
          operatorName={operator?.name ?? 'this account'}
          onClose={() => {
            setOpen(false);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}

export function ExtensionPayment({
  saleId,
  stationId,
  data,
  resume,
  operatorName,
  onClose,
}: {
  saleId: string;
  stationId: string;
  data: SaleExtensionsRead;
  resume: SaleExtension | null;
  operatorName: string;
  onClose: () => void;
}) {
  const { offlineUnlock, locked: operatorLocked } = useOperator();
  const [optionId, setOptionId] = useState(resume?.optionId ?? '');
  const [mode, setMode] = useState<'bands' | 'count'>(resume?.selection.mode ?? 'bands');
  const [bandIds, setBandIds] = useState<string[]>(
    resume?.selection.mode === 'bands'
      ? resume.selection.bandIds
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
      if (current.current) onClose();
    },
  });
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
          <DialogTitle>Add time</DialogTitle>
          <DialogDescription>
            By {operatorName}. The original receipt stays unchanged.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={locked} className="space-y-4">
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
              <p className="text-sm">
                Records payment for this quantity. No individual bracelet is selected or changed.
              </p>
              <QuantityStepper
                value={count}
                onChange={setCount}
                min={1}
                max={data.eligibleBands.length}
                ariaLabel="bracelet"
              />
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
          <p className="font-medium">How much time?</p>
          {data.options.map((item) => (
            <Button
              key={item.id}
              className="w-full h-auto py-3 justify-between"
              variant={optionId === item.id ? 'default' : 'outline'}
              onClick={() => setOptionId(item.id)}
            >
              <span>
                {item.label}
                <small className="block">
                  ฿{baht(item.unitSatang)} × {quantity} bracelets
                </small>
              </span>
              <strong>฿{baht(item.unitSatang * quantity)}</strong>
            </Button>
          ))}
        </fieldset>
        <div className="flex justify-between font-bold">
          <span>Amount to charge</span>
          <span>฿{baht(totalSatang)}</span>
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
                  : 'Continue to payment'}
            </Button>
          </>
        ) : (
          <>
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
