import { BarChart3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export type SpinWheelReport = {
  rewards: Array<{
    prizeId: string;
    campaignId: string;
    displayName: string;
    active: boolean;
    won: number;
    redeemed: number;
    outstanding: number;
  }>;
  /** The legacy wheel's four-digit code capacity; the platform booth has none. */
  capacity: null;
  /** When the platform's booth rollup last ran to the end. */
  lastRolledUpAt: string | null;
};

type SpinWheelReportProps = {
  report?: SpinWheelReport;
  isLoading: boolean;
  error?: unknown;
  onRefresh: () => void;
};

export function SpinWheelReport({ report, isLoading, error, onRefresh }: SpinWheelReportProps) {
  return (
    <section aria-labelledby="spin-wheel-report-heading" className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-sky-600" aria-hidden />
          <h2 id="spin-wheel-report-heading" className="truncate text-sm font-bold">Booth report — last 12 months</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label="Refresh Spin Wheel report"
          data-testid="button-refresh-spin-report"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} aria-hidden />
          <span className="sr-only sm:not-sr-only sm:ml-2">Refresh</span>
        </Button>
      </div>
      <div className="p-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading report…</p>}
        {Boolean(error) && (
          <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
            Report unavailable. Try refreshing.
          </p>
        )}
        {!isLoading && !error && report && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <Metric label="Won" value={report.rewards.reduce((sum, reward) => sum + reward.won, 0)} />
              <Metric label="Redeemed" value={report.rewards.reduce((sum, reward) => sum + reward.redeemed, 0)} />
              <Metric label="Outstanding" value={report.rewards.reduce((sum, reward) => sum + reward.outstanding, 0)} />
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <caption className="sr-only">Spin Wheel reward outcomes</caption>
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">Prize</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Won</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Redeemed</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.rewards.map((reward) => (
                    <tr key={reward.prizeId}>
                      <th scope="row" className="px-3 py-2 font-medium">
                        <span>{reward.displayName}</span>
                        {!reward.active && <span className="ml-2 text-xs font-normal text-muted-foreground">(Unavailable)</span>}
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">{reward.won}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{reward.redeemed}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{reward.outstanding}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {!isLoading && !error && !report && (
          // A 401 answers null: the report is the platform's booth figures,
          // which need a signed-in session.
          <p className="text-sm text-muted-foreground">Open Radar from the OTO launcher to see the booth report.</p>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value.toLocaleString()}</p>
    </div>
  );
}