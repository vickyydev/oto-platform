// Revenue Planner (task-160) — action-based planner to hit the monthly target.
// Purely additive presentation layer: consumes the existing pace forecast and
// cached range summaries as-is. No revenue formulas are touched.
import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueries, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Target,
  TrendingUp,
  RotateCcw,
  PartyPopper,
  Users,
  Ticket,
  UtensilsCrossed,
  CheckCircle2,
  Loader2,
  Lightbulb,
  Pencil,
  Check,
  X,
  Save,
  Trash2,
  BookmarkCheck,
  AlertTriangle,
} from "lucide-react";
import type { SmartPaceForecast } from "@/lib/paceForecast";
import {
  derivePlannerBaselines,
  deriveFutureMonthBaselines,
  extractMonthAggregate,
  mergeMonthAggregates,
  buildLevers,
  scenarioContextFromForecast,
  evaluateScenario,
  computeOpportunityScore,
  buildRecommendedPlans,
  LEVER_IDS,
  type LeverConfig,
  type MonthAggregate,
} from "@/lib/plannerModel";

const LEVER_ICONS: Record<string, typeof Users> = {
  [LEVER_IDS.birthdays]: PartyPopper,
  [LEVER_IDS.visitors]: Users,
  [LEVER_IDS.ticketSpend]: Ticket,
  [LEVER_IDS.fnbSpend]: UtensilsCrossed,
};

const fmtBaht = (v: number) => {
  const a = Math.abs(v);
  return a >= 1000000 ? `${(v / 1000000).toFixed(2)}M` : a >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0);
};
const fmtSigned = (v: number) => `${v >= 0 ? "+" : "−"}฿${fmtBaht(Math.abs(v))}`;

interface RevenuePlannerProps {
  pace: SmartPaceForecast;
  /**
   * "current" (default) — live pace forecast for the running month.
   * "future" (task-162) — the month hasn't started; `pace` is a baseline
   * projection and lever baselines come from last year + recent months.
   */
  monthMode?: "current" | "future";
  /** YoY growth factor from the future baseline (null → 1). */
  growthFactor?: number | null;
  /** Derived target the calendar already shows (fallback default). */
  derivedTarget: number;
  branch: "floresta" | "chalong" | "all";
  year: number;
  month: number; // 0-based
  daysInMonth: number;
  todayStr: string;
}

export function RevenuePlannerButton(props: RevenuePlannerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2.5 gap-1.5 text-xs btn-press"
        onClick={() => setOpen(true)}
        data-testid="btn-open-planner"
      >
        <Target className="h-3.5 w-3.5 text-blue-500" />
        Planner
      </Button>
      {open && <RevenuePlannerDialog {...props} open={open} onOpenChange={setOpen} />}
    </>
  );
}

