import { useEffect, useReducer, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AlertTriangle, FileText, Loader2, RefreshCw } from "lucide-react";
import {
  TILL_NOT_REACHABLE,
  bahtOfSatang,
  tillFiguresOf,
  tillProblemOf,
  type TillBillingReading,
  type TillFigures,
} from "@shared/tillBilling";
import type { BeoEventBilling } from "@shared/schema";
import { DepositBuffer, type BillingPatch } from "@/lib/beo-deposit-buffer";
import { BeoBillingModule } from "./beo-billing-module";

/**
 * A PARTY'S MONEY IN THE BEO, FROM THE TILL (SCRUM-822).
 *
 * One place for the money: the till's payments are the ledger, and every
 * screen of the BEO that shows a party's money reads the same figures from it
 * (shared/tillBilling.ts) — the Billing section's "From the till" panel, the
 * Party Details box, the Day-of view's POS section, the view-only page's Party
 * Details (and, on paper, the BEO PDF: server/lib/beoPdfMoney.ts). None of
 * them adds anything up; when the till cannot be reached they say "Till not
 * reachable", and for an event the till never settles (a camp, a workshop)
 * "Not settled at the till" (tillProblemOf).
 */

/** The query every screen shares, so one "Refresh from the till" refreshes them all. */
export const tillBillingKey = (eventId: string) => ["/api/events", eventId, "beo", "till-billing"] as const;

/** How often an open BEO screen asks the till again: once a minute. */
export const TILL_BILLING_LIVE_MS = 60_000;

/**
 * The till's figures are read live, never kept: the app's queries default to
 * never going stale and never refetching (lib/queryClient.ts), which left a
 * BEO open, or reopened within the cache's life, showing a quote the till had
 * already settled. So: stale at once, read afresh whenever a screen showing
 * them opens or the window comes back, and every minute while one is open
 * (`refetchInterval: false` for a screen inside another that already polls).
 */
export function tillBillingQueryOptions(eventId: string, options: { refetchInterval?: number | false } = {}) {
  return {
    queryKey: tillBillingKey(eventId),
    enabled: !!eventId,
    staleTime: 0,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: true,
    refetchInterval: options.refetchInterval === undefined ? TILL_BILLING_LIVE_MS : options.refetchInterval,
  };
}

export function useTillBilling(eventId: string, options: { refetchInterval?: number | false } = {}) {
  return useQuery<TillBillingReading>(tillBillingQueryOptions(eventId, options));
}

