import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "http";
import { pool } from "./db";
import {
  insertVisitorSurveyResponseSchema,
} from "@shared/schema";
import {
  createVisitorSurveyResponse,
  getVisitorSurveyDailySummary,
  isVisitorSurveyBranch,
  listVisitorSurveyBranches,
} from "./storage/visitorSurvey";
import { insertCampaignSchema, insertStaffBirthdaySchema, staffBirthdayBranches, type StaffBirthdayBranch } from "@shared/schema";
import {
  listBirthdays,
  createBirthday,
  updateBirthday,
  deleteBirthday,
} from "./storage/staffBirthdays";
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  getCampaignDashboardStats,
  getCampaignTimeSeries,
  type CampaignGranularity,
  getOrIssueQrForDevice,
  listCampaignsWithStats,
  lookupQrByToken,
  lookupQrByShortCode,
  markQrSaved,
  recordCampaignClick,
  redeemQrByToken,
  updateCampaign,
} from "./storage/campaigns";
import { registerSpinRewardRoutes } from "./spinRewardsRoutes";
import {
  PlatformReadError,
  RADAR_BRANCH_KEYS,
  SUMMARY_MAX_DAYS,
  addDays,
  bangkokToday,
  branchToday,
  calendarDaysOf,
  dailySummariesOf,
  dashboardRangeOf,
  isRadarBranchKey,
  platformBranches,
  readBoothReport,
  readSummary,
  spinReportOf,
  type RadarBranchKey,
} from "./sources/otoPos";
import {
  boothEventInputSchema,
  spinEventSchema,
  spinEventTypeMap,
  type BoothEventInput,
} from "@shared/schema";
import {
  ingestBoothEvents,
  listBoothClaims,
  relinkBoothClaim,
  resolveWinToClaim,
} from "./storage/boothEvents";
import { z } from "zod";
import { randomBytes, timingSafeEqual } from "crypto";
import OpenAI from "openai";
import {
  MARKETING_API_KEY_ENV,
  MARKETING_RATE_LIMIT,
  MARKETING_FIGURES_UNAVAILABLE,
  bearerTokenFromRequest,
  consumeMarketingRateLimit,
  marketingApiKeyIsValid,
  validateMarketingDateRange,
} from "./marketingSummary";

/**
 * The trends assistant's client. Both names are read here and nowhere else:
 * AI_INTEGRATIONS_OPENAI_API_KEY (required; unset means the assistant answers
 * 503) and AI_INTEGRATIONS_OPENAI_BASE_URL (optional; unset uses the
 * provider's default endpoint instead of the old Replit proxy).
 */
