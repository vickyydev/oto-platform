import { createHash } from "crypto";
import { PLATFORM_SESSION_COOKIE, platformApiUrl } from "../platformSession";

/**
 * Radar's one source of figures (S2-18 R3): the OTO POS rollup, read through
 * the platform's `GET /analytics/summary` (and, for the booth, its sibling
 * `GET /analytics/booths`) for every branch.
 *
 * Radar holds no service credential. Every read forwards the signed-in
 * person's own platform session token, so the platform authorises the person
 * by its own rules — `pos:cash:read` or `analytics:read` at the branch, and
 * `analytics:read` to add several up — and Radar can never show more than
 * that person may see.
 *
 * The contract is `AnalyticsSummarySchema` in packages/shared/src/analytics.ts
 * (Radar is outside the pnpm workspace, so the shapes it reads are restated
 * below). Money arrives in satang and leaves in baht, the unit every Radar
 * screen was written in.
 */

// --- The contract, as Radar reads it -----------------------------------------------

export interface SummaryRow {
  businessDate: string | null;
  ticketsSatang: number;
  fnbSatang: number;
  merchSatang: number;
  partiesSatang: number;
  dropoffSatang: number;
  revenueSatang: number;
  txnCount: number;
  creditPaidSatang: number;
  guestsKids: number;
  guestsAdults: number;
  mix1h: number;
  mix2h: number;
  mixFullDay: number;
  partiesCount: number;
  refundsSatang: number;
  discountsSatang: number;
  compsSatang: number;
  vatSatang: number;
  serviceSatang: number;
  byChannel: Record<string, { revenue: number; txn_count: number }>;
  provisional: boolean;
  rolledDays: number;
  computedAt: string | null;
  formulaVersion: number | null;
}

export interface SummaryHour {
  hour: number;
  ticketsSatang: number;
  fnbSatang: number;
  merchSatang: number;
  partiesSatang: number;
  dropoffSatang: number;
  revenueSatang: number;
  txnCount: number;
  guests: number;
}

export interface SummaryBranch {
  branchId: string;
  name: string;
  source: string;
  timezone: string;
  businessDayStart: string;
  today: string;
  lastRolledUpAt: string | null;
  rows: SummaryRow[];
}

export interface Summary {
  from: string;
  to: string;
  group: "day" | "total";
  source: string | null;
  branches: SummaryBranch[];
  omitted: string[];
  readable: Array<{ branchId: string; name: string }>;
  mergeable: Array<{ branchId: string; name: string }>;
  merged: SummaryRow[];
  hours: SummaryHour[] | null;
  lastRolledUpAt: string | null;
}

/** `BoothReportSchema` (packages/shared/src/analytics-reports.ts), the parts Radar reads. */
export interface BoothFunnel {
  spins: number;
  prizesWon: number;
  vouchersIssued: number;
  vouchersRedeemed: number;
  redemptionRate: number | null;
  meanRedemptionLagS: number | null;
  prizeCostSatang: number;
  prizeCostIncomplete: boolean;
}
export interface BoothReport {
  booths: Array<BoothFunnel & { boothId: string; name: string; branchId: string; branchName: string }>;
  prizes: Array<BoothFunnel & { boothId: string; prizeId: string; name: string }>;
  days: Array<BoothFunnel & { boothId: string; businessDate: string }>;
  lastRolledUpAt: string | null;
}

// --- Branches ------------------------------------------------------------------

/**
 * Radar's two parks, as its screens have always named them. The summary
 * answers by platform branch (id and name; it carries no code), so each key is
 * matched to the platform branch whose name carries the mall's name — the
 * seed's "Oto Play Park, Central Floresta" (code `hkt-central`) and "Oto Play
 * Park, Robinson Chalong" (code `robinson-chalong`). A park the person may not
 * read, or that does not exist, is simply absent.
 */
export const RADAR_BRANCH_KEYS = ["floresta", "chalong"] as const;
export type RadarBranchKey = (typeof RADAR_BRANCH_KEYS)[number];

const BRANCH_NAME_MATCH: Record<RadarBranchKey, RegExp> = {
  floresta: /floresta/i,
  chalong: /chalong/i,
};

export function isRadarBranchKey(value: unknown): value is RadarBranchKey {
  return typeof value === "string" && (RADAR_BRANCH_KEYS as readonly string[]).includes(value);
}

export interface PlatformBranch {
  branchId: string;
  name: string;
}

