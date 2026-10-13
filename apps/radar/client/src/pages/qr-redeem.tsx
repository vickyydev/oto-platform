import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Camera, CheckCircle2, Gift, Loader2, RotateCcw, ScanLine, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SpinWheelRewards,
  type SpinWheelReward,
} from "@/components/spin-wheel-rewards";
import {
  SpinWheelReport,
  type SpinWheelReport as SpinWheelReportData,
} from "@/components/spin-wheel-report";
import { QrScannerDialog } from "@/components/qr-scanner-dialog";

type Mode = "spin" | "existing";
type SpinStatus = "Redeemed" | "Already used" | "Not found" | "Service unavailable";

type SpinRedeemResponse = {
  status: SpinStatus;
  code?: string;
  prizeId?: string;
  campaignId?: string;
  displayName?: string;
  customerValue?: string | number | null;
  wonAt?: string;
  redeemedAt?: string;
};

type SpinRewardsResponse = { rewards: SpinWheelReward[] };

type LegacySuccessResponse = {
  ok: true;
  token: string;
  redeemedAt: string;
  campaign: { id: string; name: string; promoCode: string };
};

type LegacyErrorResponse = {
  message: string;
  reasonCode?: string;
  qr?: { token: string; status: string; redeemedAt: string | null; redeemedBy: string | null } | null;
  campaign?: { id: string; name: string; promoCode: string } | null;
};

type SpinRequestError = { message: string; status?: number };

const SPIN_STATUSES: SpinStatus[] = ["Redeemed", "Already used", "Not found", "Service unavailable"];

