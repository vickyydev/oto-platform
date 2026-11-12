import { useEffect, useReducer, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangle, FileText, Link2, Loader2, MessageCircle, RefreshCw, Send, XCircle } from "lucide-react";
import {
  TILL_NOT_REACHABLE,
  bahtOfSatang,
  tillFiguresOf,
  tillProblemOf,
  type TillBillingReading,
  type TillFigures,
} from "@shared/tillBilling";
import {
  NO_CONVERSATION_WORDS,
  depositAmountOf,
  depositProblemOf,
  depositRequestProblem,
  depositStateWordsOf,
  type PartyDepositActionAnswer,
  type PartyDepositReading,
  type PartyDepositRequest,
} from "@shared/partyDeposit";
import type { BeoEventBilling } from "@shared/schema";
import { DepositBuffer, patchOverEventDeposit, summaryBillingOf, type BillingPatch, type EventDeposit } from "@/lib/beo-deposit-buffer";
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

// --- A deposit asked from the BEO (SCRUM-825) ---------------------------------------------

/** The query the deposit request's state is read on; invalidated after every press. */
export const depositRequestKey = (eventId: string) => ["/api/events", eventId, "beo", "deposit-request"] as const;

/**
 * The request's state is the platform's, read live as the till's figures are:
 * stale at once, afresh whenever the section opens, and every minute while
 * it is open — the family pays in their own time, and the state moves without
 * a press here.
 */
export function useDepositRequest(eventId: string, options: { refetchInterval?: number | false } = {}) {
  return useQuery<PartyDepositReading>({
    queryKey: depositRequestKey(eventId),
    enabled: !!eventId,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: options.refetchInterval === undefined ? TILL_BILLING_LIVE_MS : options.refetchInterval,
  });
}

/**
 * The press's id, minted once per press and kept while the press may have
 * reached the platform without an answer coming back — a lost connection, or
 * this app's server unable to reach the till (a 5xx): the retry is the same
 * press, so a request made behind the silence is answered as made, never made
 * twice. Spent once the server ANSWERED it — a success, or a refusal (a 4xx):
 * a refused press is over, and the next press is a new one, not a replay of a
 * request the platform closed.
 */
function usePressId() {
  const held = useRef<string | null>(null);
  return {
    take: () => (held.current ??= globalThis.crypto.randomUUID()),
    spend: () => {
      held.current = null;
    },
  };
}

/**
 * SCRUM-927: the deposit the BEO asks and has not received (billing's deposit required, the
 * amount the AI fill's approval or staff wrote), in whole baht; null when it asks none.
 */
export function depositAskedOf(billing: Pick<BeoEventBilling, "depositRequired" | "depositAmount" | "depositPaid"> | null | undefined): number | null {
  if (!billing?.depositRequired || billing.depositPaid) return null;
  return typeof billing.depositAmount === "number" && billing.depositAmount > 0 ? billing.depositAmount : null;
}

/** SCRUM-927: what the box says while the BEO asks a deposit and no payment link has been sent. */
export const depositAskedWords = (baht: number): string =>
  `The BEO asks a ฿${baht.toLocaleString("en-US")} deposit. No payment link has been sent yet: request it below and the assistant posts the link in the family's chat and confirms when it is paid.`;

/** apiRequest throws an ApiError carrying the status when the server answered; a 4xx is the press refused, and over. */
const pressRefused = (err: unknown): boolean => {
  const status = err instanceof Error ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 500;
};

/** The message the server put on a refusal, in its own words. */
function refusalWords(err: unknown, fallback: string): string {
  const said = err instanceof Error ? err.message : "";
  // apiRequest throws "<status>: <message>"; the words after the status are the server's.
  const m = /^\d{3}:\s*(.*)$/s.exec(said);
  return (m ? m[1] : said)?.trim() || fallback;
}

/**
 * The Billing section's DEPOSIT REQUEST (SCRUM-825): type the deposit to ask
 * for and press "Request deposit" — the platform mints the 2C2P payment link
 * and the inbox assistant posts it in the family's chat, then watches the
 * payment. While a request is open the panel shows it ("Deposit requested ·
 * ฿3,000 · the link is in the family's chat, valid until …"), with "Resend"
 * and "Cancel request"; once paid, "Deposit paid" — and the deposit figure
 * above moves on its own, written back by the platform. "Send the menu choice
 * link" posts the parent's set-menu link the same way. Nothing here is money:
 * the figures stay the till's.
 */