/** "Read 14:05" — when the figures were read from the till. */
function readAtOf(reading: TillBillingReading | undefined): string | null {
  if (!reading || reading.status !== "ok") return null;
  const at = new Date(reading.readAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
}

/**
 * The three figures, each on its own row: Expected total, Deposit paid,
 * Outstanding (Total, Paid and Outstanding once settled) — or why there are
 * none. For the Party Details box and the Day-of view.
 */
export function TillMoneyRows({ reading, loading }: { reading: TillBillingReading | undefined; loading?: boolean }) {
  const figures = tillFiguresOf(reading);
  if (!figures) {
    if (loading && !reading) {
      return (
        <p className="text-xs text-muted-foreground flex items-center gap-1" data-testid="text-till-loading">
          <Loader2 className="h-3 w-3 animate-spin" /> Asking the till…
        </p>
      );
    }
    const problem = tillProblemOf(reading);
    return (
      <div className="text-sm" data-testid="text-till-unavailable">
        <p className="font-medium text-amber-600">{problem?.headline ?? "Till not reachable"}</p>
        {problem?.detail && <p className="text-xs text-muted-foreground">{problem.detail}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-1" data-testid="till-money-rows">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{figures.kind === "sale" ? "Total" : "Expected total"}</span>
        <span className="font-semibold font-mono" data-testid="text-till-expected">{bahtOfSatang(figures.expectedSatang)}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Deposit paid</span>
        <span className="font-mono text-emerald-600" data-testid="text-till-deposit">{bahtOfSatang(figures.depositSatang)}</span>
      </div>
      <div className="flex items-center justify-between text-sm font-semibold pt-0.5 border-t border-dashed border-border/50">
        <span>Outstanding</span>
        <span className={`font-mono ${figures.outstandingSatang > 0 ? "text-amber-600" : "text-emerald-600"}`} data-testid="text-till-outstanding">
          {bahtOfSatang(figures.outstandingSatang)}
        </span>
      </div>
    </div>
  );
}

/**
 * The Party Details box's three tiles: Total and Outstanding from the till,
 * and between them the deposit, which stays the BEO's one figure (SCRUM-813:
 * typed here or in the billing, saved, and read by the till). A deposit typed
 * and not saved yet is said, since the till reads the saved one.
 */
export function PartyDetailsTillTiles({
  reading,
  loading,
  deposit,
  depositUnsaved,
}: {
  reading: TillBillingReading | undefined;
  loading?: boolean;
  deposit: ReactNode;
  depositUnsaved?: boolean;
}) {
  const figures = tillFiguresOf(reading);
  const problem = figures ? null : tillProblemOf(reading);
  const missing = figures ? null : loading && !reading ? "Asking the till…" : (problem?.headline ?? TILL_NOT_REACHABLE);
  const owed = figures ? figures.outstandingSatang > 0 : false;
  const readAt = figures ? readAtOf(reading) : null;
  return (
    <div className="space-y-2" data-testid="party-details-till">
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1 p-3 rounded-md bg-primary/5 border">
          <Label className="text-xs text-muted-foreground">Total · from the till</Label>
          <p className={`font-bold font-mono ${figures ? "text-lg" : "text-sm text-amber-600"}`} data-testid="text-package-total">
            {figures ? bahtOfSatang(figures.expectedSatang) : missing}
          </p>
        </div>
        <div className="space-y-1 p-3 rounded-md border">{deposit}</div>
        <div
          className={cn(
            "space-y-1 p-3 rounded-md border",
            figures && owed && figures.depositSatang <= 0 && "bg-red-500/10 border-red-500/30",
            figures && owed && figures.depositSatang > 0 && "bg-orange-500/10 border-orange-500/30",
            figures && !owed && "bg-green-500/10 border-green-500/30",
          )}
        >
          <Label className="text-xs text-muted-foreground">Outstanding</Label>
          <p
            className={cn(
              "font-bold font-mono",
              figures ? "text-lg" : "text-sm text-amber-600",
              figures && owed && figures.depositSatang <= 0 && "text-red-600 dark:text-red-400",
              figures && owed && figures.depositSatang > 0 && "text-orange-600 dark:text-orange-400",
              figures && !owed && "text-green-600 dark:text-green-400",
            )}
            data-testid="text-outstanding-balance"
          >
            {figures ? bahtOfSatang(figures.outstandingSatang) : missing}
          </p>
          {figures && owed && figures.depositSatang <= 0 && <p className="text-xs text-red-600">No deposit yet</p>}
        </div>
      </div>
      {problem?.detail && (
        <p className="text-xs text-muted-foreground" data-testid="text-party-details-till-problem">
          {problem.detail}
        </p>
      )}
      {readAt && (
        <p className="text-xs text-muted-foreground" data-testid="text-party-details-read-at">
          {figures?.kind === "sale" ? "Settled at the till" : "The till's quote"}, read {readAt}.
        </p>
      )}
      {depositUnsaved && (
        <p className="text-xs text-amber-600" data-testid="text-deposit-unsaved">
          Save the BEO to send the new deposit to the till: the figures beside it are the saved deposit's.
        </p>
      )}
    </div>
  );
}

/** The breakdown: each line as the till prices it, a free line marked included. */
export function TillBreakdown({ figures }: { figures: TillFigures }) {
  return (
    <div className="space-y-0.5" data-testid="list-till-lines">
      {figures.lines.map((line, i) => (
        <div key={`${line.label}-${i}`} className="flex items-center justify-between gap-2 text-sm py-0.5" data-testid={`row-till-line-${i}`}>
          <span className="truncate">
            {line.label}
            {line.quantity > 1 ? <span className="text-muted-foreground"> × {line.quantity}</span> : null}
          </span>
          <span className="font-mono tabular-nums shrink-0">
            {line.totalSatang === 0 ? <span className="text-xs text-emerald-600">Included</span> : bahtOfSatang(line.totalSatang)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The Billing section's "From the till" panel. Before the party is settled:
 * Expected total, Deposit paid, Outstanding and the breakdown, with the Quote
 * PDF. After: the sale — its receipt, lines and payments — read live.
 */
export function TillBillingPanel({
  eventId,
  reading,
  loading,
  refreshing,
  onRefresh,
}: {
  eventId: string;
  reading: TillBillingReading | undefined;
  loading?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const figures = tillFiguresOf(reading);
  const problem = figures ? null : tillProblemOf(reading);
  const readAt = readAtOf(reading);
  const sale = reading?.status === "ok" ? reading.billing.sale : null;
  return (
    <Card className="border-2 border-emerald-500/30" data-testid="panel-from-the-till">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center justify-between gap-2 flex-wrap">
          <span>From the till</span>
          <span className="flex items-center gap-2">
            {figures?.kind === "sale" && (
              <Badge className={figures.saleState === "settled" ? "bg-green-600" : "bg-amber-600"} data-testid="badge-till-sale-state">
                {figures.saleState === "settled" ? "Settled" : "Open at the till"}
              </Badge>
            )}
            {figures?.kind === "quote" && <Badge variant="outline" data-testid="badge-till-quote">Quote</Badge>}
            {onRefresh && (
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing} data-testid="button-refresh-from-till">
                {refreshing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                Refresh from the till
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!figures && loading && !reading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Asking the till…
          </p>
        ) : !figures ? (
          <div className="flex items-start gap-2 text-sm" data-testid="text-till-unavailable">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{problem?.headline ?? "Till not reachable"}</p>
              {problem?.detail && <p className="text-muted-foreground">{problem.detail}</p>}
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1 p-3 rounded-md bg-primary/5 border">
                <p className="text-xs text-muted-foreground">{figures.kind === "sale" ? "Total" : "Expected total"}</p>
                <p className="text-lg font-bold font-mono" data-testid="text-till-panel-expected">{bahtOfSatang(figures.expectedSatang)}</p>
              </div>
              <div className="space-y-1 p-3 rounded-md border">
                <p className="text-xs text-muted-foreground">Deposit paid</p>
                <p className="text-lg font-bold font-mono text-emerald-600" data-testid="text-till-panel-deposit">{bahtOfSatang(figures.depositSatang)}</p>
              </div>
              <div className="space-y-1 p-3 rounded-md border">
                <p className="text-xs text-muted-foreground">Outstanding</p>
                <p
                  className={`text-lg font-bold font-mono ${figures.outstandingSatang > 0 ? "text-amber-600" : "text-emerald-600"}`}
                  data-testid="text-till-panel-outstanding"
                >
                  {bahtOfSatang(figures.outstandingSatang)}
                </p>
              </div>
            </div>
            {sale && (
              <div className="text-sm space-y-0.5" data-testid="text-till-receipt">
                <p>
                  <span className="text-muted-foreground">Receipt </span>
                  <span className="font-mono font-medium">{sale.receiptNumber ?? "not numbered yet"}</span>
                  {sale.stationName ? <span className="text-muted-foreground"> · {sale.stationName}</span> : null}
                </p>
                {sale.settledAt && (
                  <p className="text-xs text-muted-foreground">
                    Settled {new Date(sale.settledAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" })}
                  </p>
                )}
              </div>
            )}
            <div className="border rounded-md p-3 bg-muted/30">
              <p className="text-xs font-medium text-muted-foreground mb-1">{figures.kind === "sale" ? "The sale" : "What the party comes to"}</p>
              <TillBreakdown figures={figures} />
            </div>
            {sale && sale.payments.length > 0 && (
              <div className="border rounded-md p-3" data-testid="list-till-payments">
                <p className="text-xs font-medium text-muted-foreground mb-1">Payments</p>
                {sale.payments.map((p, i) => (
                  <div key={p.id} className="flex items-center justify-between text-sm py-0.5" data-testid={`row-till-payment-${i}`}>
                    <span>{p.label}</span>
                    <span className="font-mono">{bahtOfSatang(p.amountSatang)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs text-muted-foreground">
                The till's figures{readAt ? `, read ${readAt}` : ""}. Nothing here is typed twice.
              </p>
              {figures.kind === "quote" && (
                <Button variant="outline" size="sm" asChild data-testid="button-quote-pdf">
                  <a href={`/api/events/${eventId}/beo/quote.pdf`} target="_blank" rel="noopener noreferrer">
                    <FileText className="h-4 w-4 mr-1" />
                    Quote PDF
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The BEO's BILLING section: "From the till" at the top, then the app's own
 * billing module kept whole — its invoice rows, Generate from BEO and the
 * Deposit Paid that feeds the till (SCRUM-813) — labelled as the app's own.
 */
export function BeoBillingSection({
  eventId,
  billing,
  onBillingChange,
  isManager,
}: {
  eventId: string;
  billing: BeoEventBilling | null;
  /** One billing write; a promise settles when the server has answered. */
  onBillingChange: (billing: Partial<BeoEventBilling>) => Promise<unknown> | void;
  isManager: boolean;
}) {
  // The editor around it reads the till every minute; this one reads afresh when the section opens.
  const till = useTillBilling(eventId, { refetchInterval: false });
  const deposit = useBufferedDeposit(billing, onBillingChange);
  return (
    <div className="space-y-4" data-testid="section-billing">
      <TillBillingPanel
        eventId={eventId}
        reading={till.data}
        loading={till.isLoading}
        refreshing={till.isFetching}
        onRefresh={() => void till.refetch()}
      />
      <div className="space-y-1" data-testid="text-app-invoice-rows">
        <p className="text-sm font-medium">The app's own invoice rows</p>
        <p className="text-xs text-muted-foreground">
          Kept for the staff who use them. What the party pays is the till's, above; the deposit paid here is the party's one deposit and the till reads it.
        </p>
      </div>
      <div onChangeCapture={deposit.onChangeCapture} onBlur={deposit.onBlur} onKeyDown={deposit.onKeyDown}>
        <BeoBillingModule eventId={eventId} billing={deposit.billing} onBillingChange={deposit.onBillingChange} isManager={isManager} />
      </div>
    </div>
  );
}

/** The billing module's Deposit Paid input (beo-billing-module.tsx, kept whole). */
const DEPOSIT_INPUT_TEST_ID = "input-deposit-amount";
const isDepositInput = (target: EventTarget | null): target is HTMLInputElement =>
  typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement && target.dataset.testid === DEPOSIT_INPUT_TEST_ID;

/**
 * The billing module's deposit, sent once (lib/beo-deposit-buffer.ts): its
 * keystrokes are held here and shown over the saved billing, and one write
 * goes on blur, Enter or a pause in typing. The module itself is unchanged:
 * the wrapper reads the raw field (an emptied field is never sent as 0) and
 * its blur and Enter as they bubble.
 */
function useBufferedDeposit(billing: BeoEventBilling | null, send: (patch: BillingPatch) => Promise<unknown> | void) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const savedRef = useRef(0);
  savedRef.current = billing?.depositPaidAmount || 0;
  const [buffer] = useState(
    () => new DepositBuffer({ send: (patch) => sendRef.current(patch), saved: () => savedRef.current, onChange: rerender }),
  );
  useEffect(() => () => buffer.dispose(), [buffer]);
  const raw = useRef<string | null>(null);

  const shown = buffer.shown();
  const overlaid =
    shown === undefined ? billing : ({ ...((billing ?? {}) as Partial<BeoEventBilling>), depositPaidAmount: shown, depositPaid: shown > 0 } as BeoEventBilling);

  return {
    billing: overlaid,
    onBillingChange: (patch: BillingPatch) => {
      if ("depositPaidAmount" in patch) {
        const typed = raw.current;
        raw.current = null;
        buffer.type(typed !== null && typed.trim() === "" ? null : Number(patch.depositPaidAmount) || 0);
        return;
      }
      buffer.pass(patch);
    },
    onChangeCapture: (e: SyntheticEvent) => {
      if (isDepositInput(e.target)) raw.current = e.target.value;
    },
    onBlur: (e: FocusEvent) => {
      if (isDepositInput(e.target)) buffer.flush();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && isDepositInput(e.target)) buffer.flush();
    },
  };
}