function isSpinStatus(value: unknown): value is SpinStatus {
  return typeof value === "string" && SPIN_STATUSES.includes(value as SpinStatus);
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function customerValue(value: string | number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export default function QrRedeemPage() {
  return <RedeemPageContent />;
}

function RedeemPageContent() {
  const [mode, setMode] = useState<Mode>("spin");
  const [code, setCode] = useState("");
  const [legacyRedeemedBy, setLegacyRedeemedBy] = useState("");
  const [spinResult, setSpinResult] = useState<SpinRedeemResponse | null>(null);
  const [spinError, setSpinError] = useState<SpinRequestError | null>(null);
  const [spinInputError, setSpinInputError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [legacyResult, setLegacyResult] = useState<LegacySuccessResponse | null>(null);
  const [legacyError, setLegacyError] = useState<LegacyErrorResponse | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const original = link?.getAttribute("href");
    if (link) link.setAttribute("href", "/redeem.webmanifest?v=2");
    const previousTitle = document.title;
    document.title = "OTO Redeem";
    return () => {
      if (link && original) link.setAttribute("href", original);
      document.title = previousTitle;
    };
  }, []);

  const rewardsQuery = useQuery<SpinRewardsResponse>({
    queryKey: ["/api/spin-wheel/rewards"],
    enabled: mode === "spin",
  });

  const reportQuery = useQuery<SpinWheelReportData>({
    queryKey: ["/api/spin-wheel/report"],
    enabled: reportOpen,
  });

  const clearOutcome = () => {
    setSpinResult(null);
    setSpinError(null);
    setSpinInputError(null);
    setLegacyResult(null);
    setLegacyError(null);
  };

  const changeMode = (nextMode: Mode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setScannerOpen(false);
    setCode("");
    setLegacyRedeemedBy("");
    clearOutcome();
  };

  const spinMutation = useMutation<SpinRedeemResponse, SpinRequestError, string>({
    mutationFn: async (submittedCode) => {
      const response = await fetch("/api/spin-wheel/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: submittedCode }),
      });
      const body = await readJson(response);
      const status = isSpinStatus(body.status)
        ? body.status
        : response.status === 409
          ? "Already used"
          : response.status === 404
            ? "Not found"
            : response.status === 503
              ? "Service unavailable"
              : null;

      if (status) {
        return { ...body, status } as SpinRedeemResponse;
      }

      // The redeem page is public (no staff sign-in): a refusal is the
      // server's own message, rate limiting included.
      const message = typeof body.message === "string"
        ? body.message
        : `Spin Wheel redemption failed (HTTP ${response.status}).`;
      throw { message, status: response.status } as SpinRequestError;
    },
    onSuccess: (result) => {
      setSpinResult(result);
      setSpinError(null);
      setSpinInputError(null);
      setCode("");
      if (reportOpen) void reportQuery.refetch();
    },
    onError: (error) => {
      setSpinError(error);
      setSpinResult(null);
    },
  });

  const legacyMutation = useMutation<LegacySuccessResponse, LegacyErrorResponse, void>({
    mutationFn: async () => {
      const value = code.trim();
      const isShort = /^[A-Z0-9]{4,12}$/i.test(value);
      const body = isShort
        ? { code: value.toUpperCase(), redeemedBy: legacyRedeemedBy.trim() || undefined }
        : { token: value, redeemedBy: legacyRedeemedBy.trim() || undefined };
      const response = await fetch("/api/qr/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await readJson(response);
      if (!response.ok) throw json as LegacyErrorResponse;
      return json as unknown as LegacySuccessResponse;
    },
    onSuccess: (result) => {
      setLegacyResult(result);
      setLegacyError(null);
      setCode("");
    },
    onError: (error) => {
      setLegacyError(error);
      setLegacyResult(null);
    },
  });

  const reset = () => {
    setCode("");
    clearOutcome();
  };

  const submit = () => {
    if (mode === "spin") {
      const submittedCode = code.trim();
      if (!/^\d{4}$/.test(submittedCode)) {
        setSpinInputError("Enter exactly 4 digits, including any leading zero.");
        return;
      }
      setSpinInputError(null);
      spinMutation.mutate(submittedCode);
      return;
    }

    if (code.trim()) legacyMutation.mutate();
  };

  const isPending = spinMutation.isPending || legacyMutation.isPending;

  return (
    <div className="min-h-screen bg-background px-4 pb-10 pt-16 sm:px-6">
      <main className="mx-auto max-w-3xl">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-xl bg-amber-100 p-2.5 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              <ScanLine className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold sm:text-xl" data-testid="text-page-title">Reception · Redeem</h1>
              <p className="text-xs text-muted-foreground">Choose the code system before entering a code.</p>
            </div>
          </div>
          <Link href="/#campaigns">
            <Button variant="outline" size="sm" className="shrink-0 gap-1" data-testid="link-back">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Campaigns</span>
              <span className="sm:hidden">Back</span>
            </Button>
          </Link>
        </header>

        <div className="mb-4 rounded-xl border bg-card p-1" role="tablist" aria-label="Redemption mode">
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "spin"}
              className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${mode === "spin" ? "bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => changeMode("spin")}
              data-testid="tab-spin-wheel"
            >
              Spin Wheel
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "existing"}
              className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${mode === "existing" ? "bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => changeMode("existing")}
              data-testid="tab-existing-vouchers"
            >
              Existing vouchers
            </button>
          </div>
        </div>

        {mode === "spin" ? (
          <div className="space-y-4">
            <section className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
              <div className="mb-4 flex items-start gap-3">
                <div className="rounded-lg bg-sky-100 p-2 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                  <Gift className="h-5 w-5" aria-hidden />
                </div>
                <div>
                  <h2 className="font-bold">Redeem a Spin Wheel prize</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Enter the customer&apos;s four-digit Spin Wheel code or scan a QR that contains only that code.
                  </p>
                </div>
              </div>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
                data-testid="form-spin-redeem"
              >
                <div>
                  <Label htmlFor="spin-code">Spin Wheel code</Label>
                  <div className="mt-1 flex gap-2">
                    <Input
                      id="spin-code"
                      value={code}
                      onChange={(event) => {
                        // Keep scanner input intact. In particular, never turn a
                        // legacy URL containing digits into a different code.
                        setCode(event.target.value);
                        setSpinResult(null);
                        setSpinError(null);
                        setSpinInputError(null);
                      }}
                      placeholder="0000"
                      inputMode="numeric"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono text-2xl tracking-[0.35em]"
                      aria-describedby="spin-code-help"
                      data-testid="input-spin-code"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 gap-2"
                      onClick={() => setScannerOpen(true)}
                      aria-label="Scan Spin Wheel code with camera"
                      data-testid="button-scan-spin-code"
                    >
                      <Camera className="h-4 w-4" aria-hidden />
                      <span className="hidden sm:inline">Scan</span>
                    </Button>
                  </div>
                  <p id="spin-code-help" className="mt-1 text-xs text-muted-foreground">
                    Exactly 4 digits. Leading zeros count. This is separate from Existing vouchers.
                  </p>
                </div>
                {spinInputError && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{spinInputError}</p>}
                <Button type="submit" className="w-full" disabled={!code.trim() || isPending} data-testid="button-spin-redeem">
                  {spinMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                  Redeem Spin Wheel code
                </Button>
              </form>
              <QrScannerDialog
                open={scannerOpen}
                onOpenChange={setScannerOpen}
                onCodeScanned={(scannedCode) => {
                  setCode(scannedCode);
                  setSpinResult(null);
                  setSpinError(null);
                  setSpinInputError(null);
                }}
              />
            </section>

            {spinResult && <SpinResult result={spinResult} onReset={reset} />}
            {spinError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 dark:border-rose-900 dark:bg-rose-950/20" role="alert" data-testid="result-spin-error">
                <div className="flex gap-3">
                  <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-rose-600" aria-hidden />
                  <div>
                    <h2 className="font-semibold">Spin Wheel redemption could not be completed</h2>
                    <p className="mt-1 text-sm text-rose-800 dark:text-rose-300">{spinError.message}</p>
                  </div>
                </div>
                <Button onClick={reset} className="mt-4 w-full gap-2" variant="outline" data-testid="button-spin-try-again">
                  <RotateCcw className="h-4 w-4" aria-hidden /> Try another code
                </Button>
              </div>
            )}

            <SpinWheelRewards
              rewards={rewardsQuery.data?.rewards}
              isLoading={rewardsQuery.isLoading}
              error={rewardsQuery.error}
            />

            <section className="rounded-xl border bg-card" aria-labelledby="report-toggle-label">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                aria-expanded={reportOpen}
                aria-controls="spin-wheel-report-panel"
                onClick={() => setReportOpen((open) => !open)}
                data-testid="button-toggle-spin-report"
              >
                <span id="report-toggle-label" className="font-semibold">Reporting</span>
                <span className="text-xs text-muted-foreground">{reportOpen ? "Hide" : "Show won & redeemed"}</span>
              </button>
              {reportOpen && (
                <div id="spin-wheel-report-panel" className="border-t p-3 sm:p-4">
                  <SpinWheelReport
                    report={reportQuery.data}
                    isLoading={reportQuery.isLoading}
                    error={reportQuery.error}
                    onRefresh={() => void reportQuery.refetch()}
                  />
                </div>
              )}
            </section>
          </div>
        ) : (
          <LegacyVoucherRedeem
            code={code}
            redeemedBy={legacyRedeemedBy}
            result={legacyResult}
            error={legacyError}
            isPending={legacyMutation.isPending}
            onCodeChange={(value) => {
              setCode(value);
              setLegacyResult(null);
              setLegacyError(null);
            }}
            onRedeemedByChange={setLegacyRedeemedBy}
            onSubmit={submit}
            onReset={reset}
          />
        )}
      </main>
    </div>
  );
}

function SpinResult({ result, onReset }: { result: SpinRedeemResponse; onReset: () => void }) {
  const redeemed = result.status === "Redeemed";
  const used = result.status === "Already used";
  const unavailable = result.status === "Service unavailable";
  const title = redeemed
    ? "Spin Wheel prize redeemed"
    : used
      ? "Already used"
      : result.status === "Not found"
        ? "Code not found"
        : "Spin Wheel service unavailable";
  const detail = redeemed
    ? "The customer can now receive the prize shown below."
    : used
      ? "This four-digit code was already redeemed and cannot be used again."
      : result.status === "Not found"
        ? "Check the mode and the four digits, then try again. Existing voucher codes belong in Existing vouchers mode."
        : "The code was not changed. Please wait and try again.";

  return (
    <div
      className={`rounded-xl border p-5 ${redeemed ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/20" : unavailable ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20" : "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/20"}`}
      role="status"
      data-testid={`result-spin-${result.status === "Already used" ? "used" : result.status === "Not found" ? "not-found" : result.status === "Service unavailable" ? "unavailable" : "success"}`}
    >
      <div className="flex gap-3">
        {redeemed ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" aria-hidden /> : <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-rose-600" aria-hidden />}
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
          {(result.displayName || result.customerValue !== undefined) && (
            <div className="mt-3 rounded-lg bg-background/70 p-3">
              {result.displayName && <p className="font-semibold">{result.displayName}</p>}
              {customerValue(result.customerValue) && <p className="mt-1 text-sm font-bold text-emerald-700 dark:text-emerald-400">{customerValue(result.customerValue)}</p>}
            </div>
          )}
          {result.redeemedAt && <p className="mt-3 text-xs text-muted-foreground">Redeemed at {formatDate(result.redeemedAt)}</p>}
          {used && result.code && <p className="mt-2 font-mono text-xs text-muted-foreground">Code: {result.code}</p>}
        </div>
      </div>
      <Button onClick={onReset} className="mt-4 w-full gap-2" variant="outline" data-testid="button-next-spin-code">
        <RotateCcw className="h-4 w-4" aria-hidden /> Next Spin Wheel code
      </Button>
    </div>
  );
}

function LegacyVoucherRedeem({
  code,
  redeemedBy,
  result,
  error,
  isPending,
  onCodeChange,
  onRedeemedByChange,
  onSubmit,
  onReset,
}: {
  code: string;
  redeemedBy: string;
  result: LegacySuccessResponse | null;
  error: LegacyErrorResponse | null;
  isPending: boolean;
  onCodeChange: (value: string) => void;
  onRedeemedByChange: (value: string) => void;
  onSubmit: () => void;
  onReset: () => void;
}) {
  if (result) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center dark:border-emerald-900 dark:bg-emerald-950/20" data-testid="result-success">
        <CheckCircle2 className="mx-auto mb-3 h-14 w-14 text-emerald-600" aria-hidden />
        <p className="text-sm text-muted-foreground">{result.campaign.name}</p>
        <p className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">Apply this promo code</p>
        <p className="mt-1 font-mono text-3xl font-bold text-emerald-700 dark:text-emerald-400" data-testid="text-promo-code">
          {result.campaign.promoCode}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">Redeemed at {formatDate(result.redeemedAt)}</p>
        <Button onClick={onReset} className="mt-5 w-full gap-2" data-testid="button-next">
          <RotateCcw className="h-4 w-4" aria-hidden /> Next QR
        </Button>
      </div>
    );
  }

  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-600" aria-hidden />
        <div>
          <h2 className="font-bold">Redeem an existing voucher</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Legacy voucher flow. Enter the existing voucher code or the full QR token.
          </p>
        </div>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) onSubmit();
        }}
        data-testid="form-redeem"
      >
        <div>
          <Label htmlFor="existing-code">Existing voucher code or QR token</Label>
          <Input
            id="existing-code"
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            placeholder="e.g. K7P2"
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 font-mono text-lg uppercase tracking-widest"
            data-testid="input-token"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Existing vouchers only. Numeric Spin Wheel codes must be entered in Spin Wheel mode.
          </p>
        </div>
        <div>
          <Label htmlFor="redeemedBy">Your name (optional)</Label>
          <Input
            id="redeemedBy"
            value={redeemedBy}
            onChange={(event) => onRedeemedByChange(event.target.value)}
            placeholder="Reception staff name"
            data-testid="input-redeemed-by"
          />
        </div>
        <Button type="submit" className="w-full" disabled={!code.trim() || isPending} data-testid="button-redeem">
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Redeem existing voucher
        </Button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/20" role="alert" data-testid="result-error">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            <div>
              <h2 className="font-semibold" data-testid="text-error-title">
                {error.reasonCode === "already_used" ? "Already redeemed" : error.message || "Voucher could not be redeemed"}
              </h2>
              {error.campaign && <p className="mt-1 text-sm text-muted-foreground" data-testid="text-error-campaign">{error.campaign.name}</p>}
              {error.reasonCode === "already_used" && error.qr?.redeemedAt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Originally redeemed {formatDate(error.qr.redeemedAt)}
                  {error.qr.redeemedBy ? ` by ${error.qr.redeemedBy}` : ""}
                </p>
              )}
            </div>
          </div>
          <Button onClick={onReset} className="mt-4 w-full gap-2" variant="outline" data-testid="button-try-again">
            <RotateCcw className="h-4 w-4" aria-hidden /> Try another QR
          </Button>
        </div>
      )}
    </section>
  );
}