export function DepositRequestPanel({
  eventId,
  reading,
  loading,
  isManager,
  onChanged,
  asked = null,
}: {
  eventId: string;
  reading: PartyDepositReading | undefined;
  loading?: boolean;
  isManager: boolean;
  /** After a press the platform answered — made, or refused: the state and the till's figures are read again. */
  onChanged?: () => void;
  /**
   * SCRUM-927: the deposit the BEO asks (billing's deposit required, whole baht) and not yet
   * received, so this box agrees with the BEO while no payment link has been sent; null with none.
   */
  asked?: number | null;
}) {
  const [amount, setAmount] = useState(asked && asked > 0 ? String(asked) : "");
  // The BEO's asked deposit, read after the box opened, fills an empty amount (never a typed one).
  useEffect(() => {
    if (asked && asked > 0) setAmount((typed) => (typed === "" ? String(asked) : typed));
  }, [asked]);
  const [busy, setBusy] = useState<"request" | "resend" | "cancel" | "menu" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const press = usePressId();

  const answer = reading?.status === "ok" ? reading.answer : null;
  const current: PartyDepositRequest | null = answer?.current ?? null;
  const open = current?.state === "requested" ? current : null;
  const problem = reading && reading.status !== "ok" ? depositProblemOf(reading) : null;
  const words = current ? depositStateWordsOf(current) : null;
  const noChat = answer ? !answer.hasConversation : false;

  const post = async (what: NonNullable<typeof busy>, path: string, body: Record<string, unknown>, fallback: string) => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      const res = await apiRequest("POST", path, { actionId: press.take(), ...body });
      press.spend();
      const made = (await res.json()) as PartyDepositActionAnswer | { replayed: boolean };
      if (what === "menu") setNote("The menu choice link is in the family's chat.");
      else if (what === "request") setNote(`${(made as PartyDepositActionAnswer).replayed ? "Already asked: " : ""}the payment link is in the family's chat.`);
      onChanged?.();
    } catch (err) {
      // A refusal ends the press; a lost connection, or the till out of reach, keeps it for the retry.
      setError(refusalWords(err, fallback));
      if (pressRefused(err)) {
        press.spend();
        // SCRUM-841: a refusal can mean the request moved on the platform (its party was removed,
        // it was paid or closed elsewhere), so the state is read again at once; the refusal's words stay.
        onChanged?.();
      }
    } finally {
      setBusy(null);
    }
  };
  const request = () => {
    const baht = depositAmountOf(amount);
    const bad = depositRequestProblem(baht);
    if (bad) {
      setError(bad);
      return;
    }
    void post("request", `/api/events/${eventId}/beo/deposit-request`, { amount: baht }, "The deposit was not requested.");
  };

  const tone =
    words?.tone === "paid" ? "text-emerald-600" : words?.tone === "overdue" ? "text-red-600" : words?.tone === "open" ? "text-amber-600" : "text-muted-foreground";

  return (
    <Card className="border-2 border-violet-500/30" data-testid="panel-deposit-request">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-violet-600" />
            Deposit from the family's chat
          </span>
          {open && (
            <Badge className="bg-amber-600" data-testid="badge-deposit-request-open">
              {open.handedOverAt ? "Overdue" : "Requested"}
            </Badge>
          )}
          {current?.state === "paid" && (
            <Badge className="bg-green-600" data-testid="badge-deposit-request-paid">
              Paid
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !reading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Asking the till…
          </p>
        ) : problem ? (
          <div className="flex items-start gap-2 text-sm" data-testid="text-deposit-request-unavailable">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{problem.headline}</p>
              <p className="text-muted-foreground">{problem.detail}</p>
            </div>
          </div>
        ) : (
          <>
            {words && (
              <div className="text-sm" data-testid="text-deposit-request-state">
                <p className={cn("font-medium", tone)} data-testid="text-deposit-request-headline">
                  {words.headline}
                </p>
                <p className="text-xs text-muted-foreground">{words.detail}</p>
                {open?.paymentLink && (
                  <a
                    href={open.paymentLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-violet-700 underline inline-flex items-center gap-1 mt-1"
                    data-testid="link-deposit-payment"
                  >
                    <Link2 className="h-3 w-3" /> The payment link
                  </a>
                )}
              </div>
            )}
            {!words && asked !== null && asked > 0 && (
              <p className="text-sm text-muted-foreground" data-testid="text-deposit-request-asked">
                {depositAskedWords(asked)}
              </p>
            )}
            {!words && !(asked !== null && asked > 0) && (
              <p className="text-sm text-muted-foreground" data-testid="text-deposit-request-none">
                No deposit asked yet. The assistant posts the payment link in the family's chat and confirms when it is paid.
              </p>
            )}
            {noChat && (
              <p className="text-xs text-amber-600" data-testid="text-deposit-no-conversation">
                {NO_CONVERSATION_WORDS}
              </p>
            )}
            {isManager && open && (
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void post("resend", `/api/events/${eventId}/beo/deposit-request/${open.id}/resend`, {}, "The link was not resent.")}
                  data-testid="button-deposit-resend"
                >
                  {busy === "resend" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                  Resend
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void post("cancel", `/api/events/${eventId}/beo/deposit-request/${open.id}/cancel`, {}, "The request was not cancelled.")}
                  data-testid="button-deposit-cancel"
                >
                  {busy === "cancel" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <XCircle className="h-4 w-4 mr-1" />}
                  Cancel request
                </Button>
              </div>
            )}
            {isManager && !open && (
              <div className="flex items-center gap-2 flex-wrap">
                <Label htmlFor="deposit-request-amount" className="text-sm">
                  Deposit to ask
                </Label>
                <Input
                  id="deposit-request-amount"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  className="w-32"
                  placeholder="3000"
                  value={amount}
                  disabled={busy !== null || noChat}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") request();
                  }}
                  data-testid="input-deposit-request-amount"
                />
                <span className="text-sm text-muted-foreground">THB</span>
                <Button size="sm" disabled={busy !== null || noChat} onClick={request} data-testid="button-request-deposit">
                  {busy === "request" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <MessageCircle className="h-4 w-4 mr-1" />}
                  Request deposit
                </Button>
              </div>
            )}
            {isManager && (
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-dashed border-border/50">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || noChat}
                  onClick={() => void post("menu", `/api/events/${eventId}/beo/menu-link`, {}, "The menu link was not sent.")}
                  data-testid="button-send-menu-link"
                >
                  {busy === "menu" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />}
                  Send the menu choice link
                </Button>
                <span className="text-xs text-muted-foreground">The assistant posts the parent's menu link, and confirms their choices when they land.</span>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive" data-testid="text-deposit-request-error">
                {error}
              </p>
            )}
            {note && !error && (
              <p className="text-xs text-emerald-600" data-testid="text-deposit-request-note">
                {note}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The BEO's BILLING section: "From the till" at the top, the deposit asked
 * from the family's chat (SCRUM-825) under it, then the app's own billing
 * module kept whole — its invoice rows, Generate from BEO and the Deposit Paid
 * that feeds the till (SCRUM-813) — labelled as the app's own.
 *
 * SCRUM-839: on a party with no billing record the Financial Summary reads
 * the event's own deposit (`eventDeposit`), so the section never shows two
 * deposit figures. When the family pays while the section is open the
 * request's state moves on its own; `onDepositMoved` then has the editor read
 * the saved deposit again.
 */
export function BeoBillingSection({
  eventId,
  billing,
  onBillingChange,
  isManager,
  eventDeposit = null,
  onDepositMoved,
}: {
  eventId: string;
  billing: BeoEventBilling | null;
  /** One billing write; a promise settles when the server has answered. */
  onBillingChange: (billing: Partial<BeoEventBilling>) => Promise<unknown> | void;
  isManager: boolean;
  /** The event's own deposit (its Prepayment), shown by the summary while the party has no billing record. */
  eventDeposit?: EventDeposit | null;
  /** The chat's deposit request changed state without a press here (the family paid): the saved deposit is read again. */
  onDepositMoved?: () => void;
}) {
  // The editor around it reads the till every minute; this one reads afresh when the section opens.
  const till = useTillBilling(eventId, { refetchInterval: false });
  const depositRequest = useDepositRequest(eventId);
  const queryClient = useQueryClient();
  const summaryBilling = summaryBillingOf(billing, eventDeposit);
  const deposit = useBufferedDeposit(summaryBilling, (patch) => onBillingChange(patchOverEventDeposit(patch, billing, eventDeposit)));
  // The request as last read: its payment moves the party's deposit on the server, not through this screen.
  const requestMark = depositRequestMarkOf(depositRequest.data);
  const seenMark = useRef<string | null>(null);
  const movedRef = useRef(onDepositMoved);
  movedRef.current = onDepositMoved;
  const savedSatangRef = useRef(0);
  savedSatangRef.current = (summaryBilling?.depositPaidAmount || 0) * 100;
  useEffect(() => {
    if (requestMark === null) return;
    const was = seenMark.current;
    seenMark.current = requestMark;
    if (requestMark === NOT_PAID_MARK || was === requestMark) return;
    // A payment seen to land here; or, as the section opens, a paid request whose deposit the
    // summary does not hold (the family paid after the BEO was read).
    const paidSatang = depositRequest.data?.status === "ok" ? (depositRequest.data.answer.current?.depositAfterSatang ?? null) : null;
    if (was !== null || (paidSatang !== null && paidSatang !== savedSatangRef.current)) movedRef.current?.();
    // Keyed on the mark alone: the reading is read as it stands when the mark moves.
  }, [requestMark]);
  return (
    <div className="space-y-4" data-testid="section-billing">
      <TillBillingPanel
        eventId={eventId}
        reading={till.data}
        loading={till.isLoading}
        refreshing={till.isFetching}
        onRefresh={() => void till.refetch()}
      />
      <DepositRequestPanel
        eventId={eventId}
        reading={depositRequest.data}
        loading={depositRequest.isLoading}
        isManager={isManager}
        asked={depositAskedOf(billing)}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: depositRequestKey(eventId) });
          void queryClient.invalidateQueries({ queryKey: tillBillingKey(eventId) });
        }}
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

const NOT_PAID_MARK = "not-paid";
/** What of the chat's request says the party's deposit moved: a paid request, the deposit after it, its write back. */
function depositRequestMarkOf(reading: PartyDepositReading | undefined): string | null {
  if (!reading || reading.status !== "ok") return null;
  const c = reading.answer.current;
  return c && c.state === "paid" ? [c.id, c.depositAfterSatang ?? "", c.writeBack?.syncState ?? ""].join("|") : NOT_PAID_MARK;
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