/** Pure: which platform branch each Radar key means, out of the branches the person may read. */
export function mapBranches(readable: readonly PlatformBranch[]): Map<RadarBranchKey, PlatformBranch> {
  const out = new Map<RadarBranchKey, PlatformBranch>();
  for (const key of RADAR_BRANCH_KEYS) {
    const match = readable.find((b) => BRANCH_NAME_MATCH[key].test(b.name));
    if (match) out.set(key, match);
  }
  return out;
}

// --- Reading the platform -----------------------------------------------------------

export class PlatformReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlatformReadError";
  }
}

const READ_TIMEOUT_MS = 20_000;

async function platformGet<T>(token: string, path: string, query: Record<string, string | undefined>): Promise<T> {
  const apiUrl = platformApiUrl();
  if (!apiUrl) throw new PlatformReadError(503, "PLATFORM_API_URL is not set: Radar has no figures to read.");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
  let res: globalThis.Response;
  try {
    res = await fetch(`${apiUrl}${path}?${qs.toString()}`, {
      headers: { cookie: `${PLATFORM_SESSION_COOKIE}=${token}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    throw new PlatformReadError(503, "The platform did not answer. Try again in a moment.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
    const message =
      typeof body?.error?.message === "string" ? body.error.message : `The platform refused the read (${res.status}).`;
    // A platform 401 is Radar's 401 too: the session behind the cookie is gone.
    throw new PlatformReadError(res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502, message);
  }
  return (await res.json()) as T;
}

/** Today's calendar date in Bangkok — a first guess the summary corrects with each branch's own `today`. */
export function bangkokToday(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The summary's own ceiling (ANALYTICS_SUMMARY_MAX_DAYS). */
export const SUMMARY_MAX_DAYS = 366;

const branchCache = new Map<string, { at: number; value: Promise<Map<RadarBranchKey, PlatformBranch>> }>();
const BRANCH_TTL_MS = 60_000;

/** The person's readable branches, by Radar key. Cached a minute per session. */
export function platformBranches(token: string): Promise<Map<RadarBranchKey, PlatformBranch>> {
  const key = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const hit = branchCache.get(key);
  if (hit && now - hit.at < BRANCH_TTL_MS) return hit.value;
  const today = bangkokToday();
  const value = platformGet<Summary>(token, "/analytics/summary", { from: today, to: today, group: "total" }).then(
    (s) => mapBranches(s.readable),
  );
  value.catch(() => branchCache.delete(key));
  branchCache.set(key, { at: now, value });
  branchCache.forEach((v, k) => {
    if (now - v.at >= BRANCH_TTL_MS) branchCache.delete(k);
  });
  return value;
}

async function branchIdsOf(token: string, keys: readonly RadarBranchKey[]): Promise<PlatformBranch[]> {
  const map = await platformBranches(token);
  const out: PlatformBranch[] = [];
  for (const key of keys) {
    const b = map.get(key);
    if (!b) {
      throw new PlatformReadError(404, `Your account cannot read ${key === "floresta" ? "Floresta" : "Chalong"}'s figures.`);
    }
    out.push(b);
  }
  return out;
}

/**
 * The summary for one or more Radar parks over any range: a `day` range longer
 * than the platform's ceiling is read in windows and joined.
 */
export async function readSummary(
  token: string,
  keys: readonly RadarBranchKey[],
  from: string,
  to: string,
  group: "day" | "total",
): Promise<Summary> {
  const branches = (await branchIdsOf(token, keys)).map((b) => b.branchId).join(",");
  if (group === "total" || dayCount(from, to) <= SUMMARY_MAX_DAYS) {
    return platformGet<Summary>(token, "/analytics/summary", { branches, from, to, group });
  }
  if (group !== "day") throw new PlatformReadError(400, "A total covers at most a year and a day.");
  const parts: Summary[] = [];
  for (let start = from; start <= to; start = addDays(start, SUMMARY_MAX_DAYS)) {
    const end = addDays(start, SUMMARY_MAX_DAYS - 1) < to ? addDays(start, SUMMARY_MAX_DAYS - 1) : to;
    parts.push(await platformGet<Summary>(token, "/analytics/summary", { branches, from: start, to: end, group }));
  }
  const first = parts[0]!;
  return {
    ...first,
    to,
    branches: first.branches.map((b) => ({
      ...b,
      rows: parts.flatMap((p) => p.branches.find((x) => x.branchId === b.branchId)?.rows ?? []),
    })),
    merged: parts.flatMap((p) => p.merged),
    hours: null,
    lastRolledUpAt: parts[parts.length - 1]!.lastRolledUpAt,
  };
}

/** One park's business date in progress, from the platform rather than a Bangkok guess. */
export async function branchToday(token: string, key: RadarBranchKey): Promise<string> {
  const guess = bangkokToday();
  const s = await readSummary(token, [key], guess, guess, "total");
  return s.branches[0]?.today ?? guess;
}

/** The booth report (`GET /analytics/booths`) for the given parks. */
export async function readBoothReport(
  token: string,
  keys: readonly RadarBranchKey[],
  from: string,
  to: string,
): Promise<BoothReport> {
  const branches = (await branchIdsOf(token, keys)).map((b) => b.branchId).join(",");
  return platformGet<BoothReport>(token, "/analytics/booths", { branches, from, to });
}

// --- Mapping onto Radar's shapes -------------------------------------------------------

const baht = (satang: number): number => Math.round(satang) / 100;

/** The summary's five money buckets, under the category names Radar's screens use. */
export const CATEGORY_OF_BUCKET = {
  ticketsSatang: "Tickets & Packages",
  fnbSatang: "F&B",
  merchSatang: "Merchandise",
  partiesSatang: "Events / Birthdays",
  dropoffSatang: "Nanny & Drop-off",
} as const;

export interface RadarCategory {
  revenue: number;
  quantity: number;
  items: never[];
}

export function categoriesOf(row: SummaryRow): Record<string, RadarCategory> {
  const quantity: Record<string, number> = {
    ticketsSatang: row.guestsKids + row.guestsAdults,
    partiesSatang: row.partiesCount,
  };
  const out: Record<string, RadarCategory> = {};
  for (const [bucket, name] of Object.entries(CATEGORY_OF_BUCKET)) {
    const satang = row[bucket as keyof typeof CATEGORY_OF_BUCKET];
    if (satang === 0) continue;
    out[name] = { revenue: baht(satang), quantity: quantity[bucket] ?? 0, items: [] };
  }
  return out;
}

function guestBreakdownOf(row: SummaryRow) {
  const total = row.guestsKids + row.guestsAdults;
  return {
    kidTickets: row.guestsKids,
    adultTickets: row.guestsAdults,
    kidRevenue: 0,
    adultRevenue: 0,
    avgStayHours: 0,
    estimatedTotalAdults: row.guestsAdults,
    totalInPark: total,
    stayDistribution: [
      { hours: 1, count: row.mix1h, label: "1 hour" },
      { hours: 2, count: row.mix2h, label: "2 hours" },
      { hours: 24, count: row.mixFullDay, label: "Full day" },
    ].filter((s) => s.count > 0),
    details: [],
  };
}

function hourlyOf(hours: readonly SummaryHour[] | null) {
  return (hours ?? []).map((h) => ({
    hour: h.hour,
    label: `${String(h.hour).padStart(2, "0")}:00`,
    orders: h.txnCount,
    revenue: baht(h.revenueSatang),
    ticketsSold: h.guests,
  }));
}

/** What the dashboard is told about where its figures came from and how fresh they are. */
export interface FiguresProvenance {
  source: string | null;
  formulaVersion: number | null;
  provisional: boolean;
  lastRolledUpAt: string | null;
}

/**
 * One park's (or several parks') range in the dashboard's shape
 * (`DashboardSummaryData` in client/src/pages/funtopia-dashboard.tsx). What
 * the rollup does not carry — the payment mix, products, customer types,
 * order-level lists — is empty rather than invented.
 */
export function dashboardRangeOf(summary: Summary) {
  const total = summary.group === "total" ? summary.merged[0] : sumRows(summary.merged);
  const days = summary.group === "day" ? summary.merged.filter((r) => r.businessDate !== null) : [];
  const versions = new Set(summary.merged.map((r) => r.formulaVersion).filter((v) => v !== null));
  const revenue = total ? baht(total.revenueSatang) : 0;
  const orders = total?.txnCount ?? 0;
  const provenance: FiguresProvenance = {
    source: summary.source,
    formulaVersion: versions.size === 1 ? [...versions][0]! : null,
    provisional: summary.merged.some((r) => r.provisional),
    lastRolledUpAt: summary.lastRolledUpAt,
  };
  return {
    date: summary.from === summary.to ? summary.from : undefined,
    totalRevenue: revenue,
    totalOrders: orders,
    avgOrderValue: orders > 0 ? Math.round(revenue / orders) : 0,
    paymentBreakdown: {} as Record<string, number>,
    topProducts: [] as never[],
    categoryBreakdown: total ? categoriesOf(total) : {},
    discountTotal: total ? baht(total.discountsSatang + total.compsSatang) : 0,
    guestBreakdown: total ? guestBreakdownOf(total) : null,
    hourlyBreakdown: hourlyOf(summary.hours),
    customerTypeSplit: [] as never[],
    voucherSwingAmount: 0,
    pureTicketRevenue: total ? baht(total.ticketsSatang) : 0,
    sourceBreakdown: total
      ? Object.entries(total.byChannel)
          .map(([source, c]) => ({ source, orders: c.txn_count, revenue: baht(c.revenue), discount: 0, variants: [] }))
          .sort((a, b) => b.revenue - a.revenue)
      : [],
    dailyRevenue: days.map((r) => ({
      date: r.businessDate!,
      revenue: baht(r.revenueSatang),
      orders: r.txnCount,
      kids: r.guestsKids,
      adults: r.guestsAdults,
      categories: Object.fromEntries(Object.entries(categoriesOf(r)).map(([k, v]) => [k, v.revenue])),
    })),
    cashReportsDailyTotals: [] as never[],
    dailyHourly: [] as never[],
    staffOnDuty: 0,
    eventCount: total?.partiesCount ?? 0,
    figures: provenance,
  };
}

/** Days added up, the way the platform's `merged` total would be. */
export function sumRows(rows: readonly SummaryRow[]): SummaryRow | undefined {
  if (rows.length === 0) return undefined;
  const out: SummaryRow = { ...rows[0]!, byChannel: {}, businessDate: null };
  const keys = [
    "ticketsSatang", "fnbSatang", "merchSatang", "partiesSatang", "dropoffSatang", "revenueSatang", "txnCount",
    "creditPaidSatang", "guestsKids", "guestsAdults", "mix1h", "mix2h", "mixFullDay", "partiesCount",
    "refundsSatang", "discountsSatang", "compsSatang", "vatSatang", "serviceSatang", "rolledDays",
  ] as const;
  for (const k of keys) out[k] = 0;
  for (const r of rows) {
    for (const k of keys) out[k] += r[k];
    for (const [ch, c] of Object.entries(r.byChannel)) {
      const prev = out.byChannel[ch] ?? { revenue: 0, txn_count: 0 };
      out.byChannel[ch] = { revenue: prev.revenue + c.revenue, txn_count: prev.txn_count + c.txn_count };
    }
  }
  out.provisional = rows.some((r) => r.provisional);
  return out;
}

/** The calendar heatmap's slim days. */
export function calendarDaysOf(summary: Summary): Array<{ date: string; revenue: number; orders: number }> {
  return summary.merged
    .filter((r) => r.businessDate !== null)
    .map((r) => ({ date: r.businessDate!, revenue: baht(r.revenueSatang), orders: r.txnCount }));
}

/**
 * Every day of a range as `{ date, summary }` in the dashboard's shape — what
 * the trends assistant and the chart builder fold over.
 */
export function dailySummariesOf(summary: Summary): Array<{ date: string; summary: ReturnType<typeof dashboardRangeOf> }> {
  return summary.merged
    .filter((r) => r.businessDate !== null && r.rolledDays > 0)
    .map((r) => ({
      date: r.businessDate!,
      summary: dashboardRangeOf({ ...summary, group: "total", from: r.businessDate!, to: r.businessDate!, merged: [r], hours: null }),
    }));
}

/**
 * The booth report in the shape of the redeem page's Spin Wheel report: per
 * prize, won / redeemed / still outstanding, added up across booths. The
 * platform's vouchers have no four-digit capacity, so there is none.
 */
export function spinReportOf(report: BoothReport) {
  const byPrize = new Map<string, { prizeId: string; displayName: string; won: number; issued: number; redeemed: number }>();
  for (const p of report.prizes) {
    const prev = byPrize.get(p.prizeId) ?? { prizeId: p.prizeId, displayName: p.name, won: 0, issued: 0, redeemed: 0 };
    prev.won += p.prizesWon;
    prev.issued += p.vouchersIssued;
    prev.redeemed += p.vouchersRedeemed;
    byPrize.set(p.prizeId, prev);
  }
  return {
    rewards: [...byPrize.values()]
      .sort((a, b) => b.won - a.won)
      .map((p) => ({
        prizeId: p.prizeId,
        campaignId: "",
        displayName: p.displayName,
        active: true,
        won: p.won,
        redeemed: p.redeemed,
        outstanding: Math.max(0, p.issued - p.redeemed),
      })),
    capacity: null,
    lastRolledUpAt: report.lastRolledUpAt,
  };
}