function RevenuePlannerDialog({
  pace,
  monthMode = "current",
  growthFactor = null,
  derivedTarget,
  branch,
  year,
  month,
  daysInMonth,
  todayStr,
  open,
  onOpenChange,
}: RevenuePlannerProps & { open: boolean; onOpenChange: (v: boolean) => void }) {
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const isFuture = monthMode === "future";
  const lyMonthKey = `${year - 1}-${String(month + 1).padStart(2, "0")}`;

  // --- Persisted monthly target (per month, per branch) --------------------
  const { data: targetData } = useQuery<{ target: number | null }>({
    queryKey: [`/api/planner/target?branch=${branch}&month=${monthKey}`],
    enabled: open,
  });
  const savedTarget = targetData?.target ?? null;
  const target = savedTarget && savedTarget > 0 ? savedTarget : Math.round(derivedTarget);

  const saveTarget = useMutation({
    mutationFn: async (t: number | null) => {
      await apiRequest("PUT", "/api/planner/target", { branch, month: monthKey, target: t });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/planner/target?branch=${branch}&month=${monthKey}`] });
    },
  });

  // --- History fetch for baselines (lazy, only while the panel is open) ----
  // Three month-scoped range fetches: two full lookback months (to anchor
  // monthly party capacity) plus the current month-to-date, mirroring the
  // pace forecast's ~8-week history window. Aggregates only — no per-day
  // summaries are needed.
  const monthWindows = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const windows: Array<{ monthKey: string; start: string; end: string }> = [];
    if (isFuture) {
      // Future month (task-162): the selected month and its neighbours have
      // no data yet, so anchor on (a) last year's SAME month — the seasonal
      // reference — and (b) the two most recent COMPLETED months relative to
      // today — the current-pricing reference.
      const lyLastDay = new Date(year - 1, month + 1, 0).getDate();
      windows.push({ monthKey: lyMonthKey, start: `${lyMonthKey}-01`, end: `${lyMonthKey}-${pad(lyLastDay)}` });
      const today = new Date(todayStr + "T12:00:00");
      for (let off = 2; off >= 1; off--) {
        const d = new Date(today.getFullYear(), today.getMonth() - off, 1);
        const mk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        windows.push({ monthKey: mk, start: `${mk}-01`, end: `${mk}-${pad(lastDay)}` });
      }
      return windows;
    }
    for (let off = 2; off >= 0; off--) {
      const d = new Date(year, month - off, 1);
      const mk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const endFull = `${mk}-${pad(lastDay)}`;
      const end = endFull < todayStr ? endFull : todayStr;
      windows.push({ monthKey: mk, start: `${mk}-01`, end });
    }
    return windows;
  }, [year, month, todayStr, isFuture, lyMonthKey]);

  // For the combined "all" branch view we fetch both POS sources per window
  // (Floresta first, then Chalong) and merge the per-month aggregates.
  const branchSources: Array<"floresta" | "chalong"> =
    branch === "all" ? ["floresta", "chalong"] : [branch];

  const monthQueries = useQueries({
    queries: monthWindows.flatMap((w) =>
      branchSources.map((src) => ({
        queryKey: [
          `/api/figures/range?branch=${src}&start=${w.start}&end=${w.end}`,
        ],
        enabled: open,
      })),
    ),
  });
  const rangeLoading = monthQueries.some((q) => q.isLoading);
  const monthData = monthQueries.map((q) => q.data as any);

  const baselines = useMemo(() => {
    if (rangeLoading) return null;
    const months: MonthAggregate[] = [];
    const perWindow = branchSources.length;
    for (let i = 0; i < monthWindows.length; i++) {
      const parts: MonthAggregate[] = [];
      for (let j = 0; j < perWindow; j++) {
        const data = monthData[i * perWindow + j];
        if (data) parts.push(extractMonthAggregate(data, monthWindows[i].monthKey));
      }
      if (parts.length > 0) {
        months.push(parts.length === 1 ? parts[0] : parts.reduce(mergeMonthAggregates));
      }
    }
    if (!months.some((m) => m.activeDays > 0)) return null;
    if (isFuture) {
      return deriveFutureMonthBaselines(months, lyMonthKey, growthFactor);
    }
    return derivePlannerBaselines(months, monthKey, pace.elapsedDays, daysInMonth);
    // Dep list spreads monthData (3 queries per branch source; length is
    // stable for a mounted dialog since `branch` doesn't change while open).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeLoading, ...monthData, monthWindows, monthKey, pace.elapsedDays, daysInMonth, isFuture, lyMonthKey, growthFactor]);

  const levers = useMemo(() => (baselines ? buildLevers(baselines) : null), [baselines]);
  const ctx = useMemo(
    () => (baselines ? scenarioContextFromForecast(pace, baselines) : null),
    [baselines, pace],
  );

  // --- Saved plan (task-166): persisted lever scenario per month + branch ---
  interface SavedPlan {
    values: Record<string, number>;
    projectedRevenue?: number;
    target?: number;
    savedAt?: string;
  }
  const planQueryKey = [`/api/planner/plan?branch=${branch}&month=${monthKey}`];
  const { data: planData, isLoading: planLoading } = useQuery<{ plan: SavedPlan | null }>({
    queryKey: planQueryKey,
    enabled: open,
  });
  const savedPlan = planData?.plan ?? null;

  const savePlan = useMutation({
    mutationFn: async (payload: { values: Record<string, number> | null; projectedRevenue?: number; target?: number }) => {
      await apiRequest("PUT", "/api/planner/plan", { branch, month: monthKey, ...payload });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
  });

  // --- Scenario state -------------------------------------------------------
  const [planned, setPlanned] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!levers || planLoading) return;
    if (savedPlan?.values) {
      // Restore the saved scenario, clamped to each lever's current range.
      setPlanned(
        Object.fromEntries(
          levers.map((lv) => {
            const raw = savedPlan.values[lv.id];
            const v = typeof raw === "number" && Number.isFinite(raw)
              ? Math.min(Math.max(raw, lv.min), Math.max(lv.max, lv.min + lv.step))
              : lv.baseline;
            return [lv.id, v];
          }),
        ),
      );
    } else {
      setPlanned(Object.fromEntries(levers.map((lv) => [lv.id, lv.baseline])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levers, planLoading, savedPlan]);

  const scenario = useMemo(() => {
    if (!levers || !ctx) return null;
    return evaluateScenario(pace.forecastRevenue, target, levers, planned, ctx);
  }, [levers, ctx, planned, pace.forecastRevenue, target]);

  const opportunity = useMemo(() => {
    if (!levers || !ctx) return null;
    return computeOpportunityScore(levers, ctx);
  }, [levers, ctx]);

  const plans = useMemo(() => {
    if (!levers || !ctx) return null;
    return buildRecommendedPlans(pace.forecastRevenue, target, levers, ctx);
  }, [levers, ctx, pace.forecastRevenue, target]);

  const resetScenario = () => {
    if (levers) setPlanned(Object.fromEntries(levers.map((lv) => [lv.id, lv.baseline])));
  };

  // --- Target editor ---------------------------------------------------------
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState("");

  const gap = target - pace.forecastRevenue;
  const projectedGapClosed = scenario ? scenario.projectedRevenue >= target : false;

  const monthName = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-planner">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-blue-500" />
            {monthName} {year} — Revenue Planner
          </DialogTitle>
          <DialogDescription className="text-xs">
            {branch === "all" ? "All Branches" : branch === "chalong" ? "Robinsons Chalong" : "Central Floresta"}
            {isFuture
              ? ` · planning ahead — ${monthName} hasn't started yet`
              : " · plan actions to reach this month's target"}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="planner">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="forecast" data-testid="tab-planner-forecast">Forecast</TabsTrigger>
            <TabsTrigger value="planner" data-testid="tab-planner-planner">Planner</TabsTrigger>
          </TabsList>

          {/* ---------------- Forecast tab (passive, existing view) -------- */}
          <TabsContent value="forecast" className="space-y-3 mt-3">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {[
                ...(isFuture
                  ? []
                  : [{ label: "Current Revenue", value: `฿${fmtBaht(pace.revenueToDate)}`, color: "#10b981" }]),
                { label: isFuture ? "Baseline Forecast" : "Projected Month End", value: `฿${fmtBaht(pace.forecastRevenue)}`, color: "#3b82f6" },
                { label: "Target", value: `฿${fmtBaht(target)}` },
                { label: isFuture ? "Expected / Day" : "Average / Day", value: `฿${fmtBaht(pace.avgDailyRevenue)}` },
                { label: isFuture ? "Days in Month" : "Remaining Days", value: `${pace.remainingDays}${pace.todayIsPartial ? " +today" : ""}` },
                {
                  label: isFuture ? "Baseline vs Target" : "Forecast vs Target",
                  value: fmtSigned(pace.forecastRevenue - target),
                  color: pace.forecastRevenue >= target ? "#10b981" : "#ef4444",
                },
              ].map((it) => (
                <div key={it.label} className="neu-inset rounded-xl p-2.5 text-center">
                  <p className="text-[10px] text-muted-foreground">{it.label}</p>
                  <p className="text-sm font-bold" style={it.color ? { color: it.color } : undefined}>{it.value}</p>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              <span className="font-semibold">Model:</span> {pace.modelLabel}
            </p>
            <p className="text-xs text-muted-foreground leading-snug">{pace.explanation}</p>
          </TabsContent>

          {/* ---------------- Planner tab (interactive) --------------------- */}
          <TabsContent value="planner" className="space-y-4 mt-3">
            {/* Header: forecast / target / gap */}
            <div className="grid grid-cols-3 gap-2">
              <div className="neu-inset rounded-xl p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground">{isFuture ? "Baseline Forecast" : "Current Forecast"}</p>
                <p className="text-sm font-bold text-blue-600 dark:text-blue-400" data-testid="text-planner-forecast">
                  ฿{fmtBaht(pace.forecastRevenue)}
                </p>
              </div>
              <div className="neu-inset rounded-xl p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                  Monthly Target
                  {!editingTarget && (
                    <button
                      className="text-muted-foreground/60 hover:text-muted-foreground"
                      onClick={() => {
                        setTargetDraft(String(target));
                        setEditingTarget(true);
                      }}
                      aria-label="Edit target"
                      data-testid="btn-edit-target"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                    </button>
                  )}
                </p>
                {editingTarget ? (
                  <div className="flex items-center gap-1 mt-0.5">
                    <Input
                      type="number"
                      className="h-6 text-xs px-1.5"
                      value={targetDraft}
                      onChange={(e) => setTargetDraft(e.target.value)}
                      data-testid="input-planner-target"
                    />
                    <button
                      className="text-emerald-600"
                      onClick={() => {
                        const n = Number(targetDraft);
                        if (Number.isFinite(n) && n > 0) {
                          saveTarget.mutate(Math.round(n));
                          setEditingTarget(false);
                        }
                      }}
                      aria-label="Save target"
                      data-testid="btn-save-target"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="text-muted-foreground"
                      onClick={() => setEditingTarget(false)}
                      aria-label="Cancel"
                      data-testid="btn-cancel-target"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <p className="text-sm font-bold" data-testid="text-planner-target">
                    ฿{fmtBaht(target)}
                    {savedTarget ? <span className="text-[8px] text-muted-foreground font-normal ml-1">(set)</span> : null}
                  </p>
                )}
              </div>
              <div className="neu-inset rounded-xl p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground">Gap to Target</p>
                <p
                  className="text-sm font-bold"
                  style={{ color: projectedGapClosed ? "#10b981" : "#ef4444" }}
                  data-testid="text-planner-gap"
                >
                  {scenario ? fmtSigned(scenario.projectedRevenue - target) : fmtSigned(-gap)}
                </p>
              </div>
            </div>

            {rangeLoading && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading baselines from history…
              </div>
            )}

            {!rangeLoading && (!levers || !ctx || !scenario) && (
              <p className="text-xs text-muted-foreground py-6 text-center">
                Not enough historical data to build planner baselines for this month yet.
              </p>
            )}

            {levers && ctx && scenario && (
              <>
                {/* Levers */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Action Levers <span className="normal-case font-normal">{isFuture ? `(apply to all ${ctx.remainingEffDays} days of ${monthName})` : `(apply to the ${ctx.remainingEffDays} remaining days)`}</span>
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 gap-1 text-[10px]"
                        onClick={resetScenario}
                        data-testid="btn-reset-scenario"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Reset
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 gap-1 text-[10px] btn-press"
                        disabled={savePlan.isPending}
                        onClick={() =>
                          savePlan.mutate({
                            values: { ...planned },
                            projectedRevenue: scenario?.projectedRevenue,
                            target,
                          })
                        }
                        data-testid="btn-save-plan"
                      >
                        {savePlan.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Save className="h-3 w-3" />
                        )}
                        Save Plan
                      </Button>
                    </div>
                  </div>

                  {/* Saved plan status (task-166) */}
                  {savedPlan && (
                    <div
                      className="rounded-xl p-2.5 border border-blue-500/30 bg-blue-500/5 flex items-start justify-between gap-2"
                      data-testid="card-saved-plan"
                    >
                      <div className="text-[10px] leading-snug">
                        <p className="font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1">
                          <BookmarkCheck className="h-3 w-3" />
                          Saved plan for {monthName}
                          {savedPlan.savedAt && (
                            <span className="font-normal text-muted-foreground">
                              · saved {new Date(savedPlan.savedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                            </span>
                          )}
                        </p>
                        <p className="text-muted-foreground mt-0.5" data-testid="text-plan-vs-actual">
                          {savedPlan.projectedRevenue ? (
                            <>
                              Planned month end: <span className="font-semibold text-foreground">฿{fmtBaht(savedPlan.projectedRevenue)}</span>
                              {" · "}{isFuture ? "Baseline forecast" : "Current forecast"}: <span className="font-semibold text-foreground">฿{fmtBaht(pace.forecastRevenue)}</span>
                              {" ("}
                              <span
                                className="font-semibold"
                                style={{ color: pace.forecastRevenue >= savedPlan.projectedRevenue ? "#10b981" : "#ef4444" }}
                              >
                                {fmtSigned(pace.forecastRevenue - savedPlan.projectedRevenue)}
                              </span>
                              {" vs plan)"}
                            </>
                          ) : (
                            <>Sliders restored from your saved plan.</>
                          )}
                        </p>
                      </div>
                      <button
                        className="text-muted-foreground/60 hover:text-red-500 shrink-0 mt-0.5"
                        onClick={() => savePlan.mutate({ values: null })}
                        aria-label="Delete saved plan"
                        data-testid="btn-clear-plan"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {levers.map((lv) => (
                    <LeverRow
                      key={lv.id}
                      lever={lv}
                      value={planned[lv.id] ?? lv.baseline}
                      impact={scenario.perLever.find((p) => p.leverId === lv.id)?.impact || 0}
                      onChange={(v) => setPlanned((prev) => ({ ...prev, [lv.id]: v }))}
                    />
                  ))}
                </div>

                {/* Impact summary */}
                <div
                  className={`rounded-xl p-3 border ${
                    scenario.targetAchieved
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : "neu-inset border-transparent"
                  }`}
                  data-testid="card-scenario-summary"
                >
                  {scenario.targetAchieved && (
                    <p className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 mb-2" data-testid="text-target-achieved">
                      <CheckCircle2 className="h-4 w-4" />
                      Target Achieved
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {scenario.perLever.map((p) => (
                      <div key={p.leverId} className="flex justify-between" data-testid={`impact-${p.leverId}`}>
                        <span className="text-muted-foreground">{p.label}</span>
                        <span
                          className="font-semibold"
                          style={{ color: p.impact > 0 ? "#10b981" : p.impact < 0 ? "#ef4444" : undefined }}
                        >
                          {p.impact === 0 ? "—" : fmtSigned(p.impact)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border/50 mt-2 pt-2 grid grid-cols-2 gap-x-4 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground font-semibold">Total Impact</span>
                      <span
                        className="font-bold"
                        style={{ color: scenario.totalImpact >= 0 ? "#10b981" : "#ef4444" }}
                        data-testid="text-total-impact"
                      >
                        {fmtSigned(scenario.totalImpact)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground font-semibold">Projected Revenue</span>
                      <span className="font-bold text-blue-600 dark:text-blue-400" data-testid="text-projected-revenue">
                        ฿{fmtBaht(scenario.projectedRevenue)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Opportunity Score */}
                {opportunity && opportunity.some((o) => o.headroom > 0) && (
                  <div className="neu-inset rounded-xl p-3" data-testid="card-opportunity-score">
                    <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
                      <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
                      Opportunity Score — where the gap can realistically close
                    </p>
                    <div className="space-y-1.5">
                      {opportunity.map((o) => (
                        <div key={o.leverId} data-testid={`opportunity-${o.leverId}`}>
                          <div className="flex justify-between text-[10px] mb-0.5">
                            <span className="text-muted-foreground">{o.label}</span>
                            <span className="font-semibold">
                              {o.sharePct.toFixed(0)}% · up to {fmtSigned(o.headroom)}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-amber-500/70 transition-all"
                              style={{ width: `${Math.min(100, o.sharePct)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recommended plans */}
                {plans && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Recommended Plans
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      {plans.map((plan) => (
                        <div
                          key={plan.id}
                          className={`rounded-xl p-2.5 border ${
                            plan.reachesTarget ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/60"
                          }`}
                          data-testid={`plan-${plan.id}`}
                        >
                          <p className="text-xs font-bold">{plan.label}</p>
                          <p className="text-[9px] text-muted-foreground leading-tight mb-1.5">{plan.description}</p>
                          <div className="space-y-0.5 mb-1.5">
                            {levers.map((lv) => (
                              <p key={lv.id} className="text-[9px] text-muted-foreground flex justify-between">
                                <span>{lv.label}</span>
                                <span className="font-semibold text-foreground">
                                  {Math.round(plan.values[lv.id]).toLocaleString()}{lv.unitSuffix}
                                </span>
                              </p>
                            ))}
                          </div>
                          <p className="text-xs font-bold" style={{ color: plan.reachesTarget ? "#10b981" : undefined }}>
                            ฿{fmtBaht(plan.projectedRevenue)}
                            <span className="text-[9px] font-semibold text-muted-foreground ml-1">
                              ({plan.pctOfTarget.toFixed(0)}% of target)
                            </span>
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full h-6 mt-1.5 text-[10px] btn-press"
                            onClick={() => setPlanned({ ...plan.values })}
                            data-testid={`btn-apply-plan-${plan.id}`}
                          >
                            Apply Plan
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {baselines && baselines.warnings.length > 0 && (
                  <div
                    className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-1"
                    data-testid="card-baseline-warnings"
                  >
                    <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Check these assumptions
                    </p>
                    {baselines.warnings.map((w, i) => (
                      <p key={i} className="text-[9px] text-amber-700 dark:text-amber-300 leading-tight">
                        {w}
                      </p>
                    ))}
                  </div>
                )}

                {baselines && (
                  <div className="space-y-0.5" data-testid="text-data-sources">
                    <p className="text-[9px] text-muted-foreground">
                      <span className="font-semibold">Birthday parties:</span>{" "}
                      {baselines.partySource === "linked-events"
                        ? `from linked birthday events — the same source as the Events tab${baselines.partySampleEvents > 0 ? ` (${baselines.partySampleEvents} event${baselines.partySampleEvents === 1 ? "" : "s"} across ${baselines.partySampleMonths} month${baselines.partySampleMonths === 1 ? "" : "s"})` : ""}. Never counted from receipts or line items.`
                        : "no linked birthday events available for this branch, so the birthday lever has no baseline."}
                    </p>
                    <p className="text-[9px] text-muted-foreground">
                      <span className="font-semibold">Visitors &amp; spending:</span>{" "}
                      {isFuture
                        ? `last ${monthName} volumes scaled by recent growth; per-guest spending from recent months (${baselines.sampleDays} days of data).`
                        : `daily averages from ${baselines.sampleDays} days of sales history.`}
                    </p>
                    {baselines.usedFallbacks && (
                      <p className="text-[9px] text-muted-foreground">
                        {isFuture
                          ? `Some baselines fall back to recent months because last ${monthName}'s data is thin.`
                          : "Some baselines use a widened lookback window because this month's history is thin."}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function LeverRow({
  lever,
  value,
  impact,
  onChange,
}: {
  lever: LeverConfig;
  value: number;
  impact: number;
  onChange: (v: number) => void;
}) {
  const Icon = LEVER_ICONS[lever.id] || TrendingUp;
  const disabled = lever.max <= lever.min;
  const changed = value !== lever.baseline;
  return (
    <div className="neu-inset rounded-xl p-3" data-testid={`lever-${lever.id}`}>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-semibold flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-blue-500" />
          {lever.label}
          {lever.detail && (
            <span className="text-[9px] font-normal text-muted-foreground">· {lever.detail}</span>
          )}
        </p>
        <span
          className="text-xs font-bold"
          style={{ color: impact > 0 ? "#10b981" : impact < 0 ? "#ef4444" : undefined }}
          data-testid={`lever-impact-${lever.id}`}
        >
          {impact === 0 ? "" : fmtSigned(impact)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Slider
          value={[value]}
          min={lever.min}
          max={Math.max(lever.max, lever.min + lever.step)}
          step={lever.step}
          disabled={disabled}
          onValueChange={([v]) => onChange(v)}
          className="flex-1"
          data-testid={`slider-${lever.id}`}
        />
        <p className="text-[10px] w-32 text-right shrink-0" data-testid={`lever-values-${lever.id}`}>
          <span className="text-muted-foreground">{Math.round(lever.baseline).toLocaleString()}{lever.unitSuffix}</span>
          <span className="text-muted-foreground mx-1">→</span>
          <span className={changed ? "font-bold text-blue-600 dark:text-blue-400" : "font-semibold"}>
            {Math.round(value).toLocaleString()}{lever.unitSuffix}
          </span>
        </p>
      </div>
    </div>
  );
}