function createAssistantClient(): OpenAI | null {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.set('etag', false);

  // ============================================
  // FIGURES — the OTO POS rollup, through the platform (sources/otoPos.ts)
  // ============================================
  //
  // One source for every park (S2-18, owner 2026-10-14): the platform's
  // GET /analytics/summary, read with the signed-in person's own session, so
  // the platform decides what they may see. `branch` is Radar's park key
  // (floresta | chalong), matched to a platform branch by name.

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;

  function figuresError(res: Response, err: unknown, next: NextFunction) {
    if (err instanceof PlatformReadError) {
      return res.status(err.status).json({ message: err.message });
    }
    return next(err);
  }

  function branchParam(req: Request, res: Response): RadarBranchKey | null {
    const branch = req.query.branch;
    if (!isRadarBranchKey(branch)) {
      res.status(400).json({ message: `branch must be one of ${RADAR_BRANCH_KEYS.join(", ")}` });
      return null;
    }
    return branch;
  }

  function rangeParams(req: Request, res: Response): { from: string; to: string } | null {
    const from = String(req.query.start ?? req.query.from ?? "");
    const to = String(req.query.end ?? req.query.to ?? "");
    if (!isoDate.test(from) || !isoDate.test(to) || from > to) {
      res.status(400).json({ message: "start and end are required as YYYY-MM-DD, start not after end" });
      return null;
    }
    return { from, to };
  }

  /** The parks the person may read, as Radar keys. */
  async function readableKeys(token: string): Promise<RadarBranchKey[]> {
    return [...(await platformBranches(token)).keys()];
  }

  /** The last two years of days, per day, for the trends assistant and the chart builder. */
  async function recentDailySummaries(token: string, keys: RadarBranchKey[]) {
    if (keys.length === 0) return [];
    const to = bangkokToday();
    const from = addDays(to, -(2 * SUMMARY_MAX_DAYS - 1));
    return dailySummariesOf(await readSummary(token, keys, from, to, "day"));
  }

  // Which platform branch each park key means for this person.
  app.get("/api/figures/branches", async (req, res, next) => {
    try {
      const map = await platformBranches(req.radar!.token);
      res.json({ branches: [...map].map(([key, b]) => ({ key, branchId: b.branchId, name: b.name })) });
    } catch (err) {
      figuresError(res, err, next);
    }
  });

  // One park's business day in progress.
  app.get("/api/figures/today", async (req, res, next) => {
    try {
      const branch = branchParam(req, res);
      if (!branch) return;
      const token = req.radar!.token;
      const today = await branchToday(token, branch);
      res.json(dashboardRangeOf(await readSummary(token, [branch], today, today, "day")));
    } catch (err) {
      figuresError(res, err, next);
    }
  });

  // One park's range: totals, the per-day series and, for one day, the hours.
  app.get("/api/figures/range", async (req, res, next) => {
    try {
      const branch = branchParam(req, res);
      const range = branch && rangeParams(req, res);
      if (!branch || !range) return;
      res.json(dashboardRangeOf(await readSummary(req.radar!.token, [branch], range.from, range.to, "day")));
    } catch (err) {
      figuresError(res, err, next);
    }
  });

  // The calendar heatmap: revenue and orders per day.
  app.get("/api/figures/calendar", async (req, res, next) => {
    try {
      const branch = branchParam(req, res);
      const range = branch && rangeParams(req, res);
      if (!branch || !range) return;
      const summary = await readSummary(req.radar!.token, [branch], range.from, range.to, "day");
      res.json({ dailyRevenue: calendarDaysOf(summary), cashReportsDailyTotals: [] });
    } catch (err) {
      figuresError(res, err, next);
    }
  });

  // How fresh the figures are: when the rollup last brought each park up to date.
  app.get("/api/figures/freshness", async (req, res, next) => {
    try {
      const token = req.radar!.token;
      const asked = String(req.query.branches ?? "").split(",").filter(isRadarBranchKey);
      const keys = asked.length > 0 ? asked : await readableKeys(token);
      const parks = await Promise.all(
        keys.map(async (key) => {
          const today = bangkokToday();
          const s = await readSummary(token, [key], today, today, "total");
          const b = s.branches[0];
          return { key, name: b?.name ?? key, source: b?.source ?? null, lastRolledUpAt: b?.lastRolledUpAt ?? null };
        }),
      );
      const times = parks.map((p) => p.lastRolledUpAt);
      const oldest = times.some((t) => t === null) ? null : times.sort()[0] ?? null;
      res.json({ branches: parks, lastRolledUpAt: oldest });
    } catch (err) {
      figuresError(res, err, next);
    }
  });

  // The Spin Wheel report: the platform booth figures (GET /analytics/booths),
  // last twelve months, every park the person may read.
  app.get("/api/spin-wheel/report", async (req, res, next) => {
    try {
      const token = req.radar!.token;
      const keys = await readableKeys(token);
      if (keys.length === 0) return res.json({ rewards: [], capacity: null, lastRolledUpAt: null });
      const to = bangkokToday();
      const report = await readBoothReport(token, keys, addDays(to, -364), to);
      res.json(spinReportOf(report));
    } catch (err) {
      figuresError(res, err, next);
    }
  });

  // task-160: Revenue Planner — per-month, per-branch manually-set revenue
  // target, stored in Radar's branch_settings key/value table
  // (key = "planner_target_YYYY-MM").
  app.get("/api/planner/target", async (req, res, next) => {
    try {
      const { getBranchSetting } = await import("./storage/radarSettings");
      const branch = (req.query.branch as string) || "floresta";
      const month = String(req.query.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const stored = await getBranchSetting<{ target?: number }>(branch, `planner_target_${month}`);
      const target = stored && typeof stored.target === "number" && stored.target > 0 ? stored.target : null;
      res.json({ branch, month, target });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/planner/target", async (req, res, next) => {
    try {
      const { setBranchSetting } = await import("./storage/radarSettings");
      const branch = (req.body?.branch as string) || "floresta";
      const month = String(req.body?.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const raw = req.body?.target;
      let target: number | null = null;
      if (raw !== null && raw !== undefined && raw !== "") {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0 || n > 1e10) {
          return res.status(400).json({ message: "target must be a positive number or null" });
        }
        target = Math.round(n);
      }
      await setBranchSetting(branch, `planner_target_${month}`, { target });
      res.json({ success: true, branch, month, target });
    } catch (err) {
      next(err);
    }
  });

  // task-166: Revenue Planner — saved scenario (lever values) per month +
  // branch, stored in branch_settings (key = "planner_plan_YYYY-MM").
  // Same purely-additive pattern as planner_target above.
  app.get("/api/planner/plan", async (req, res, next) => {
    try {
      const { getBranchSetting } = await import("./storage/radarSettings");
      const branch = (req.query.branch as string) || "floresta";
      const month = String(req.query.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const stored = await getBranchSetting<{
        values?: Record<string, number>;
        projectedRevenue?: number;
        target?: number;
        savedAt?: string;
      }>(branch, `planner_plan_${month}`);
      if (!stored || !stored.values || typeof stored.values !== "object") {
        return res.json({ branch, month, plan: null });
      }
      res.json({ branch, month, plan: stored });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/planner/plan", async (req, res, next) => {
    try {
      const { setBranchSetting } = await import("./storage/radarSettings");
      const branch = (req.body?.branch as string) || "floresta";
      const month = String(req.body?.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const rawValues = req.body?.values;
      if (rawValues === null) {
        // Clear the saved plan.
        await setBranchSetting(branch, `planner_plan_${month}`, { values: null });
        return res.json({ success: true, branch, month, plan: null });
      }
      if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
        return res.status(400).json({ message: "values must be an object of lever values or null" });
      }
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(rawValues)) {
        const n = Number(v);
        if (typeof k !== "string" || k.length > 64 || !Number.isFinite(n) || n < 0 || n > 1e10) {
          return res.status(400).json({ message: `invalid lever value for "${k}"` });
        }
        values[k] = n;
      }
      if (Object.keys(values).length === 0 || Object.keys(values).length > 20) {
        return res.status(400).json({ message: "values must contain 1-20 levers" });
      }
      const projRaw = Number(req.body?.projectedRevenue);
      const targetRaw = Number(req.body?.target);
      const plan = {
        values,
        projectedRevenue: Number.isFinite(projRaw) && projRaw > 0 ? Math.round(projRaw) : undefined,
        target: Number.isFinite(targetRaw) && targetRaw > 0 ? Math.round(targetRaw) : undefined,
        savedAt: new Date().toISOString(),
      };
      await setBranchSetting(branch, `planner_plan_${month}`, plan);
      res.json({ success: true, branch, month, plan });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/calendar-notes", async (req, res, next) => {
    try {
      const { getCalendarNotes } = await import("./storage/radarSettings");
      const start = req.query.start as string;
      const end = req.query.end as string;
      if (!start || !end) return res.status(400).json({ error: "start and end required" });
      const notes = await getCalendarNotes(start, end);
      res.json(notes);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/calendar-notes", async (req, res, next) => {
    try {
      const { saveCalendarNote } = await import("./storage/radarSettings");
      const { date, note } = req.body;
      if (!date) return res.status(400).json({ error: "date required" });
      await saveCalendarNote(date, note || "");
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Pace forecast snapshots (forecast accuracy tracking) -----------------
  // The table is pace_forecast_snapshots (migration 0002_radar_settings.sql).

  app.post("/api/pace-snapshots", async (req, res, next) => {
    try {
      const { date, branch, forecastRevenue, revenueToDate, elapsedDays, target, model } = req.body || {};
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "valid date (YYYY-MM-DD) required" });
      }
      if (typeof branch !== "string" || !branch) {
        return res.status(400).json({ error: "branch required" });
      }
      const fv = Number(forecastRevenue);
      if (!Number.isFinite(fv) || fv < 0) {
        return res.status(400).json({ error: "valid forecastRevenue required" });
      }
      const { pool: localPool } = await import("./db");
      await localPool.query(
        `INSERT INTO pace_forecast_snapshots (date, branch, month, forecast_revenue, revenue_to_date, elapsed_days, target, model, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (date, branch) DO UPDATE SET
           forecast_revenue = EXCLUDED.forecast_revenue,
           revenue_to_date = EXCLUDED.revenue_to_date,
           elapsed_days = EXCLUDED.elapsed_days,
           target = EXCLUDED.target,
           model = EXCLUDED.model,
           recorded_at = NOW()`,
        [
          date,
          branch,
          date.slice(0, 7),
          fv,
          Number.isFinite(Number(revenueToDate)) ? Number(revenueToDate) : 0,
          Number.isFinite(Number(elapsedDays)) ? Math.round(Number(elapsedDays)) : 0,
          Number.isFinite(Number(target)) ? Number(target) : null,
          typeof model === "string" ? model : null,
        ],
      );
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/pace-snapshots/:branch/:month", async (req, res, next) => {
    try {
      const { branch, month } = req.params;
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "valid month (YYYY-MM) required" });
      }
      const { pool: localPool } = await import("./db");
      const result = await localPool.query(
        `SELECT date, forecast_revenue, revenue_to_date, elapsed_days, target, model, recorded_at
         FROM pace_forecast_snapshots
         WHERE branch = $1 AND month = $2
         ORDER BY date ASC`,
        [branch, month],
      );
      res.json(
        result.rows.map((r: any) => ({
          date: r.date,
          forecastRevenue: Number(r.forecast_revenue),
          revenueToDate: Number(r.revenue_to_date),
          elapsedDays: Number(r.elapsed_days),
          target: r.target !== null ? Number(r.target) : null,
          model: r.model,
          recordedAt: r.recorded_at,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/trends", async (req, res, next) => {
    try {
      const openai = createAssistantClient();
      if (!openai) {
        return res.status(503).json({ message: "The AI assistant is not configured (AI_INTEGRATIONS_OPENAI_API_KEY)." });
      }

      const { question, history } = req.body;
      if (!question) return res.status(400).json({ error: "question required" });

      // Every park the person may read, from the platform rollup.
      const allSummaries = await recentDailySummaries(req.radar!.token, await readableKeys(req.radar!.token));

      const dailyData = allSummaries.map((r: any) => {
        const s = r.summary;
        return {
          date: r.date,
          dayOfWeek: new Date(r.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" }),
          revenue: s.totalRevenue || 0,
          orders: s.totalOrders || 0,
          vouchers: s.paymentBreakdown?.Voucher || 0,
          netRevenue: (s.totalRevenue || 0) - (s.paymentBreakdown?.Voucher || 0),
          kids: s.guestBreakdown?.kidTickets || 0,
          adults: s.guestBreakdown?.adultTickets || 0,
          totalGuests: (s.guestBreakdown?.kidTickets || 0) + (s.guestBreakdown?.adultTickets || 0),
          kidRevenue: s.guestBreakdown?.kidRevenue || 0,
          adultRevenue: s.guestBreakdown?.adultRevenue || 0,
          cat_tickets: 0 as number,
          cat_fnb: 0 as number,
          cat_events_birthdays: 0 as number,
          cat_nanny: 0 as number,
          cat_extras: 0 as number,
          cat_merchandise: 0 as number,
          ...Object.entries(s.categoryBreakdown || {}).reduce((acc: any, [k, v]: [string, any]) => {
            const rev = v.revenue || 0;
            if (k.toLowerCase().includes("ticket") || k.toLowerCase().includes("package")) acc.cat_tickets = (acc.cat_tickets || 0) + rev;
            else if (k.toLowerCase().includes("f&b") || k.toLowerCase().includes("food")) acc.cat_fnb = (acc.cat_fnb || 0) + rev;
            else if (k.toLowerCase().includes("event") || k.toLowerCase().includes("birthday")) acc.cat_events_birthdays = (acc.cat_events_birthdays || 0) + rev;
            else if (k.toLowerCase().includes("nanny") || k.toLowerCase().includes("drop")) acc.cat_nanny = (acc.cat_nanny || 0) + rev;
            else if (k.toLowerCase().includes("extra")) acc.cat_extras = (acc.cat_extras || 0) + rev;
            else if (k.toLowerCase().includes("merch")) acc.cat_merchandise = (acc.cat_merchandise || 0) + rev;
            return acc;
          }, {}),
          ct_tourist_kids: 0 as number, ct_tourist_adults: 0 as number,
          ct_thai_kids: 0 as number, ct_thai_adults: 0 as number,
          ct_expat_kids: 0 as number, ct_expat_adults: 0 as number,
          ct_eatplay_kids: 0 as number, ct_eatplay_adults: 0 as number,
          ...(s.customerTypeSplit || []).reduce((acc: any, ct: any) => {
            const t = (ct.type || "").toLowerCase();
            if (t.includes("tourist")) { acc.ct_tourist_kids = ct.kidTickets || 0; acc.ct_tourist_adults = ct.adultTickets || 0; }
            else if (t.includes("thai")) { acc.ct_thai_kids = ct.kidTickets || 0; acc.ct_thai_adults = ct.adultTickets || 0; }
            else if (t.includes("expat")) { acc.ct_expat_kids = ct.kidTickets || 0; acc.ct_expat_adults = ct.adultTickets || 0; }
            else if (t.includes("eat") || t.includes("play")) { acc.ct_eatplay_kids = ct.kidTickets || 0; acc.ct_eatplay_adults = ct.adultTickets || 0; }
            return acc;
          }, {}),
          discount: s.discountTotal || 0,
        };
      });

      const dateRange = dailyData.length > 0
        ? `${dailyData[0].date} to ${dailyData[dailyData.length - 1].date}`
        : "no data";

      const numericKeys = Object.keys(dailyData[0] || {}).filter(k => !["date", "dayOfWeek"].includes(k));
      const shortMonth = (m: number) => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m];

      function getISOMonday(dt: Date): Date {
        const d = new Date(dt);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        d.setDate(d.getDate() + diff);
        return d;
      }

      function aggregateByWeek(data: any[], fields: string[]) {
        const agg: Record<string, Record<string, number>> = {};
        for (const d of data) {
          const dt = new Date(d.date + "T12:00:00");
          const monday = getISOMonday(dt);
          const wk = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,"0")}-${String(monday.getDate()).padStart(2,"0")}`;
          if (!agg[wk]) agg[wk] = {};
          for (const f of fields) agg[wk][f] = (agg[wk][f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        return Object.entries(agg).sort(([a],[b]) => a.localeCompare(b)).map(([mondayStr, vals]) => {
          const mon = new Date(mondayStr + "T12:00:00");
          const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
          const label = mon.getMonth() === sun.getMonth()
            ? `${shortMonth(mon.getMonth())} ${mon.getDate()}–${sun.getDate()}`
            : `${shortMonth(mon.getMonth())} ${mon.getDate()}–${shortMonth(sun.getMonth())} ${sun.getDate()}`;
          return { label, ...vals };
        });
      }

      function aggregateByMonth(data: any[], fields: string[]) {
        const agg: Record<string, Record<string, number>> = {};
        for (const d of data) {
          const dt = new Date(d.date + "T12:00:00");
          const mo = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`;
          if (!agg[mo]) agg[mo] = {};
          for (const f of fields) agg[mo][f] = (agg[mo][f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        return Object.entries(agg).sort(([a],[b]) => a.localeCompare(b)).map(([mo, vals]) => {
          const [y,m] = mo.split("-");
          return { label: `${shortMonth(parseInt(m)-1)} ${y}`, ...vals };
        });
      }

      function aggregateByDow(data: any[], fields: string[], mode: "avg" | "sum" = "avg") {
        const agg: Record<string, { sum: Record<string, number>; count: number }> = {};
        for (const d of data) {
          const dow = d.dayOfWeek;
          if (!agg[dow]) agg[dow] = { sum: {}, count: 0 };
          agg[dow].count++;
          for (const f of fields) agg[dow].sum[f] = (agg[dow].sum[f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        return ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map(dow => {
          const entry = agg[dow];
          if (!entry) return { label: dow, ...Object.fromEntries(fields.map(f => [f, 0])) };
          const vals: any = { label: dow };
          for (const f of fields) vals[f] = mode === "avg" ? Math.round(entry.sum[f] / entry.count) : entry.sum[f];
          return vals;
        });
      }

      function totalPie(data: any[], fields: string[], names: Record<string, string>) {
        const sums: Record<string, number> = {};
        for (const d of data) {
          for (const f of fields) sums[f] = (sums[f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        return fields.map(f => ({ name: names[f] || f, value: Math.round(sums[f] || 0) }));
      }

      const METRIC_CATALOG = {
        revenue: { field: "revenue", name: "Gross Revenue", unit: "฿" },
        netRevenue: { field: "netRevenue", name: "Net Revenue", unit: "฿" },
        vouchers: { field: "vouchers", name: "Vouchers", unit: "฿" },
        orders: { field: "orders", name: "Orders", unit: "" },
        discount: { field: "discount", name: "Discounts", unit: "฿" },
        kids: { field: "kids", name: "Kids", unit: "" },
        adults: { field: "adults", name: "Adults", unit: "" },
        totalGuests: { field: "totalGuests", name: "Total Guests", unit: "" },
        kidRevenue: { field: "kidRevenue", name: "Kid Revenue", unit: "฿" },
        adultRevenue: { field: "adultRevenue", name: "Adult Revenue", unit: "฿" },
        cat_tickets: { field: "cat_tickets", name: "Tickets & Packages", unit: "฿" },
        cat_fnb: { field: "cat_fnb", name: "F&B", unit: "฿" },
        cat_events_birthdays: { field: "cat_events_birthdays", name: "Events / Birthdays", unit: "฿" },
        cat_nanny: { field: "cat_nanny", name: "Nanny & Drop-off", unit: "฿" },
        cat_extras: { field: "cat_extras", name: "Extras", unit: "฿" },
        cat_merchandise: { field: "cat_merchandise", name: "Merchandise", unit: "฿" },
        ct_tourist_kids: { field: "ct_tourist_kids", name: "Tourist Kids", unit: "" },
        ct_tourist_adults: { field: "ct_tourist_adults", name: "Tourist Adults", unit: "" },
        ct_thai_kids: { field: "ct_thai_kids", name: "Thai Kids", unit: "" },
        ct_thai_adults: { field: "ct_thai_adults", name: "Thai Adults", unit: "" },
        ct_expat_kids: { field: "ct_expat_kids", name: "Expat Kids", unit: "" },
        ct_expat_adults: { field: "ct_expat_adults", name: "Expat Adults", unit: "" },
        ct_eatplay_kids: { field: "ct_eatplay_kids", name: "Eat & Play Kids", unit: "" },
        ct_eatplay_adults: { field: "ct_eatplay_adults", name: "Eat & Play Adults", unit: "" },
      };

      const COLORS = ["#f97316","#10b981","#6366f1","#ec4899","#14b8a6","#f59e0b","#ef4444","#3b82f6"];

      const systemPrompt = `You are OTO Radar — the business intelligence assistant for OTO Play Park, an indoor kids' adventure playground in Phuket. The figures are the OTO POS's own daily rollup. Currency: Thai Baht (฿). Today is ${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date())}.
Available data: ${dailyData.length} days from ${dateRange}.
Available metrics: ${Object.keys(METRIC_CATALOG).join(", ")}.

RESPONSE FORMAT — VALID JSON ONLY:
MODE 1 — CLARIFICATION: { "mode": "clarify", "message": "Brief question", "options": ["A", "B", "C"] }
MODE 2 — CHART SPEC: { "mode": "chart", "title": "Title", "description": "Insight", "dataSummary": "summary", "chartType": "line"|"bar"|"area"|"stackedBar"|"pie", "groupBy": "weekly"|"monthly"|"dayOfWeek"|"daily", "aggregation": "sum"|"avg", "metrics": ["field1"], "dateFrom": null, "dateTo": null, "pieNames": {}, "followUp": "suggestion" }
RULES: Only use metrics from the catalog. For pie charts, add "pieNames". Be brief and actionable.`;

      const messages: any[] = [{ role: "system", content: systemPrompt }];
      if (history && Array.isArray(history)) {
        for (const h of history) messages.push({ role: h.role, content: h.content });
      }
      messages.push({ role: "user", content: `Question: ${question}` });

      const completion = await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        messages,
        temperature: 0.1,
        max_tokens: 1000,
      });

      const raw = completion.choices[0]?.message?.content || "{}";
      let spec;
      try {
        const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        spec = JSON.parse(cleaned);
      } catch {
        res.json({ mode: "clarify", message: "I had trouble understanding that. Could you rephrase your question?" });
        return;
      }

      if (spec.mode === "clarify") {
        res.json({
          mode: "clarify",
          message: spec.message || "Could you clarify what you'd like to see?",
          options: Array.isArray(spec.options) ? spec.options.slice(0, 4) : [],
        });
        return;
      }

      const metrics: string[] = (spec.metrics || []).filter((m: string) => m in METRIC_CATALOG);
      if (metrics.length === 0) metrics.push("netRevenue");

      let filteredData = dailyData;
      if (spec.dateFrom) filteredData = filteredData.filter((d: any) => d.date >= spec.dateFrom);
      if (spec.dateTo) filteredData = filteredData.filter((d: any) => d.date <= spec.dateTo);

      const groupBy = spec.groupBy || "weekly";
      const aggMode = spec.aggregation === "avg" ? "avg" : "sum";

      let chartData: any[];
      if (spec.chartType === "pie") {
        const names: Record<string, string> = spec.pieNames || {};
        for (const m of metrics) {
          if (!names[m]) names[m] = (METRIC_CATALOG as any)[m]?.name || m;
        }
        chartData = totalPie(filteredData, metrics, names);
      } else if (groupBy === "dayOfWeek") {
        chartData = aggregateByDow(filteredData, metrics, aggMode as "avg" | "sum");
      } else if (groupBy === "monthly") {
        chartData = aggregateByMonth(filteredData, metrics);
      } else if (groupBy === "daily") {
        chartData = filteredData.map((d: any) => {
          const point: any = { label: d.date };
          for (const m of metrics) point[m] = typeof d[m] === "number" ? d[m] : 0;
          return point;
        });
      } else {
        chartData = aggregateByWeek(filteredData, metrics);
      }

      const series = spec.chartType === "pie" ? [] : metrics.map((m: string, i: number) => ({
        name: (METRIC_CATALOG as any)[m]?.name || m,
        dataKey: m,
        color: COLORS[i % COLORS.length],
      }));

      const metricDescriptions = metrics.map((m: string) => {
        const cat = (METRIC_CATALOG as any)[m];
        return cat ? `${cat.name} (${m})` : m;
      }).join(", ");
      const groupLabel = groupBy === "dayOfWeek" ? "day of week" : groupBy;
      const filteredRange = filteredData.length > 0
        ? `${filteredData[0].date} to ${filteredData[filteredData.length - 1].date}`
        : dateRange;
      const dataSummary = spec.dataSummary || `Data: ${metricDescriptions} · Grouped by ${groupLabel} (${aggMode}) · ${filteredData.length} days from ${filteredRange}`;

      res.json({
        mode: "chart",
        title: spec.title || "Chart",
        description: spec.description || "",
        dataSummary,
        chartType: spec.chartType || "line",
        xAxisLabel: spec.xAxisLabel || "",
        yAxisLabel: spec.yAxisLabel || "",
        series,
        data: chartData,
      });
    } catch (err) {
      console.error("[Trends] Error:", err);
      next(err);
    }
  });

  app.post("/api/trends-parse", async (req, res, next) => {
    try {
      const openai = createAssistantClient();
      if (!openai) {
        return res.status(503).json({ message: "The AI assistant is not configured (AI_INTEGRATIONS_OPENAI_API_KEY)." });
      }

      const { message, today, previousChart } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });

      const todayStr = today || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());

      const systemPrompt = `You are OTO Radar — the chart assistant for OTO Play Park. Today is ${todayStr}. Data starts from 2026-01-01.
You translate natural language questions into chart specifications. Return VALID JSON only:
{
  "metrics": ["netRevenue"],
  "groupBy": "daily" | "weekly" | "monthly" | "dayOfWeek",
  "chartType": "line" | "bar" | "area" | "stackedBar" | "pie",
  "dateFrom": "YYYY-MM-DD" | null,
  "dateTo": "YYYY-MM-DD" | null,
  "aggregation": "sum" | "avg",
  "reply": "Brief confirmation (under 20 words)"
}
Available metrics: revenue, netRevenue, vouchers, orders, avgOrderValue, discount, discountRate, pureTicketRevenue, voucherSwing, pay_cash, pay_card, pay_qr, cat_tickets, cat_fnb, cat_fnb_food, cat_fnb_drinks, cat_events_birthdays, cat_nanny, cat_extras, cat_merchandise, kids, adults, totalGuests, kidRevenue, adultRevenue, avgStayHours, ct_tourist_kids, ct_tourist_adults, ct_tourist_revenue, ct_thai_kids, ct_thai_adults, ct_thai_revenue, ct_expat_kids, ct_expat_adults, ct_expat_revenue, ct_eatplay_kids, ct_eatplay_adults, ct_eatplay_revenue, forecast_revenue, forecast_tickets, forecast_fnb, forecast_events, forecast_extras, forecast_kids, forecast_adults, forecast_guests.
"revenue"/"sales" → netRevenue. Only use exact metric keys.`;

      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
      ];

      if (previousChart) {
        messages.push({ role: "assistant", content: JSON.stringify(previousChart) });
      }

      messages.push({ role: "user", content: message });

      const completion = await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        messages,
        temperature: 0.1,
        max_tokens: 250,
      });

      const raw = completion.choices[0]?.message?.content || "{}";
      try {
        const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(cleaned);
        res.json(parsed);
      } catch {
        res.json({
          metrics: ["netRevenue"],
          groupBy: "weekly",
          chartType: "bar",
          dateFrom: null,
          dateTo: null,
          aggregation: "sum",
          reply: "Here's your weekly net revenue overview.",
        });
      }
    } catch (err) {
      console.error("[Trends Parse] Error:", err);
      next(err);
    }
  });

  app.post("/api/chart-builder", async (req, res, next) => {
    try {
      const { metrics, groupBy, chartType, dateFrom, dateTo, aggregation, branches } = req.body;

      if (!metrics || !Array.isArray(metrics) || metrics.length === 0) {
        return res.status(400).json({ error: "metrics array required" });
      }

      const branchSet = new Set(branches || ["floresta"]);
      let allSummaries: Array<{ date: string; summary: any }> = [];
      if (branchSet.has("floresta")) {
        const fSummaries = await recentDailySummaries(req.radar!.token, ["floresta"]);
        allSummaries.push(...(fSummaries || []));
      }
      if (branchSet.has("chalong")) {
        const pSummaries = await recentDailySummaries(req.radar!.token, ["chalong"]);
        allSummaries.push(...(pSummaries || []));
      }
      if (branchSet.size === 2) {
        const dateMap = new Map<string, any>();
        for (const s of allSummaries) {
          if (dateMap.has(s.date)) {
            const existing = dateMap.get(s.date).summary;
            const incoming = s.summary;
            existing.totalRevenue = (existing.totalRevenue || 0) + (incoming.totalRevenue || 0);
            existing.totalOrders = (existing.totalOrders || 0) + (incoming.totalOrders || 0);
            existing.discountTotal = (existing.discountTotal || 0) + (incoming.discountTotal || 0);
            existing.pureTicketRevenue = (existing.pureTicketRevenue || 0) + (incoming.pureTicketRevenue || 0);
            const eGb = existing.guestBreakdown || {};
            const iGb = incoming.guestBreakdown || {};
            existing.guestBreakdown = {
              ...eGb,
              kidTickets: (eGb.kidTickets || 0) + (iGb.kidTickets || 0),
              adultTickets: (eGb.adultTickets || 0) + (iGb.adultTickets || 0),
              kidRevenue: (eGb.kidRevenue || 0) + (iGb.kidRevenue || 0),
              adultRevenue: (eGb.adultRevenue || 0) + (iGb.adultRevenue || 0),
            };
            const ePb = existing.paymentBreakdown || {};
            const iPb = incoming.paymentBreakdown || {};
            for (const [k, v] of Object.entries(iPb)) {
              ePb[k] = (ePb[k] || 0) + (v as number);
            }
            existing.paymentBreakdown = ePb;
            const eCb = existing.categoryBreakdown || {};
            const iCb = incoming.categoryBreakdown || {};
            for (const [k, v] of Object.entries(iCb)) {
              const ev = eCb[k] || { revenue: 0, quantity: 0 };
              ev.revenue = (ev.revenue || 0) + ((v as any).revenue || 0);
              ev.quantity = (ev.quantity || 0) + ((v as any).quantity || 0);
              eCb[k] = ev;
            }
            existing.categoryBreakdown = eCb;
          } else {
            dateMap.set(s.date, { date: s.date, summary: { ...s.summary } });
          }
        }
        allSummaries = Array.from(dateMap.values());
      }
      if (!allSummaries || allSummaries.length === 0) {
        return res.json({ data: [], series: [] });
      }

      const dailyData = allSummaries.map((r: any) => {
        const s = r.summary;
        const gb = s.guestBreakdown || {};
        const pb = s.paymentBreakdown || {};
        const kidTickets = gb.kidTickets || 0;
        const adultTickets = gb.adultTickets || 0;
        const totalRev = s.totalRevenue || 0;
        const totalOrd = s.totalOrders || 0;
        const voucherAmt = pb.Voucher || pb.voucher || 0;
        const flat: any = {
          date: r.date,
          dayOfWeek: new Date(r.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" }),
          revenue: totalRev,
          orders: totalOrd,
          vouchers: voucherAmt,
          netRevenue: totalRev - voucherAmt,
          avgOrderValue: totalOrd > 0 ? Math.round(totalRev / totalOrd) : 0,
          discount: s.discountTotal || 0,
          discountRate: totalOrd > 0 ? Math.round((s.discountTotal || 0) / totalRev * 100 * 10) / 10 : 0,
          kids: kidTickets,
          adults: adultTickets,
          totalGuests: kidTickets + adultTickets,
          kidRevenue: gb.kidRevenue || 0,
          adultRevenue: gb.adultRevenue || 0,
          avgStayHours: gb.avgStayHours || 0,
          pureTicketRevenue: s.pureTicketRevenue || 0,
          voucherSwing: s.voucherSwingAmount || 0,
          pay_cash: pb.Cash || pb.cash || 0,
          pay_card: pb["Credit Card"] || pb["credit card"] || 0,
          pay_qr: pb["PromptPay/QR"] || pb["promptpay/qr"] || pb.PromptPay || 0,
          cat_tickets: 0, cat_fnb: 0, cat_fnb_food: 0, cat_fnb_drinks: 0,
          cat_events_birthdays: 0, cat_nanny: 0, cat_extras: 0, cat_merchandise: 0,
          ct_tourist_kids: 0, ct_tourist_adults: 0, ct_tourist_revenue: 0,
          ct_thai_kids: 0, ct_thai_adults: 0, ct_thai_revenue: 0,
          ct_expat_kids: 0, ct_expat_adults: 0, ct_expat_revenue: 0,
          ct_eatplay_kids: 0, ct_eatplay_adults: 0, ct_eatplay_revenue: 0,
        };
        for (const [k, v] of Object.entries(s.categoryBreakdown || {})) {
          const entry = v as any;
          const rev = entry.revenue || 0;
          const kl = k.toLowerCase();
          if (kl.includes("ticket") || kl.includes("package")) flat.cat_tickets += rev;
          else if (kl.includes("f&b") || kl.includes("food")) {
            flat.cat_fnb += rev;
            if (entry.subCategories) {
              for (const [sk, sv] of Object.entries(entry.subCategories || {})) {
                const skl = sk.toLowerCase();
                const subRev = (sv as any).revenue || (typeof sv === "number" ? sv : 0);
                if (skl.includes("food") || skl.includes("meal") || skl.includes("main")) flat.cat_fnb_food += subRev;
                else if (skl.includes("drink") || skl.includes("beverage") || skl.includes("coffee") || skl.includes("juice")) flat.cat_fnb_drinks += subRev;
              }
            }
          }
          else if (kl.includes("event") || kl.includes("birthday")) flat.cat_events_birthdays += rev;
          else if (kl.includes("nanny") || kl.includes("drop")) flat.cat_nanny += rev;
          else if (kl.includes("extra")) flat.cat_extras += rev;
          else if (kl.includes("merch")) flat.cat_merchandise += rev;
        }
        if (flat.cat_fnb > 0 && flat.cat_fnb_food === 0 && flat.cat_fnb_drinks === 0) {
          flat.cat_fnb_food = flat.cat_fnb;
        }
        for (const ct of (s.customerTypeSplit || [])) {
          const t = (ct.type || "").toLowerCase();
          if (t.includes("tourist")) { flat.ct_tourist_kids = ct.kidTickets || 0; flat.ct_tourist_adults = ct.adultTickets || 0; flat.ct_tourist_revenue = ct.revenue || 0; }
          else if (t.includes("thai")) { flat.ct_thai_kids = ct.kidTickets || 0; flat.ct_thai_adults = ct.adultTickets || 0; flat.ct_thai_revenue = ct.revenue || 0; }
          else if (t.includes("expat")) { flat.ct_expat_kids = ct.kidTickets || 0; flat.ct_expat_adults = ct.adultTickets || 0; flat.ct_expat_revenue = ct.revenue || 0; }
          else if (t.includes("eat") || t.includes("play")) { flat.ct_eatplay_kids = ct.kidTickets || 0; flat.ct_eatplay_adults = ct.adultTickets || 0; flat.ct_eatplay_revenue = ct.revenue || 0; }
        }
        return flat;
      });

      const FC_CENTRAL = {
        seasonality: { 0: 1.0, 1: 1.0, 2: 1.0, 3: 0.95, 4: 0.70, 5: 0.65, 6: 0.75, 7: 0.75, 8: 0.65, 9: 0.80, 10: 0.90, 11: 1.0 } as Record<number, number>,
        base: 4929457,
        catShares: { tickets: 0.7107, events: 0.0584, fnb: 0.1154, extras: 0.1154 },
        weekday: { kids: 100, adults: 67.5, kidRev: 54850, adultRev: 23625 },
        weekend: { kids: 210, adults: 141.75, kidRev: 127680, adultRev: 94500 },
      };
      const FC_CHALONG = {
        seasonality: { 0: 1.10, 1: 1.15, 2: 0.85, 3: 0.80, 4: 0.65, 5: 0.60, 6: 0.70, 7: 0.70, 8: 0.60, 9: 0.75, 10: 0.90, 11: 1.10 } as Record<number, number>,
        base: 900000,
        catShares: { tickets: 0.60, extras: 0.22, merchandise: 0.08, other: 0.10, events: 0, fnb: 0 },
        weekday: { kids: 20, adults: 15, kidRev: 12000, adultRev: 6500 },
        weekend: { kids: 45, adults: 30, kidRev: 27000, adultRev: 14000 },
      };
      const fcBranchSet = new Set(branches || ["floresta"]);
      const hasFloresta = fcBranchSet.has("floresta");
      const hasChalong = fcBranchSet.has("chalong");
      const fc = (() => {
        if (hasFloresta && hasChalong) {
          const total = FC_CENTRAL.base + FC_CHALONG.base;
          return {
            seasonality: Object.fromEntries(Object.entries(FC_CENTRAL.seasonality).map(([k, v]) => [k, (v * FC_CENTRAL.base + (FC_CHALONG.seasonality[Number(k)] || 1) * FC_CHALONG.base) / total])) as Record<number, number>,
            base: total,
            catShares: {
              tickets: (FC_CENTRAL.catShares.tickets * FC_CENTRAL.base + FC_CHALONG.catShares.tickets * FC_CHALONG.base) / total,
              events: (FC_CENTRAL.catShares.events * FC_CENTRAL.base) / total,
              fnb: (FC_CENTRAL.catShares.fnb * FC_CENTRAL.base) / total,
              extras: (FC_CENTRAL.catShares.extras * FC_CENTRAL.base + FC_CHALONG.catShares.extras * FC_CHALONG.base) / total,
            },
            weekday: { kids: FC_CENTRAL.weekday.kids + FC_CHALONG.weekday.kids, adults: FC_CENTRAL.weekday.adults + FC_CHALONG.weekday.adults, kidRev: FC_CENTRAL.weekday.kidRev + FC_CHALONG.weekday.kidRev, adultRev: FC_CENTRAL.weekday.adultRev + FC_CHALONG.weekday.adultRev },
            weekend: { kids: FC_CENTRAL.weekend.kids + FC_CHALONG.weekend.kids, adults: FC_CENTRAL.weekend.adults + FC_CHALONG.weekend.adults, kidRev: FC_CENTRAL.weekend.kidRev + FC_CHALONG.weekend.kidRev, adultRev: FC_CENTRAL.weekend.adultRev + FC_CHALONG.weekend.adultRev },
          };
        }
        if (hasChalong) return FC_CHALONG;
        return FC_CENTRAL;
      })();
      const FORECAST_SEASONALITY = fc.seasonality;
      const FORECAST_BASE_MONTHLY = fc.base;
      const FORECAST_CAT_SHARES = fc.catShares;
      const FORECAST_WEEKDAY = fc.weekday;
      const FORECAST_WEEKEND = fc.weekend;
      const weekdayDailyRev = FORECAST_WEEKDAY.kidRev + FORECAST_WEEKDAY.adultRev;
      const weekendDailyRev = FORECAST_WEEKEND.kidRev + FORECAST_WEEKEND.adultRev;

      for (const d of dailyData) {
        const dt = new Date(d.date + "T12:00:00");
        const month = dt.getMonth();
        const dow = dt.getDay();
        const isWE = dow === 0 || dow === 6;
        const seas = FORECAST_SEASONALITY[month] || 1;
        const dim = new Date(dt.getFullYear(), month + 1, 0).getDate();
        let monthWeekdays = 0, monthWeekends = 0;
        for (let i = 1; i <= dim; i++) {
          const wd = new Date(dt.getFullYear(), month, i).getDay();
          if (wd === 0 || wd === 6) monthWeekends++;
          else monthWeekdays++;
        }
        const monthTotalWeight = (monthWeekdays * weekdayDailyRev) + (monthWeekends * weekendDailyRev);
        const dayWeight = isWE ? weekendDailyRev : weekdayDailyRev;
        const dailyRev = (FORECAST_BASE_MONTHLY * seas * dayWeight) / monthTotalWeight;

        d.forecast_revenue = dailyRev;
        d.forecast_tickets = dailyRev * FORECAST_CAT_SHARES.tickets;
        d.forecast_fnb = dailyRev * FORECAST_CAT_SHARES.fnb;
        d.forecast_events = dailyRev * FORECAST_CAT_SHARES.events;
        d.forecast_extras = dailyRev * FORECAST_CAT_SHARES.extras;

        const profile = isWE ? FORECAST_WEEKEND : FORECAST_WEEKDAY;
        d.forecast_kids = Math.round(profile.kids * seas);
        d.forecast_adults = Math.round(profile.adults * seas);
        d.forecast_guests = d.forecast_kids + d.forecast_adults;
      }

      let filteredData = dailyData;
      if (dateFrom) filteredData = filteredData.filter((d: any) => d.date >= dateFrom);
      if (dateTo) filteredData = filteredData.filter((d: any) => d.date <= dateTo);

      const shortMonth = (m: number) => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m];

      function getISOMonday(dt: Date): Date {
        const d = new Date(dt);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        d.setDate(d.getDate() + diff);
        return d;
      }

      const aggMode = aggregation === "avg" ? "avg" : "sum";
      let chartData: any[];

      if (chartType === "pie") {
        const sums: Record<string, number> = {};
        for (const d of filteredData) {
          for (const f of metrics) sums[f] = (sums[f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        chartData = metrics.map((f: string) => ({ name: f, value: Math.round(sums[f] || 0) }));
      } else if (groupBy === "dayOfWeek") {
        const agg: Record<string, { sum: Record<string, number>; count: number }> = {};
        for (const d of filteredData) {
          const dow = d.dayOfWeek;
          if (!agg[dow]) agg[dow] = { sum: {}, count: 0 };
          agg[dow].count++;
          for (const f of metrics) agg[dow].sum[f] = (agg[dow].sum[f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        chartData = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map(dow => {
          const entry = agg[dow];
          if (!entry) return { label: dow, ...Object.fromEntries(metrics.map((f: string) => [f, 0])) };
          const vals: any = { label: dow };
          for (const f of metrics) vals[f] = aggMode === "avg" ? Math.round(entry.sum[f] / entry.count) : entry.sum[f];
          return vals;
        });
      } else if (groupBy === "monthly") {
        const agg: Record<string, Record<string, number>> = {};
        for (const d of filteredData) {
          const dt = new Date(d.date + "T12:00:00");
          const mo = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`;
          if (!agg[mo]) agg[mo] = {};
          for (const f of metrics) agg[mo][f] = (agg[mo][f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        chartData = Object.entries(agg).sort(([a],[b]) => a.localeCompare(b)).map(([mo, vals]) => {
          const [y,m] = mo.split("-");
          return { label: `${shortMonth(parseInt(m)-1)} ${y}`, ...vals };
        });
      } else if (groupBy === "daily") {
        chartData = filteredData.map((d: any) => {
          const point: any = { label: d.date };
          for (const m of metrics) point[m] = typeof d[m] === "number" ? d[m] : 0;
          return point;
        });
      } else {
        const agg: Record<string, Record<string, number>> = {};
        for (const d of filteredData) {
          const dt = new Date(d.date + "T12:00:00");
          const monday = getISOMonday(dt);
          const wk = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,"0")}-${String(monday.getDate()).padStart(2,"0")}`;
          if (!agg[wk]) agg[wk] = {};
          for (const f of metrics) agg[wk][f] = (agg[wk][f] || 0) + (typeof d[f] === "number" ? d[f] : 0);
        }
        chartData = Object.entries(agg).sort(([a],[b]) => a.localeCompare(b)).map(([mondayStr, vals]) => {
          const mon = new Date(mondayStr + "T12:00:00");
          const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
          const label = mon.getMonth() === sun.getMonth()
            ? `${shortMonth(mon.getMonth())} ${mon.getDate()}–${sun.getDate()}`
            : `${shortMonth(mon.getMonth())} ${mon.getDate()}–${shortMonth(sun.getMonth())} ${sun.getDate()}`;
          return { label, ...vals };
        });
      }

      const rawBreakdown: Record<string, Array<{ date: string; values: Record<string, number> }>> = {};
      if (groupBy === "weekly") {
        for (const d of filteredData) {
          const dt = new Date(d.date + "T12:00:00");
          const monday = getISOMonday(dt);
          const wk = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,"0")}-${String(monday.getDate()).padStart(2,"0")}`;
          const mon = new Date(wk + "T12:00:00");
          const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
          const label = mon.getMonth() === sun.getMonth()
            ? `${shortMonth(mon.getMonth())} ${mon.getDate()}–${sun.getDate()}`
            : `${shortMonth(mon.getMonth())} ${mon.getDate()}–${shortMonth(sun.getMonth())} ${sun.getDate()}`;
          if (!rawBreakdown[label]) rawBreakdown[label] = [];
          const vals: Record<string, number> = {};
          for (const f of metrics) vals[f] = typeof d[f] === "number" ? d[f] : 0;
          rawBreakdown[label].push({ date: d.date, values: vals });
        }
      } else if (groupBy === "monthly") {
        for (const d of filteredData) {
          const dt = new Date(d.date + "T12:00:00");
          const label = `${shortMonth(dt.getMonth())} ${dt.getFullYear()}`;
          if (!rawBreakdown[label]) rawBreakdown[label] = [];
          const vals: Record<string, number> = {};
          for (const f of metrics) vals[f] = typeof d[f] === "number" ? d[f] : 0;
          rawBreakdown[label].push({ date: d.date, values: vals });
        }
      } else if (groupBy === "dayOfWeek") {
        for (const d of filteredData) {
          const dow = d.dayOfWeek;
          if (!rawBreakdown[dow]) rawBreakdown[dow] = [];
          const vals: Record<string, number> = {};
          for (const f of metrics) vals[f] = typeof d[f] === "number" ? d[f] : 0;
          rawBreakdown[dow].push({ date: d.date, values: vals });
        }
      }

      const COLORS = ["#f97316","#10b981","#6366f1","#ec4899","#14b8a6","#f59e0b","#ef4444","#3b82f6"];
      const series = chartType === "pie" ? [] : metrics.map((m: string, i: number) => ({
        name: m,
        dataKey: m,
        color: COLORS[i % COLORS.length],
      }));

      res.json({ data: chartData, series, chartType: chartType || "line", rawBreakdown: Object.keys(rawBreakdown).length > 0 ? rawBreakdown : undefined });
    } catch (err) {
      console.error("[Chart Builder] Error:", err);
      next(err);
    }
  });

  // ============================================
  // VISITOR SURVEY (public)
  // ============================================

  app.get("/api/visitor-survey/branches", (_req, res) => {
    res.json(listVisitorSurveyBranches());
  });

  app.post("/api/visitor-survey", async (req, res, next) => {
    try {
      const parsed = insertVisitorSurveyResponseSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid survey submission",
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const row = await createVisitorSurveyResponse(parsed.data);
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/visitor-survey/summary", async (req, res, next) => {
    try {
      const date = typeof req.query.date === "string" ? req.query.date : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: "date query in YYYY-MM-DD required" });
      }
      const rawEnd = typeof req.query.end === "string" ? req.query.end : undefined;
      let endDate: string | undefined;
      if (rawEnd !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) {
          return res.status(400).json({ message: "end query must be YYYY-MM-DD" });
        }
        if (rawEnd < date) {
          return res.status(400).json({ message: "end must be on or after date" });
        }
        endDate = rawEnd;
      }
      const rawBranch = typeof req.query.branch === "string" ? req.query.branch : undefined;
      if (rawBranch !== undefined && !isVisitorSurveyBranch(rawBranch)) {
        return res.status(400).json({ message: "invalid branch" });
      }
      const summary = await getVisitorSurveyDailySummary(date, rawBranch, endDate);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  // ============================================
  // EXTERNAL MARKETING SUMMARY (read-only, Bearer auth)
  // ============================================

  app.get("/api/external/marketing-summary", async (req, res) => {
    if (!process.env[MARKETING_API_KEY_ENV]) {
      return res.status(503).json({
        error: "service_not_configured",
        message: "Marketing summary API is not configured",
      });
    }

    if (!marketingApiKeyIsValid(bearerTokenFromRequest(req))) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="OTO Radar marketing summary"');
      return res.status(401).json({
        error: "unauthorized",
        message: "Missing or invalid Bearer token",
      });
    }

    // Only authenticated calls consume Omni's quota. The bucket key is fixed,
    // so this public route can retain at most one short-lived limiter entry.
    const rate = consumeMarketingRateLimit("omni-marketing-summary");
    res.setHeader("X-RateLimit-Limit", String(MARKETING_RATE_LIMIT));
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      return res.status(429).json({
        error: "rate_limit_exceeded",
        message: "Too many requests; retry after the number of seconds in Retry-After",
      });
    }

    const startDate =
      typeof req.query.start_date === "string" ? req.query.start_date : "";
    const endDate =
      typeof req.query.end_date === "string" ? req.query.end_date : "";
    const validation = validateMarketingDateRange(startDate, endDate);
    if (!validation.ok) {
      return res.status(400).json({
        error: "invalid_date_range",
        message: validation.message,
      });
    }

    return res.status(503).json(MARKETING_FIGURES_UNAVAILABLE);
  });

  // ============================================
  // BOOTH EVENTS — Spin & Win game pushes prize events here (X-API-Key auth)
  // ============================================

  function boothApiKeyOk(req: Request): { ok: boolean; status?: number; message?: string } {
    const expected = process.env.SPIN_WIN_REDEEM_KEY;
    if (!expected) {
      return { ok: false, status: 503, message: "SPIN_WIN_REDEEM_KEY is not configured on OTO Radar" };
    }
    const got = req.headers["x-api-key"];
    if (typeof got !== "string" || got.length === 0) {
      return { ok: false, status: 401, message: "Missing X-API-Key header" };
    }
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, status: 401, message: "Invalid API key" };
    }
    return { ok: true };
  }

  const boothEventsBodySchema = z.union([
    boothEventInputSchema,
    z.object({ events: z.array(boothEventInputSchema).min(1).max(500) }),
  ]);

  // Ingest one event or a batch. Idempotent on eventId — safe to retry.
  app.post("/api/booth/events", async (req, res, next) => {
    try {
      const auth = boothApiKeyOk(req);
      if (!auth.ok) return res.status(auth.status!).json({ message: auth.message });
      const parsed = boothEventsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid event payload",
          errors: parsed.error.flatten(),
        });
      }
      const events: BoothEventInput[] =
        "events" in parsed.data ? parsed.data.events : [parsed.data];
      const result = await ingestBoothEvents(events);
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // Spin & Win's own contract: one event per POST, epoch-ms timestamps.
  // 2xx = stored OR duplicate (sender retries on 5xx only).
  app.post("/api/ingest/spin-events", async (req, res, next) => {
    try {
      const auth = boothApiKeyOk(req);
      if (!auth.ok) return res.status(auth.status!).json({ message: auth.message });
      const parsed = spinEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid event payload",
          errors: parsed.error.flatten(),
        });
      }
      const e = parsed.data;
      // Group events into one claim: claimId when known, otherwise the spin
      // (winId — but if a claim referencing this winId already arrived, use
      // its claimId so a delayed prize_won merges in), otherwise the voucher
      // code, otherwise the event itself.
      let claimKey: string;
      if (e.claimId) {
        claimKey = e.claimId;
      } else if (e.winId) {
        claimKey = (await resolveWinToClaim(e.winId)) ?? e.winId;
      } else {
        claimKey = e.code ? `code:${e.code}` : e.eventId;
      }
      const event: BoothEventInput = {
        eventId: e.eventId,
        source: e.source,
        eventType: spinEventTypeMap[e.type],
        claimId: claimKey,
        prizeName: e.prizeName,
        phone: e.phone,
        code: e.code,
        occurredAt: new Date(e.at),
        meta: e as Record<string, unknown>,
      };
      const result = await ingestBoothEvents([event]);
      // An event with both winId and claimId links the spin to the claim:
      // fold any earlier winId-keyed rows into the claim.
      if (e.claimId && e.winId) await relinkBoothClaim(e.winId, e.claimId);
      res.json({ ok: true, stored: result.inserted === 1, duplicate: result.duplicates === 1 });
    } catch (err) {
      next(err);
    }
  });

  // Claims rollup for the Redeem tab (read-only, same pattern as other dashboard data).
  app.get("/api/booth/claims", async (_req, res, next) => {
    try {
      res.json(await listBoothClaims());
    } catch (err) {
      next(err);
    }
  });

  // ============================================
  // QR PROMO CAMPAIGNS
  // ============================================

  const DEVICE_COOKIE = "qr_device_id";

  function parseCookies(req: Request): Record<string, string> {
    const header = req.headers.cookie;
    if (!header) return {};
    const out: Record<string, string> = {};
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
    return out;
  }

  function getOrSetDeviceId(req: Request, res: Response): string {
    const cookies = parseCookies(req);
    let id = cookies[DEVICE_COOKIE];
    if (!id || id.length < 8) {
      id = randomBytes(16).toString("base64url");
      const oneYear = 60 * 60 * 24 * 365;
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `${DEVICE_COOKIE}=${encodeURIComponent(id)}; Max-Age=${oneYear}; Path=/; SameSite=Lax; HttpOnly${secure}`,
      );
    }
    return id;
  }

  registerSpinRewardRoutes(app);

  const tokenSchema = z.string().trim().min(1).max(2000);
  // Redemption codes are always exactly 4 characters from the
  // generateShortCode() alphabet. Tightening the validator prevents legacy
  // 6-char inputs from being accepted now that all stored codes are 4-char.
  const shortCodeSchema = z
    .string()
    .trim()
    .length(4)
    .transform((s) => s.toUpperCase());
  const idParamSchema = z.string().uuid();
  const redeemBodySchema = z
    .object({
      token: tokenSchema.optional(),
      code: shortCodeSchema.optional(),
      redeemedBy: z.string().trim().max(120).optional(),
    })
    .refine((v) => !!v.token || !!v.code, {
      message: "Provide token or code",
    });

  // List campaigns (public read-only — same pattern as dashboard data endpoints)
  app.get("/api/campaigns", async (_req, res, next) => {
    try {
      const list = await listCampaignsWithStats();
      res.json(list);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/campaigns", async (req, res, next) => {
    try {
      const parsed = insertCampaignSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid campaign",
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const row = await createCampaign(parsed.data);
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/campaigns/:id", async (req, res, next) => {
    try {
      const idCheck = idParamSchema.safeParse(req.params.id);
      if (!idCheck.success) return res.status(400).json({ message: "Invalid campaign id" });
      const parsed = insertCampaignSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid campaign",
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const row = await updateCampaign(req.params.id, parsed.data);
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/campaigns/:id", async (req, res, next) => {
    try {
      const idCheck = idParamSchema.safeParse(req.params.id);
      if (!idCheck.success) return res.status(400).json({ message: "Invalid campaign id" });
      await deleteCampaign(idCheck.data);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ===== Staff birthdays =====
  app.get("/api/staff-birthdays", async (req, res, next) => {
    try {
      const raw = (req.query.branches as string | undefined) || "";
      const branches = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is StaffBirthdayBranch => (staffBirthdayBranches as readonly string[]).includes(s));
      const list = await listBirthdays(branches.length > 0 ? branches : undefined);
      res.json(list);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/staff-birthdays", async (req, res, next) => {
    try {
      const parsed = insertStaffBirthdaySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid", errors: parsed.error.flatten().fieldErrors });
      }
      const row = await createBirthday(parsed.data);
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/staff-birthdays/:id", async (req, res, next) => {
    try {
      const idCheck = idParamSchema.safeParse(req.params.id);
      if (!idCheck.success) return res.status(400).json({ message: "Invalid id" });
      const parsed = insertStaffBirthdaySchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid", errors: parsed.error.flatten().fieldErrors });
      }
      const row = await updateBirthday(idCheck.data, parsed.data);
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/staff-birthdays/:id", async (req, res, next) => {
    try {
      const idCheck = idParamSchema.safeParse(req.params.id);
      if (!idCheck.success) return res.status(400).json({ message: "Invalid id" });
      await deleteBirthday(idCheck.data);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Public: get campaign info (for landing page)
  app.get("/api/public/campaigns/:id", async (req, res, next) => {
    try {
      const idCheck = idParamSchema.safeParse(req.params.id);
      if (!idCheck.success) return res.status(400).json({ message: "Invalid campaign id" });
      const c = await getCampaign(idCheck.data);
      if (!c) return res.status(404).json({ message: "Campaign not found" });
      res.json({
        id: c.id,
        name: c.name,
        description: c.description,
        status: c.status,
        expiresAt: c.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  // Public: issue or fetch QR for this device
  app.post("/api/public/campaigns/:id/qr", async (req, res, next) => {
    try {
      const idCheck = idParamSchema.safeParse(req.params.id);
      if (!idCheck.success) return res.status(400).json({ message: "Invalid campaign id" });
      const deviceId = getOrSetDeviceId(req, res);
      await recordCampaignClick(req.params.id, deviceId).catch(() => {});
      const result = await getOrIssueQrForDevice(req.params.id, deviceId);
      if (!result.ok) {
        const status =
          result.error === "not_found" ? 404 :
          result.error === "disabled" ? 410 :
          result.error === "expired" ? 410 :
          result.error === "cap_reached" ? 410 : 400;
        return res.status(status).json({
          message: errorMessage(result.error),
          reasonCode: result.error,
          campaign: result.campaign
            ? { id: result.campaign.id, name: result.campaign.name }
            : null,
        });
      }
      res.json({
        token: result.qr.token,
        shortCode: result.qr.shortCode,
        status: result.qr.status,
        issuedAt: result.qr.issuedAt,
        savedAt: result.qr.savedAt,
        campaign: {
          id: result.campaign.id,
          name: result.campaign.name,
          promoCode: result.campaign.promoCode,
          description: result.campaign.description,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Public: mark saved
  app.post("/api/public/qr/:token/saved", async (req, res, next) => {
    try {
      const tCheck = tokenSchema.safeParse(req.params.token);
      if (!tCheck.success) return res.status(400).json({ message: "Invalid token" });
      const row = await markQrSaved(tCheck.data);
      if (!row) return res.status(404).json({ message: "QR not found" });
      res.json({ ok: true, status: row.status });
    } catch (err) {
      next(err);
    }
  });

  // Reception: lookup
  app.get("/api/qr/lookup/:token", async (req, res, next) => {
    try {
      const tCheck = tokenSchema.safeParse(req.params.token);
      if (!tCheck.success) return res.status(400).json({ message: "Invalid token" });
      const found = await lookupQrByToken(tCheck.data);
      if (!found) return res.status(404).json({ message: "QR not found", reasonCode: "not_found" });
      res.json({
        token: found.qr.token,
        status: found.qr.status,
        issuedAt: found.qr.issuedAt,
        savedAt: found.qr.savedAt,
        redeemedAt: found.qr.redeemedAt,
        redeemedBy: found.qr.redeemedBy,
        campaign: {
          id: found.campaign.id,
          name: found.campaign.name,
          promoCode: found.campaign.promoCode,
          status: found.campaign.status,
          expiresAt: found.campaign.expiresAt,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Reception: redeem
  app.post("/api/qr/redeem", async (req, res, next) => {
    try {
      const parsed = redeemBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid request",
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      let token: string | null = parsed.data.token ? extractToken(parsed.data.token) : null;
      if (!token && parsed.data.code) {
        const found = await lookupQrByShortCode(parsed.data.code);
        if (!found) {
          return res.status(404).json({
            message: "Code not found",
            reasonCode: "not_found",
          });
        }
        token = found.qr.token;
      }
      if (!token) return res.status(400).json({ message: "Token or code required" });
      const redeemedBy = parsed.data.redeemedBy ?? null;
      const result = await redeemQrByToken(token, redeemedBy);
      if (!result.ok) {
        const status = result.error === "not_found" ? 404 : 409;
        return res.status(status).json({
          message: errorMessage(result.error),
          reasonCode: result.error,
          qr: result.qr ? {
            token: result.qr.token,
            status: result.qr.status,
            redeemedAt: result.qr.redeemedAt,
            redeemedBy: result.qr.redeemedBy,
          } : null,
          campaign: result.campaign ? {
            id: result.campaign.id,
            name: result.campaign.name,
            promoCode: result.campaign.promoCode,
          } : null,
        });
      }
      res.json({
        ok: true,
        token: result.qr.token,
        redeemedAt: result.qr.redeemedAt,
        campaign: {
          id: result.campaign.id,
          name: result.campaign.name,
          promoCode: result.campaign.promoCode,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Dashboard stats (public read-only — same pattern as the rest of the dashboard)
  app.get("/api/campaigns/stats", async (_req, res, next) => {
    try {
      const stats = await getCampaignDashboardStats();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/campaigns/timeseries", async (req, res, next) => {
    try {
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const start = String(req.query.start || req.query.from || "");
      const end = String(req.query.end || req.query.to || "");
      if (!dateRe.test(start) || !dateRe.test(end)) {
        return res.status(400).json({ message: "start and end must be YYYY-MM-DD" });
      }
      if (start > end) {
        return res.status(400).json({ message: "start must be on or before end" });
      }
      const granRaw = String(req.query.granularity || "day");
      const allowed: CampaignGranularity[] = ["day", "week", "month"];
      if (!allowed.includes(granRaw as CampaignGranularity)) {
        return res.status(400).json({ message: "granularity must be day, week, or month" });
      }
      const series = await getCampaignTimeSeries(start, end, granRaw as CampaignGranularity);
      res.json(series);
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Error:", err);
    // Never the error's own text: it can carry SQL or an upstream body.
    res.status(500).json({ message: "Internal server error" });
  });

  return httpServer;
}

function errorMessage(code: string): string {
  switch (code) {
    case "not_found": return "QR or campaign not found";
    case "already_used": return "This QR has already been redeemed";
    case "expired": return "This campaign has expired";
    case "disabled": return "This campaign is no longer active";
    case "cap_reached": return "This campaign has reached its usage cap";
    default: return "Unable to process request";
  }
}

function extractToken(raw: string): string {
  if (!raw) return "";
  // Allow either bare token or full URL like https://.../c/{id}?t={token}
  try {
    if (raw.includes("/")) {
      const url = new URL(raw, "http://x");
      const t = url.searchParams.get("t");
      if (t) return t;
      const parts = url.pathname.split("/").filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
  } catch {}
  return raw;
}
