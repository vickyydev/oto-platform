import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
} from "recharts";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Plus,
  Copy,
  Trash2,
  Pencil,
  ExternalLink,
  ScanLine,
  MousePointerClick,
  Save,
  CheckCircle2,
  BarChart3,
  QrCode,
  Download,
  TrendingUp,
  TrendingDown,
  Minus,
  Gift,
} from "lucide-react";
import { Link } from "wouter";
import type { CampaignWithStats, InsertCampaign } from "@shared/schema";

type Granularity = "day" | "week" | "month";

type TimeBucket = {
  bucket: string;
  scanned: number;
  saved: number;
  redeemed: number;
};

type CampaignSeries = {
  campaignId: string;
  campaignName: string;
  promoCode: string;
  buckets: TimeBucket[];
  totals: { scanned: number; saved: number; redeemed: number };
};

type TimeSeries = {
  granularity: Granularity;
  start: string;
  end: string;
  buckets: string[];
  combined: TimeBucket[];
  perCampaign: CampaignSeries[];
  totals: { scanned: number; saved: number; redeemed: number };
};

export type CampaignsTabProps = {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  granularity: Granularity;
  compare: { start: string; end: string; label: string } | null;
};

const formSchema = z.object({
  name: z.string().min(1, "Required").max(120),
  promoCode: z.string().min(1, "Required").max(60),
  description: z.string().max(500).optional(),
  status: z.enum(["active", "disabled"]).default("active"),
  expiresAtStr: z.string().optional(),
  usageCapStr: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

// ===== Spin & Win booth claims (pushed in by the game app) =====
type BoothClaim = {
  claimId: string;
  source: string;
  prizeName: string | null;
  phone: string | null;
  code: string | null;
  status: "won" | "claimed" | "redeemed" | "re_redeemed" | "expired";
  wonAt: string | null;
  claimedAt: string | null;
  redeemedAt: string | null;
  reRedeemedAt: string | null;
  expiredAt: string | null;
  lastEventAt: string;
};

type BoothClaimsSummary = {
  totals: { won: number; redeemed: number; reRedeemed: number; expired: number; outstanding: number };
  claims: BoothClaim[];
};

const BOOTH_STATUS_LABELS: Record<BoothClaim["status"], { label: string; className: string }> = {
  won: { label: "Won", className: "bg-sky-100 text-sky-800 border-sky-200" },
  claimed: { label: "Claimed", className: "bg-amber-100 text-amber-800 border-amber-200" },
  redeemed: { label: "Redeemed", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  re_redeemed: { label: "Re-redeem attempt", className: "bg-rose-100 text-rose-800 border-rose-200" },
  expired: { label: "Expired", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

function formatBkk(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Stats = {
  totals: { clicks: number; issued: number; saved: number; redeemed: number };
  campaigns: CampaignWithStats[];
  recentRedemptions: Array<{
    token: string;
    shortCode: string;
    campaignId: string;
    campaignName: string;
    promoCode: string;
    redeemedAt: string;
    redeemedBy: string | null;
  }>;
};

function toInsert(values: FormValues): InsertCampaign {
  return {
    name: values.name.trim(),
    promoCode: values.promoCode.trim(),
    description: values.description?.trim() ? values.description.trim() : null,
    status: values.status,
    expiresAt: values.expiresAtStr
      ? (() => {
          const d = new Date(values.expiresAtStr);
          d.setHours(23, 59, 59, 999);
          return d;
        })()
      : null,
    usageCap: values.usageCapStr ? Number(values.usageCapStr) : null,
  } as InsertCampaign;
}

function publicLinkFor(c: CampaignWithStats): string {
  return `${window.location.origin}/c/${c.id}`;
}

function pct(num: number, denom: number) {
  if (!denom) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

const GRANULARITY_ADJECTIVES: Record<Granularity, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
};

function formatBucketLabel(bucket: string, granularity: Granularity): string {
  const [y, m, d] = bucket.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  if (granularity === "month") {
    return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  if (granularity === "week") {
    return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  }
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function CampaignsTab({
  periodStart,
  periodEnd,
  periodLabel,
  granularity,
  compare,
}: CampaignsTabProps) {
  const { toast } = useToast();
  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ["/api/campaigns/stats"],
    refetchInterval: 30_000,
  });

  const [editing, setEditing] = useState<CampaignWithStats | null>(null);
  const [open, setOpen] = useState(false);
  const [posterFor, setPosterFor] = useState<CampaignWithStats | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      promoCode: "",
      description: "",
      status: "active",
      expiresAtStr: "",
      usageCapStr: "",
    },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ name: "", promoCode: "", description: "", status: "active", expiresAtStr: "", usageCapStr: "" });
    setOpen(true);
  };

  const openEdit = (c: CampaignWithStats) => {
    setEditing(c);
    form.reset({
      name: c.name,
      promoCode: c.promoCode,
      description: c.description ?? "",
      status: c.status,
      expiresAtStr: c.expiresAt
        ? (() => {
            const d = new Date(c.expiresAt);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            return `${y}-${m}-${day}`;
          })()
        : "",
      usageCapStr: c.usageCap != null ? String(c.usageCap) : "",
    });
    setOpen(true);
  };

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
    queryClient.invalidateQueries({ queryKey: ["/api/campaigns/stats"] });
  };

  const saveMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = toInsert(values);
      if (editing) {
        const res = await apiRequest("PATCH", `/api/campaigns/${editing.id}`, payload);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/campaigns", payload);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      setOpen(false);
      toast({ title: editing ? "Campaign updated" : "Campaign created" });
    },
    onError: (e: Error) => {
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (c: CampaignWithStats) => {
      const res = await apiRequest("PATCH", `/api/campaigns/${c.id}`, {
        status: c.status === "active" ? "disabled" : "active",
      });
      return res.json();
    },
    onSuccess: () => invalidateAll(),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/campaigns/${id}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Campaign deleted" });
    },
  });

  const copyLink = (c: CampaignWithStats) => {
    navigator.clipboard.writeText(publicLinkFor(c));
    toast({ title: "Link copied", description: publicLinkFor(c) });
  };

  const totals = stats?.totals ?? { clicks: 0, issued: 0, saved: 0, redeemed: 0 };
  const campaigns = stats?.campaigns ?? [];
  const recent = stats?.recentRedemptions ?? [];

  // ===== Time-bucketed analytics (task-143) =====
  // Bucket size (granularity) is derived from the universal topbar period
  // selection — no separate toggle here to avoid duplicating that control.
  const [campaignFilter, setCampaignFilter] = useState<string>("all");

  const { data: series, isLoading: seriesLoading } = useQuery<TimeSeries>({
    queryKey: ["/api/campaigns/timeseries", periodStart, periodEnd, granularity],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/campaigns/timeseries?start=${periodStart}&end=${periodEnd}&granularity=${granularity}`,
      );
      return res.json();
    },
    enabled: !!periodStart && !!periodEnd,
  });

  const { data: compareSeries } = useQuery<TimeSeries>({
    queryKey: ["/api/campaigns/timeseries", compare?.start, compare?.end, granularity, "compare"],
    queryFn: async () => {
      if (!compare) return null as unknown as TimeSeries;
      const res = await apiRequest(
        "GET",
        `/api/campaigns/timeseries?start=${compare.start}&end=${compare.end}&granularity=${granularity}`,
      );
      return res.json();
    },
    enabled: !!compare,
  });

  // Chart rows: combined across campaigns, or a single campaign's buckets.
  const chartRows = useMemo(() => {
    if (!series) return [];
    const source =
      campaignFilter === "all"
        ? series.combined
        : series.perCampaign.find((c) => c.campaignId === campaignFilter)?.buckets ?? [];
    return source.map((b) => ({
      ...b,
      label: formatBucketLabel(b.bucket, series.granularity),
      convPct: b.scanned > 0 ? Math.round((b.redeemed / b.scanned) * 100) : null,
    }));
  }, [series, campaignFilter]);

  // Per-campaign table rows for the whole selected period (drop campaigns with
  // no activity so the table stays focused). Sort by scans desc.
  const tableRows = useMemo(() => {
    if (!series) return [];
    return series.perCampaign
      .filter((c) => c.totals.scanned + c.totals.saved + c.totals.redeemed > 0)
      .sort((a, b) => b.totals.scanned - a.totals.scanned);
  }, [series]);

  const periodTotals = series?.totals ?? { scanned: 0, saved: 0, redeemed: 0 };
  const compareTotals = compareSeries?.totals ?? null;

  // Spin & Win prize claims pushed in by the game app.
  const { data: boothData } = useQuery<BoothClaimsSummary>({
    queryKey: ["/api/booth/claims"],
    refetchInterval: 30_000,
  });
  const boothClaims = boothData?.claims ?? [];
  const boothTotals = boothData?.totals ?? { won: 0, redeemed: 0, reRedeemed: 0, expired: 0, outstanding: 0 };

  // Simple totals per prize (from the recent claims list).
  const boothPrizeTotals = useMemo(() => {
    const map = new Map<string, { total: number; redeemed: number }>();
    for (const c of boothClaims) {
      const key = c.prizeName ?? "Unknown prize";
      const entry = map.get(key) ?? { total: 0, redeemed: 0 };
      entry.total += 1;
      if (c.status === "redeemed" || c.status === "re_redeemed") entry.redeemed += 1;
      map.set(key, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [boothClaims]);

  return (
    <div className="space-y-4">
      <Link href="/redeem">
        <a
          className="group relative flex w-full items-center justify-center gap-4 rounded-2xl bg-primary px-6 py-6 sm:py-7 text-primary-foreground shadow-lg shadow-primary/30 ring-1 ring-primary/40 transition-transform hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/40 active:translate-y-0 cursor-pointer"
          data-testid="button-big-redeem"
        >
          <div className="rounded-full bg-primary-foreground/15 p-3">
            <ScanLine className="h-8 w-8" />
          </div>
          <div className="text-left">
            <p className="text-xl sm:text-2xl font-extrabold tracking-tight">
              Redeem QR at Reception
            </p>
            <p className="text-sm opacity-90">
              Tap to enter the guest's 4-character redemption code
            </p>
          </div>
          <span className="ml-2 hidden sm:inline-flex items-center rounded-full bg-primary-foreground/15 px-3 py-1 text-xs font-semibold uppercase tracking-wider">
            Open →
          </span>
        </a>
      </Link>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<MousePointerClick className="h-5 w-5" />} label="Total clicks" value={totals.clicks} testId="stat-clicks" />
        <StatCard icon={<Save className="h-5 w-5" />} label="Saved QRs" value={totals.saved} testId="stat-saved" />
        <StatCard icon={<CheckCircle2 className="h-5 w-5" />} label="Redeemed" value={totals.redeemed} testId="stat-redeemed" />
        <StatCard icon={<BarChart3 className="h-5 w-5" />} label="Conversion" value={pct(totals.redeemed, totals.clicks)} testId="stat-conversion" />
      </div>

      <Card data-testid="card-booth-claims">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="rounded-full bg-emerald-100 p-2 text-emerald-700">
                <Gift className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Spin &amp; Win prizes</CardTitle>
                <p className="text-xs text-slate-500 mt-0.5">
                  Sent automatically by the Spin &amp; Win game — no manual entry needed
                </p>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-xs">
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                {boothTotals.redeemed} redeemed
              </Badge>
              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                {boothTotals.outstanding} outstanding
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {boothClaims.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center" data-testid="text-booth-empty">
              No prizes received from the Spin &amp; Win game yet. Once the game is connected,
              every prize won and redeemed will appear here automatically.
            </p>
          ) : (
            <>
            {boothPrizeTotals.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-3" data-testid="booth-prize-totals">
                <span className="text-xs text-slate-500">Recent claims by prize:</span>
                {boothPrizeTotals.map(([prize, t]) => (
                  <Badge key={prize} variant="outline" className="bg-slate-50 text-slate-700 border-slate-200 font-normal">
                    {prize}: {t.total} won · {t.redeemed} redeemed
                  </Badge>
                ))}
              </div>
            )}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Prize</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Won</TableHead>
                    <TableHead>Redeemed</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {boothClaims.slice(0, 50).map((c) => {
                    const s = BOOTH_STATUS_LABELS[c.status];
                    return (
                      <TableRow key={c.claimId} data-testid={`row-booth-claim-${c.claimId}`}>
                        <TableCell className="font-medium">{c.prizeName ?? "—"}</TableCell>
                        <TableCell className="text-slate-600">{c.phone ?? "—"}</TableCell>
                        <TableCell className="text-slate-600 font-mono text-xs">{c.code ?? "—"}</TableCell>
                        <TableCell className="text-slate-600 whitespace-nowrap">{formatBkk(c.wonAt ?? c.claimedAt)}</TableCell>
                        <TableCell className="text-slate-600 whitespace-nowrap">{formatBkk(c.redeemedAt)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={s.className}>{s.label}</Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-campaign-analytics">
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <CardTitle className="text-base">Performance over time</CardTitle>
              <p className="text-xs text-slate-500 mt-0.5" data-testid="text-analytics-period">
                {periodLabel} · {GRANULARITY_ADJECTIVES[granularity]} buckets
                {compare ? <> · vs {compare.label}</> : null}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={campaignFilter} onValueChange={setCampaignFilter}>
                <SelectTrigger className="h-8 w-[180px] text-xs" data-testid="select-campaign-filter">
                  <SelectValue placeholder="All campaigns" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All campaigns</SelectItem>
                  {(series?.perCampaign ?? campaigns.map((c) => ({ campaignId: c.id, campaignName: c.name })) as any).map((c: any) => (
                    <SelectItem key={c.campaignId} value={c.campaignId}>
                      {c.campaignName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Period totals + comparison deltas */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <TotalTile label="Scanned" value={periodTotals.scanned} compareValue={compareTotals?.scanned} testId="total-scanned" />
            <TotalTile label="Saved" value={periodTotals.saved} compareValue={compareTotals?.saved} testId="total-saved" />
            <TotalTile label="Redeemed" value={periodTotals.redeemed} compareValue={compareTotals?.redeemed} testId="total-redeemed" />
            <TotalTile
              label="Redeemed / Scanned"
              value={pct(periodTotals.redeemed, periodTotals.scanned)}
              compareValue={
                compareTotals ? pct(compareTotals.redeemed, compareTotals.scanned) : undefined
              }
              testId="total-conversion"
            />
          </div>
        </CardHeader>
        <CardContent>
          {seriesLoading ? (
            <div className="flex items-center justify-center gap-2 text-slate-500 py-16" data-testid="status-chart-loading">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading analytics...
            </div>
          ) : chartRows.length === 0 || periodTotals.scanned + periodTotals.saved + periodTotals.redeemed === 0 ? (
            <div className="flex flex-col items-center justify-center text-slate-500 py-16 text-sm" data-testid="status-chart-empty">
              <BarChart3 className="h-8 w-8 mb-2 opacity-40" />
              No scans, saves, or redemptions in this period.
            </div>
          ) : (
            <div className="h-72 w-full" data-testid="chart-campaign-trend">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartRows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <RechartsTooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    formatter={(value: any, name: any) => [value, name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="scanned" name="Scanned" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="saved" name="Saved" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="redeemed" name="Redeemed" fill="#10b981" radius={[3, 3, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-campaign-breakdown">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Per-campaign breakdown</CardTitle>
          <p className="text-xs text-slate-500">{periodLabel}</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="text-right">Scanned</TableHead>
                  <TableHead className="text-right">Saved</TableHead>
                  <TableHead className="text-right">Redeemed</TableHead>
                  <TableHead className="text-right">Redeemed / Scanned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {seriesLoading && (
                  <TableRow><TableCell colSpan={5}>
                    <div className="flex items-center gap-2 text-slate-500 py-6 justify-center">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                    </div>
                  </TableCell></TableRow>
                )}
                {!seriesLoading && tableRows.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-slate-500 py-8">
                    No campaign activity in this period.
                  </TableCell></TableRow>
                )}
                {tableRows.map((c) => (
                  <TableRow key={c.campaignId} data-testid={`row-breakdown-${c.campaignId}`}>
                    <TableCell className="font-medium" data-testid={`text-breakdown-name-${c.campaignId}`}>
                      {c.campaignName}
                    </TableCell>
                    <TableCell className="text-right" data-testid={`text-breakdown-scanned-${c.campaignId}`}>{c.totals.scanned}</TableCell>
                    <TableCell className="text-right" data-testid={`text-breakdown-saved-${c.campaignId}`}>{c.totals.saved}</TableCell>
                    <TableCell className="text-right" data-testid={`text-breakdown-redeemed-${c.campaignId}`}>{c.totals.redeemed}</TableCell>
                    <TableCell className="text-right" data-testid={`text-breakdown-conversion-${c.campaignId}`}>
                      {pct(c.totals.redeemed, c.totals.scanned)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Campaigns</CardTitle>
          <Button onClick={openCreate} size="sm" className="gap-2" data-testid="button-new-campaign">
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Voucher code</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Saved</TableHead>
                  <TableHead className="text-right">Redeemed</TableHead>
                  <TableHead className="w-72"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statsLoading && (
                  <TableRow><TableCell colSpan={8}>
                    <div className="flex items-center gap-2 text-slate-500 py-6 justify-center">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                    </div>
                  </TableCell></TableRow>
                )}
                {!statsLoading && campaigns.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-slate-500 py-8">
                    No campaigns yet. Create your first one.
                  </TableCell></TableRow>
                )}
                {campaigns.map((c) => (
                  <TableRow key={c.id} data-testid={`row-campaign-${c.id}`}>
                    <TableCell className="font-medium" data-testid={`text-name-${c.id}`}>{c.name}</TableCell>
                    <TableCell><code className="text-xs bg-muted px-2 py-1 rounded">{c.promoCode}</code></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={c.status === "active"}
                          onCheckedChange={() => toggleMutation.mutate(c)}
                          data-testid={`switch-status-${c.id}`}
                        />
                        <Badge variant={c.status === "active" ? "default" : "secondary"}>
                          {c.status}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-slate-500">
                      {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right" data-testid={`text-clicks-${c.id}`}>{c.clicks}</TableCell>
                    <TableCell className="text-right" data-testid={`text-saved-${c.id}`}>{c.saved}</TableCell>
                    <TableCell className="text-right" data-testid={`text-redeemed-${c.id}`}>{c.redeemed}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 justify-end">
                        <Button size="sm" variant="default" onClick={() => setPosterFor(c)} data-testid={`button-poster-${c.id}`}>
                          <QrCode className="h-3.5 w-3.5 mr-1" /> Poster QR
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => copyLink(c)} data-testid={`button-copy-${c.id}`}>
                          <Copy className="h-3.5 w-3.5 mr-1" /> Copy link
                        </Button>
                        <a href={publicLinkFor(c)} target="_blank" rel="noreferrer">
                          <Button size="sm" variant="ghost" aria-label="Open public link"
                            data-testid={`button-open-${c.id}`}>
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(c)} aria-label="Edit campaign"
                          data-testid={`button-edit-${c.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Delete "${c.name}"?`)) deleteMutation.mutate(c.id);
                          }}
                          aria-label="Delete campaign"
                          data-testid={`button-delete-${c.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent redemptions</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Redemption code</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-center text-slate-500 py-6">
                    No redemptions yet.
                  </TableCell></TableRow>
                )}
                {recent.map((r) => (
                  <TableRow key={r.token} data-testid={`row-redemption-${r.token}`}>
                    <TableCell className="text-sm text-slate-500">
                      {new Date(r.redeemedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{r.campaignName}</TableCell>
                    <TableCell><code className="text-xs bg-muted px-2 py-1 rounded font-mono tracking-widest">{r.shortCode}</code></TableCell>
                    <TableCell className="text-sm text-slate-500">{r.redeemedBy ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit campaign" : "New campaign"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl><Input placeholder="IG Birthday Promo" {...field} data-testid="input-name" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="promoCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Voucher code from POS</FormLabel>
                    <FormControl><Input placeholder="e.g. 4e856ccafc87240d" {...field} data-testid="input-promo-code" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>What guests see (description)</FormLabel>
                    <FormControl>
                      <textarea
                        rows={3}
                        placeholder="e.g. 10% discount on a kid entry ticket when redeemed at reception."
                        className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        data-testid="input-description"
                      />
                    </FormControl>
                    <p className="text-xs text-slate-500">Shown to guests on the QR page so they know what the voucher is for and where to use it.</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="expiresAtStr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Expires (optional)</FormLabel>
                      <FormControl>
                        <DatePicker
                          value={field.value || undefined}
                          onChange={field.onChange}
                          placeholder="Pick a date"
                          data-testid="input-expires-at"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="usageCapStr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Usage cap (optional)</FormLabel>
                      <FormControl>
                        <Input type="number" min="1" {...field} data-testid="input-usage-cap" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <FormLabel>Active</FormLabel>
                      <p className="text-xs text-slate-500">Disabled campaigns reject new QR requests.</p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value === "active"}
                        onCheckedChange={(v) => field.onChange(v ? "active" : "disabled")}
                        data-testid="switch-form-active"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} data-testid="button-cancel">
                  Cancel
                </Button>
                <Button type="submit" disabled={saveMutation.isPending} data-testid="button-save">
                  {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  {editing ? "Save changes" : "Create campaign"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <PosterQrDialog
        campaign={posterFor}
        url={posterFor ? publicLinkFor(posterFor) : ""}
        onClose={() => setPosterFor(null)}
      />
    </div>
  );
}

function PosterQrDialog({
  campaign,
  url,
  onClose,
}: {
  campaign: CampaignWithStats | null;
  url: string;
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const open = !!campaign;

  useEffect(() => {
    if (!campaign || !url) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const qrPng = await QRCode.toDataURL(url, {
          width: 1000,
          margin: 1,
          errorCorrectionLevel: "H",
        });
        const qrImg = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = qrPng;
        });
        const W = 1080;
        const H = 1500;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, H);

        ctx.fillStyle = "#0f172a";
        ctx.textAlign = "center";
        ctx.font = "800 56px system-ui, -apple-system, sans-serif";
        ctx.fillText(campaign.name, W / 2, 130);

        ctx.fillStyle = "#475569";
        ctx.font = "500 30px system-ui, -apple-system, sans-serif";
        ctx.fillText("Scan to claim your voucher", W / 2, 190);

        const qrSize = 880;
        const qrX = (W - qrSize) / 2;
        const qrY = 260;
        ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

        ctx.fillStyle = "#94a3b8";
        ctx.font = "500 22px system-ui, -apple-system, sans-serif";
        ctx.fillText("Or open this link", W / 2, qrY + qrSize + 60);

        ctx.fillStyle = "#334155";
        ctx.font = "600 26px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(url, W / 2, qrY + qrSize + 100);

        if (!cancelled) setDataUrl(canvas.toDataURL("image/png"));
      } catch {
        if (!cancelled) setDataUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaign, url]);

  const onDownload = () => {
    if (!dataUrl || !campaign) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `poster-${campaign.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md" data-testid="dialog-poster-qr">
        <DialogHeader>
          <DialogTitle>Poster QR — {campaign?.name ?? ""}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            Print or share this QR. When customers scan it, they will land on the
            voucher page and get their personal redemption code.
          </p>
          <div className="rounded-lg border bg-white p-3 flex items-center justify-center min-h-[280px]">
            {dataUrl ? (
              <img src={dataUrl} alt="Poster QR" className="w-full max-w-xs" data-testid="img-poster-qr" />
            ) : (
              <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
            )}
          </div>
          <p className="text-xs text-slate-500 break-all">
            Link: <code className="bg-muted px-1.5 py-0.5 rounded">{url}</code>
          </p>
          <p className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 rounded p-2">
            Note: do <strong>not</strong> screenshot the inner promo-code QR
            shown on the voucher card. That one only carries the redemption text
            for reception staff and won't open any page when scanned.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-close-poster">
            Close
          </Button>
          <Button onClick={onDownload} disabled={!dataUrl} className="gap-2" data-testid="button-download-poster">
            <Download className="h-4 w-4" /> Download PNG
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TotalTile({
  label,
  value,
  compareValue,
  testId,
}: {
  label: string;
  value: number | string;
  compareValue?: number | string;
  testId: string;
}) {
  const numeric = typeof value === "number" && typeof compareValue === "number";
  const delta = numeric ? (value as number) - (compareValue as number) : 0;
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <p className="text-[11px] text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-lg font-bold leading-tight" data-testid={testId}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {compareValue !== undefined && (
        <div className="flex items-center gap-1 text-[11px] mt-0.5" data-testid={`${testId}-compare`}>
          {numeric ? (
            <span
              className={
                "inline-flex items-center gap-0.5 font-medium " +
                (delta > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : delta < 0
                    ? "text-red-500"
                    : "text-slate-500")
              }
            >
              {delta > 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : delta < 0 ? (
                <TrendingDown className="h-3 w-3" />
              ) : (
                <Minus className="h-3 w-3" />
              )}
              {delta > 0 ? "+" : ""}
              {(delta as number).toLocaleString()}
            </span>
          ) : null}
          <span className="text-slate-500">
            {typeof compareValue === "number" ? compareValue.toLocaleString() : compareValue} prev
          </span>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold mt-1" data-testid={testId}>
              {typeof value === "number" ? value.toLocaleString() : value}
            </p>
          </div>
          <div className="text-slate-500">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}
