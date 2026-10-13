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
import { BoundedAsyncCache, compactDashboardRange } from "./rangePerformance";

const dashboardRangeCache = new BoundedAsyncCache<any>(2 * 60 * 1000, 24);
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
  bearerTokenFromRequest,
  buildMarketingSummary,
  consumeMarketingRateLimit,
  marketingApiKeyIsValid,
  validateMarketingDateRange,
} from "./marketingSummary";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.set('etag', false);


  app.post("/api/sync-today", async (req, res, next) => {
    try {
      const branch = req.body?.branch as string | undefined;
      if (branch && branch !== "floresta" && branch !== "chalong") {
        return res.status(400).json({ error: "Invalid branch. Must be 'floresta', 'chalong', or omitted for all." });
      }
      console.log(`[ManualSync] Syncing today's data${branch ? ` for branch: ${branch}` : " for all branches"}...`);
      const { syncFuntopiaToday, isFuntopiaConfigured } = await import("./funtopia");
      const { syncPapayaToday, isPapayaConfigured } = await import("./papaya");
      const promises: Promise<any>[] = [];
      const syncFloresta = !branch || branch === "floresta";
      const syncChalong = !branch || branch === "chalong";
      if (syncFloresta && isFuntopiaConfigured()) {
        promises.push(syncFuntopiaToday());
      }
      if (syncChalong && isPapayaConfigured()) {
        promises.push(syncPapayaToday("reception"));
        promises.push(syncPapayaToday("restaurant"));
      }
      await Promise.allSettled(promises);
      res.json({ success: true, message: "Today synced from APIs" });
    } catch (err) {
      next(err);
    }
  });

  const AUTO_SYNC_INTERVAL = 5 * 60 * 1000;
  // Production DB (Neon) cold-starts can make the first connection attempts
  // fail with "Authentication timed out". Warm the pool with retries before
  // syncing so a cold start doesn't silently skip a sync cycle.
  async function ensureDbReady(maxAttempts = 3): Promise<boolean> {
    const { pool } = await import("./db");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch (e: any) {
        console.warn(`[AutoSync] DB not ready (attempt ${attempt}/${maxAttempts}): ${e.message}`);
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
    return false;
  }
  async function syncTodayBackground() {
    try {
      if (!(await ensureDbReady())) {
        console.error(`[AutoSync] Skipped this cycle — database unavailable after retries`);
        return;
      }
      const { syncFuntopiaToday, isFuntopiaConfigured } = await import("./funtopia");
      const { syncPapayaToday, isPapayaConfigured } = await import("./papaya");
      console.log(`[AutoSync] Syncing today's data for all branches...`);
      const promises: Promise<any>[] = [];
      if (isFuntopiaConfigured()) promises.push(syncFuntopiaToday());
      if (isPapayaConfigured()) {
        promises.push(syncPapayaToday("reception").catch(e => console.error("[AutoSync] reception:", e.message)));
        promises.push(syncPapayaToday("restaurant").catch(e => console.error("[AutoSync] restaurant:", e.message)));
      }
      await Promise.allSettled(promises);
      console.log(`[AutoSync] Today's data synced successfully`);
    } catch (err: any) {
      console.error(`[AutoSync] Error:`, err.message);
    }
  }
  setTimeout(() => syncTodayBackground(), 5000);
  setInterval(() => syncTodayBackground(), AUTO_SYNC_INTERVAL);

  // ============================================
  // PAPAYA POS API (Robinson Chalong)
  // ============================================

  app.get("/api/papaya/today", async (req, res, next) => {
    try {
      const { getCombinedPapayaDailySummary, isPapayaConfigured } = await import("./papaya");
      if (!isPapayaConfigured()) {
        return res.json({ totalRevenue: 0, totalOrders: 0, papayaConnected: false });
      }

      const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
      const summary = await getCombinedPapayaDailySummary(todayStr);

      res.json({
        ...summary,
        customerTypeSplit: [],
        dailyRevenue: [],
        cashReportsDailyTotals: [],
        voucherSwingAmount: 0,
        pureTicketRevenue: summary?.categoryBreakdown?.["Tickets & Packages"]?.revenue || 0,
        staffOnDuty: 0,
        eventCount: 0,
        funtopiaConnected: false,
        papayaConnected: true,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/daily/:date", async (req, res, next) => {
    try {
      const { getCombinedPapayaDailySummary, isPapayaConfigured } = await import("./papaya");
      if (!isPapayaConfigured()) {
        return res.json({ totalRevenue: 0, totalOrders: 0 });
      }
      const summary = await getCombinedPapayaDailySummary(req.params.date);
      res.json(summary || { date: req.params.date, totalRevenue: 0, totalOrders: 0 });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/range", async (req, res, next) => {
    try {
      const { getCombinedPapayaDateRangeSummary, isPapayaConfigured } = await import("./papaya");
      if (!isPapayaConfigured()) {
        try {
          const { pool: localPool } = await import("./db");
          const cacheCheck = await localPool.query("SELECT COUNT(*) as cnt FROM papaya_daily_cache");
          if (parseInt(cacheCheck.rows[0]?.cnt || "0") === 0) {
            return res.json({ totalRevenue: 0, totalOrders: 0, summaries: [] });
          }
        } catch {
          return res.json({ totalRevenue: 0, totalOrders: 0, summaries: [] });
        }
      }
      const from = (req.query.from || req.query.start) as string;
      const to = (req.query.to || req.query.end) as string;
      if (!from || !to) return res.status(400).json({ error: "from/start and to/end required" });
      const rangeCacheKey = `chalong:${from}:${to}`;
      const cachedResponse = dashboardRangeCache.get(rangeCacheKey);
      if (cachedResponse) return res.json(cachedResponse);
      const summaries = await getCombinedPapayaDateRangeSummary(from, to);
      const { mergeSourceBreakdowns } = await import("./sourceRegistry");
      const { classifyPapayaFnbSubCategory } = await import("./papaya");

      let totalRevenue = 0;
      let totalOrders = 0;
      let discountTotal = 0;
      const paymentBreakdown: Record<string, number> = {};
      const categoryBreakdown: Record<string, any> = {};
      // task-114 v3: aggregate per-natural-category birthday-channel split
      // metadata across days so the client can flip allocation views on
      // ranges instantly.
      const birthdayChannelSplit: Record<string, { revenue: number; quantity: number; items: Array<{ name: string; category: string; revenue: number; quantity: number }> }> = {};
      const dailyRevenue: Array<{
        date: string;
        revenue: number;
        orders: number;
        categories: Record<string, number>;
      }> = [];
      const topProductsMap: Record<string, { name: string; category: string; quantity: number; revenue: number }> = {};
      const hourlyAgg: Record<number, { hour: number; label: string; revenue: number; orders: number; ticketsSold: number; summerCamp: { revenue: number; orders: number; ticketsSold: number }; categories: Record<string, number>; customerTypes: Record<string, { kids: number; adults: number }> }> = {};

      for (const s of summaries) {
        totalRevenue += s.totalRevenue;
        totalOrders += s.totalOrders;
        discountTotal += s.discountTotal || 0;

        // Reconcile per-day category breakdown so it sums exactly to that day's totalRevenue
        // (Papaya item-level discount pro-rating produces sub-baht drift that compounds).
        const dayCats: Record<string, number> = {};
        let dayCatSum = 0;
        for (const [cat, data] of Object.entries(s.categoryBreakdown || {})) {
          const rev = (data as any).revenue || 0;
          dayCats[cat] = rev;
          dayCatSum += rev;
        }
        if (dayCatSum > 0 && Math.abs(dayCatSum - s.totalRevenue) > 0.01) {
          const scale = s.totalRevenue / dayCatSum;
          for (const cat of Object.keys(dayCats)) {
            dayCats[cat] = Math.round(dayCats[cat] * scale * 100) / 100;
          }
          // Push residual into the largest category so the sum equals totalRevenue exactly.
          const roundedSum = Object.values(dayCats).reduce((a, b) => a + b, 0);
          const residual = Math.round((s.totalRevenue - roundedSum) * 100) / 100;
          if (Math.abs(residual) > 0) {
            let largest = "";
            let largestRev = -Infinity;
            for (const [cat, rev] of Object.entries(dayCats)) {
              if (rev > largestRev) { largestRev = rev; largest = cat; }
            }
            if (largest) dayCats[largest] = Math.round((dayCats[largest] + residual) * 100) / 100;
          }
        }

        dailyRevenue.push({ date: s.date, revenue: s.totalRevenue, orders: s.totalOrders, categories: dayCats });

        for (const [method, amount] of Object.entries(s.paymentBreakdown || {})) {
          paymentBreakdown[method] = (paymentBreakdown[method] || 0) + amount;
        }

        for (const [cat, data] of Object.entries(s.categoryBreakdown || {})) {
          if (!categoryBreakdown[cat]) {
            categoryBreakdown[cat] = { revenue: 0, quantity: 0, items: [] };
          }
          // Use the reconciled per-day value so the range sum stays exact.
          categoryBreakdown[cat].revenue += dayCats[cat] ?? ((data as any).revenue || 0);
          categoryBreakdown[cat].quantity += (data as any).quantity || 0;
          // Merge per-category items across days (dedupe by name, sum
          // quantity + revenue) so the dashboard's Revenue by Category
          // drill-down works on multi-day ranges for Chalong.
          // task-119: key by (name, isBday) so a product sold both as bday
          // and non-bday across days stays as two rows in the range view.
          const itemsMap = new Map<string, { name: string; category: string; revenue: number; quantity: number; bdayRevenue?: number }>();
          const kOf = (it: any) => `${it.name}::${it.bdayRevenue && it.bdayRevenue > 0 ? "1" : "0"}`;
          for (const it of categoryBreakdown[cat].items) itemsMap.set(kOf(it), it);
          for (const it of (data as any).items || []) {
            const k = kOf(it);
            const ex = itemsMap.get(k);
            if (ex) {
              ex.revenue += it.revenue || 0;
              ex.quantity += it.quantity || 0;
              if (it.bdayRevenue) ex.bdayRevenue = (ex.bdayRevenue || 0) + it.bdayRevenue;
            }
            else itemsMap.set(k, { ...it });
          }
          categoryBreakdown[cat].items = Array.from(itemsMap.values()).sort((a, b) => b.revenue - a.revenue);
          // task-119 follow-up: rebuild F&B Food/Drinks sub-categories from
          // the merged item list so the Chalong range view has the same
          // drill-down sub-grouping as Floresta.
          if (cat === "F&B") {
            const subs: Record<string, { revenue: number; quantity: number; items: any[] }> = {
              Food: { revenue: 0, quantity: 0, items: [] },
              Drinks: { revenue: 0, quantity: 0, items: [] },
            };
            for (const it of categoryBreakdown[cat].items) {
              const k = classifyPapayaFnbSubCategory(it.name);
              subs[k].revenue += it.revenue || 0;
              subs[k].quantity += it.quantity || 0;
              subs[k].items.push(it);
            }
            categoryBreakdown[cat].subCategories = subs;
          }
        }

        // task-114 v3: aggregate per-day birthday-channel split. Items are
        // merged by name across days so the client can re-bucket on toggle.
        for (const [cat, data] of Object.entries(s.birthdayChannelSplit || {})) {
          if (!birthdayChannelSplit[cat]) {
            birthdayChannelSplit[cat] = { revenue: 0, quantity: 0, items: [] };
          }
          birthdayChannelSplit[cat].revenue += (data as any).revenue || 0;
          birthdayChannelSplit[cat].quantity += (data as any).quantity || 0;
          // task-119: key by (name, isBday) for split consistency. Birthday-
          // channel split items are by definition bday, but key the same way
          // for shape parity with the regular category items merge above.
          const itemsMap = new Map<string, { name: string; category: string; revenue: number; quantity: number; bdayRevenue?: number }>();
          const kOf = (it: any) => `${it.name}::${it.bdayRevenue && it.bdayRevenue > 0 ? "1" : "0"}`;
          for (const it of birthdayChannelSplit[cat].items) itemsMap.set(kOf(it), it);
          for (const it of (data as any).items || []) {
            const k = kOf(it);
            const ex = itemsMap.get(k);
            if (ex) {
              ex.revenue += it.revenue || 0;
              ex.quantity += it.quantity || 0;
              if (it.bdayRevenue) ex.bdayRevenue = (ex.bdayRevenue || 0) + it.bdayRevenue;
            }
            else itemsMap.set(k, { ...it });
          }
          birthdayChannelSplit[cat].items = Array.from(itemsMap.values()).sort((a, b) => b.revenue - a.revenue);
          if (cat === "F&B") {
            const subs: Record<string, { revenue: number; quantity: number; items: any[] }> = {
              Food: { revenue: 0, quantity: 0, items: [] },
              Drinks: { revenue: 0, quantity: 0, items: [] },
            };
            for (const it of birthdayChannelSplit[cat].items) {
              const k = classifyPapayaFnbSubCategory(it.name);
              subs[k].revenue += it.revenue || 0;
              subs[k].quantity += it.quantity || 0;
              subs[k].items.push(it);
            }
            (birthdayChannelSplit[cat] as any).subCategories = subs;
          }
        }

        for (const p of (s.topProducts || [])) {
          const key = p.name;
          if (!topProductsMap[key]) {
            topProductsMap[key] = { name: p.name, category: p.category || "", quantity: 0, revenue: 0 };
          }
          topProductsMap[key].quantity += p.quantity || 0;
          topProductsMap[key].revenue += p.revenue || 0;
        }

        for (const h of (s.hourlyBreakdown || [])) {
          if (!hourlyAgg[h.hour]) {
            hourlyAgg[h.hour] = {
              hour: h.hour,
              label: (h as any).label || `${String(h.hour).padStart(2, "0")}:00`,
              revenue: 0, orders: 0, ticketsSold: 0,
              summerCamp: { revenue: 0, orders: 0, ticketsSold: 0 },
              categories: {},
              customerTypes: {},
            };
          }
          hourlyAgg[h.hour].revenue += h.revenue || 0;
          hourlyAgg[h.hour].orders += h.orders || 0;
          hourlyAgg[h.hour].ticketsSold += (h as any).ticketsSold || 0;
          hourlyAgg[h.hour].summerCamp.revenue += (h as any).summerCamp?.revenue || 0;
          hourlyAgg[h.hour].summerCamp.orders += (h as any).summerCamp?.orders || 0;
          hourlyAgg[h.hour].summerCamp.ticketsSold += (h as any).summerCamp?.ticketsSold || 0;
          const hCats = (h as any).categories || {};
          for (const [k, v] of Object.entries(hCats)) {
            hourlyAgg[h.hour].categories[k] = (hourlyAgg[h.hour].categories[k] || 0) + (Number(v) || 0);
          }
          const hCt = (h as any).customerTypes || {};
          for (const [k, ct] of Object.entries(hCt) as [string, any][]) {
            if (!hourlyAgg[h.hour].customerTypes[k]) {
              hourlyAgg[h.hour].customerTypes[k] = { kids: 0, adults: 0 };
            }
            hourlyAgg[h.hour].customerTypes[k].kids += ct.kids || 0;
            hourlyAgg[h.hour].customerTypes[k].adults += ct.adults || 0;
          }
        }
      }

      const topProducts = Object.values(topProductsMap)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 20);

      const hourlyBreakdown = Object.values(hourlyAgg).sort((a, b) => a.hour - b.hour);

      // task-122: aggregate guestBreakdown across days so Chalong shows the
      // Guest Overview card on Yesterday/Week/Month/past-day views. For a
      // single day we pass through unchanged; for ranges we sum kids/adults/
      // revenue, merge stayDistribution counts, recompute a weighted average
      // stay duration, and merge per-ticket detail rows. Ongoing in-park
      // figures are omitted for past/range data — they only mean anything
      // for the current day.
      let guestBreakdown: any = null;
      const guestSummaries = summaries.filter((s: any) => s.guestBreakdown);
      if (summaries.length === 1 && guestSummaries.length === 1) {
        guestBreakdown = guestSummaries[0].guestBreakdown;
      } else if (guestSummaries.length >= 1) {
        let kids = 0, adults = 0, kidRevenue = 0, adultRevenue = 0;
        const stayMap = new Map<number, { hours: number; count: number; label: string }>();
        const detailsMap = new Map<string, { name: string; type: string; quantity: number; revenue: number }>();
        for (const s of guestSummaries) {
          const gb: any = s.guestBreakdown;
          kids += gb.kidTickets || gb.kids || 0;
          adults += gb.estimatedTotalAdults || gb.adultTickets || gb.adults || 0;
          kidRevenue += gb.kidRevenue || 0;
          adultRevenue += gb.adultRevenue || 0;
          for (const sd of (gb.stayDistribution || [])) {
            const ex = stayMap.get(sd.hours);
            if (ex) ex.count += sd.count || 0;
            else stayMap.set(sd.hours, { hours: sd.hours, count: sd.count || 0, label: sd.label });
          }
          for (const d of (gb.details || [])) {
            const k = `${d.name}::${d.type || ""}`;
            const ex = detailsMap.get(k);
            if (ex) { ex.quantity += d.quantity || 0; ex.revenue += d.revenue || 0; }
            else detailsMap.set(k, { name: d.name, type: d.type, quantity: d.quantity || 0, revenue: d.revenue || 0 });
          }
        }
        const stayDistribution = Array.from(stayMap.values()).sort((a, b) => a.hours - b.hours);
        const stayWeighted = stayDistribution.reduce((s, x) => s + x.hours * x.count, 0);
        const stayCount = stayDistribution.reduce((s, x) => s + x.count, 0);
        const avgStayHours = stayCount > 0 ? Math.round((stayWeighted / stayCount) * 10) / 10 : 0;
        guestBreakdown = {
          kids, adults, totalGuests: kids + adults,
          kidTickets: kids,
          adultTickets: adults,
          estimatedTotalAdults: adults,
          totalInPark: kids + adults,
          kidRevenue, adultRevenue,
          avgStayHours,
          stayDistribution,
          details: Array.from(detailsMap.values()).sort((a, b) => b.revenue - a.revenue),
          ongoingKids: 0,
          ongoingAdults: 0,
          ongoingTotal: 0,
          completedKids: kids,
          completedAdults: adults,
          completedTotal: kids + adults,
        };
      }

      // Build per-day hourly array so the dashboard's heatmap and per-day filters work for Chalong too.
      const dailyHourly = summaries.map((s) => ({
        date: s.date,
        hourlyBreakdown: s.hourlyBreakdown || [],
      })).sort((a, b) => a.date.localeCompare(b.date));

      const sourceBreakdown = mergeSourceBreakdowns(
        summaries.map((s: any) => s.sourceBreakdown || []),
      );

      const response = {
        totalRevenue,
        totalOrders,
        discountTotal,
        avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
        paymentBreakdown,
        categoryBreakdown,
        birthdayChannelSplit,
        topProducts,
        hourlyBreakdown,
        dailyHourly,
        dailyRevenue,
        sourceBreakdown,
        guestBreakdown,
        summaries,
      };
      dashboardRangeCache.set(rangeCacheKey, response);
      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  let papayaSyncRunning = false;
  let papayaSyncProgress = "";

  app.post("/api/papaya/sync", async (req, res, next) => {
    try {
      const { syncPapayaDateRange, isPapayaConfigured, setPapayaSyncMeta, getPapayaTerminals } = await import("./papaya");
      if (!isPapayaConfigured()) {
        return res.status(503).json({ message: "Papaya POS not configured" });
      }
      if (papayaSyncRunning) {
        return res.json({ status: "already_running", progress: papayaSyncProgress });
      }
      const { from, to, terminal, mode } = req.body;
      if (!from || !to) return res.status(400).json({ error: "from and to required" });
      if (terminal && terminal !== "reception" && terminal !== "restaurant") {
        return res.status(400).json({ error: "terminal must be 'reception' or 'restaurant'" });
      }

      papayaSyncRunning = true;
      papayaSyncProgress = `Starting sync: ${from} → ${to}`;
      res.json({ status: "started", from, to });

      const syncMode: "quick" | "full" = mode === "full" ? "full" : "quick";

      (async () => {
        try {
          if (terminal) {
            const result = await syncPapayaDateRange(from, to, terminal, (msg: string) => {
              papayaSyncProgress = msg;
            }, syncMode);
            papayaSyncProgress = `Done: synced ${result.synced} days (${terminal})`;
          } else {
            const terminals = getPapayaTerminals();
            let totalSynced = 0;
            for (const t of terminals) {
              papayaSyncProgress = `Syncing ${t}: ${from} → ${to}`;
              const r = await syncPapayaDateRange(from, to, t, (msg: string) => {
                papayaSyncProgress = `[${t}] ${msg}`;
              }, syncMode);
              totalSynced += r.synced;
            }
            papayaSyncProgress = `Done: synced ${totalSynced} days (${terminals.join(" + ")})`;
          }
          await setPapayaSyncMeta(syncMode);
        } catch (err: any) {
          papayaSyncProgress = `Error: ${err.message}`;
        } finally {
          papayaSyncRunning = false;
        }
      })();
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/sync-progress", (_req, res) => {
    res.json({ running: papayaSyncRunning, progress: papayaSyncProgress });
  });

  let papayaProcessRunning = false;
  let papayaProcessProgress = "";

  app.post("/api/papaya/process", async (req, res, next) => {
    try {
      const { regeneratePapayaSummariesFromRaw } = await import("./papaya");
      if (papayaProcessRunning) {
        return res.json({ status: "already_running", progress: papayaProcessProgress });
      }
      const { from, to, terminal } = req.body;
      if (!from || !to) return res.status(400).json({ error: "from and to required" });

      papayaProcessRunning = true;
      papayaProcessProgress = `Starting processing: ${from} → ${to}`;
      res.json({ status: "started", from, to });

      (async () => {
        try {
          const result = await regeneratePapayaSummariesFromRaw(from, to, terminal, (msg: string) => {
            papayaProcessProgress = msg;
          });
          papayaProcessProgress = `Done: processed ${result.regenerated} days`;
        } catch (err: any) {
          papayaProcessProgress = `Error: ${err.message}`;
        } finally {
          papayaProcessRunning = false;
        }
      })();
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/process-progress", (_req, res) => {
    res.json({ running: papayaProcessRunning, progress: papayaProcessProgress });
  });

  app.post("/api/papaya/clear-cache", async (req, res, next) => {
    try {
      const { clearPapayaCache } = await import("./papaya");
      await clearPapayaCache();
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/orders-by-discount", async (req, res, next) => {
    try {
      const { getPapayaOrdersByDiscount } = await import("./papaya");
      const date = req.query.date as string | undefined;
      const from = (req.query.from as string | undefined) || date;
      const to = (req.query.to as string | undefined) || date;
      const discount = req.query.discount as string;
      if (!from || !to || !discount) {
        return res.status(400).json({ error: "discount and either date or from/to required" });
      }
      const result = await getPapayaOrdersByDiscount(from, discount, to);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/invoice-settings", async (_req, res, next) => {
    try {
      const { getPapayaInvoiceSettings } = await import("./papaya");
      const settings = await getPapayaInvoiceSettings();
      res.json(settings);
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/papaya/invoice-settings", async (req, res, next) => {
    try {
      const { setPapayaInvoiceSettings, getPapayaInvoiceSettings, DEFAULT_INVOICE_SETTINGS } = await import("./papaya");
      const body = req.body || {};
      const merged = {
        header: { ...DEFAULT_INVOICE_SETTINGS.header, ...(body.header || {}) },
        posTaxIds: { ...DEFAULT_INVOICE_SETTINGS.posTaxIds, ...(body.posTaxIds || {}) },
      };
      if (Array.isArray(body.header?.addressLines)) {
        merged.header.addressLines = body.header.addressLines.map((l: any) => String(l || ""));
      }
      await setPapayaInvoiceSettings(merged);
      res.json(await getPapayaInvoiceSettings());
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/invoices", async (req, res, next) => {
    try {
      const { getPapayaInvoices } = await import("./papaya");
      const from = req.query.from as string;
      const to = req.query.to as string;
      const terminalRaw = req.query.terminal as string | undefined;
      if (!from || !to) return res.status(400).json({ error: "from and to required" });
      let terminal: "reception" | "restaurant" | undefined;
      if (terminalRaw && terminalRaw !== "all") {
        if (terminalRaw === "reception" || terminalRaw === "restaurant") {
          terminal = terminalRaw;
        } else {
          return res.status(400).json({ error: "invalid terminal" });
        }
      }
      const invoices = await getPapayaInvoices(from, to, terminal);
      res.json({ invoices });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/invoices/:terminal/:id", async (req, res, next) => {
    try {
      const { getPapayaInvoice } = await import("./papaya");
      const { terminal, id } = req.params;
      if (terminal !== "reception" && terminal !== "restaurant") {
        return res.status(400).json({ error: "invalid terminal" });
      }
      const invoice = await getPapayaInvoice(id, terminal);
      if (!invoice) return res.status(404).json({ error: "invoice not found" });
      res.json(invoice);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/status", async (_req, res, next) => {
    try {
      const { isPapayaConfigured } = await import("./papaya");
      res.json({ configured: isPapayaConfigured() });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/sync-status", async (_req, res, next) => {
    try {
      const { isPapayaConfigured, getPapayaSyncStatus } = await import("./papaya");
      const status = await getPapayaSyncStatus();
      res.json({
        ...status,
        cachedDates: status.cachedDays,
        papayaConnected: isPapayaConfigured() || status.cachedDays > 0,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/papaya/regenerate-summaries", async (req, res, next) => {
    try {
      const { regeneratePapayaSummariesFromRaw } = await import("./papaya");
      const { from, to, terminal } = req.body;
      if (!from || !to) return res.status(400).json({ error: "from and to required" });
      const result = await regeneratePapayaSummariesFromRaw(from, to, terminal);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ============================================
  // FUNTOPIA POS API
  // ============================================

  app.get("/api/funtopia/reports/detail-transactions", async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
      });
      const parsed = schema.safeParse({ from: req.query.from, to: req.query.to });
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "invalid params" });
      }
      const { from, to } = parsed.data;
      if (from > to) {
        return res.status(400).json({ error: "from must be on or before to" });
      }
      const { buildDetailTransactionWorkbookBuffer } = await import("./funtopia");
      const buf = await buildDetailTransactionWorkbookBuffer(from, to);
      const filename = `Floresta_Detail_Transactions_${from}_to_${to}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buf);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/reports/cash-collections", async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
      });
      const parsed = schema.safeParse({ from: req.query.from, to: req.query.to });
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "invalid params" });
      }
      const { from, to } = parsed.data;
      if (from > to) {
        return res.status(400).json({ error: "from must be on or before to" });
      }
      const { buildCashCollectionWorkbookBuffer } = await import("./cashCollectionReport");
      const buf = await buildCashCollectionWorkbookBuffer(from, to);
      const filename = `Floresta_Cash_Collections_${from}_to_${to}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buf);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/formulas", async (_req, res) => {
    const { FORMULA_REGISTRY, FORMULA_VERSION, FORMULA_LAST_UPDATED } = await import("./funtopia");
    res.json({ version: FORMULA_VERSION, lastUpdated: FORMULA_LAST_UPDATED, categories: FORMULA_REGISTRY });
  });

  // Per-branch preference: should birthday-linked F&B revenue be reported under
  // F&B (default) or moved to "Events / Birthdays". Read by every dashboard tab,
  // the AI assistant, and the chart-builder so the numbers agree everywhere.
  app.get("/api/funtopia/preferences/birthday-allocation", async (req, res, next) => {
    try {
      const { getBirthdayAllocation, getChalongBirthdayAllocation } = await import("./funtopia");
      const branch = (req.query.branch as string) || "floresta";
      if (branch === "chalong") {
        const allocation = await getChalongBirthdayAllocation();
        return res.json({ branch, allocation });
      }
      const allocation = await getBirthdayAllocation(branch);
      res.json({ branch, allocation });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/funtopia/preferences/birthday-allocation", async (req, res, next) => {
    try {
      const {
        setBirthdayAllocation,
        getBirthdayAllocation,
        setChalongBirthdayAllocation,
        getChalongBirthdayAllocation,
      } = await import("./funtopia");
      const branch = (req.body?.branch as string) || (req.query.branch as string) || "floresta";
      const raw = req.body?.allocation;
      // task-114: Chalong uses its own "bday"|"split" vocabulary so the
      // two branches' allocation values can't collide if a client mixes them.
      if (branch === "chalong") {
        if (raw !== "bday" && raw !== "split") {
          return res.status(400).json({ message: "allocation must be 'bday' or 'split' for chalong" });
        }
        await setChalongBirthdayAllocation(raw);
        const allocation = await getChalongBirthdayAllocation();
        return res.json({ success: true, branch, allocation });
      }
      if (raw !== "fnb" && raw !== "events") {
        return res.status(400).json({ message: "allocation must be 'fnb' or 'events'" });
      }
      await setBirthdayAllocation(branch, raw);
      const allocation = await getBirthdayAllocation(branch);
      res.json({ success: true, branch, allocation });
    } catch (err) {
      next(err);
    }
  });

  // task-160: Revenue Planner — per-month, per-branch manually-set revenue
  // target. Purely additive: stored in the existing funtopia_branch_settings
  // key/value table (key = "planner_target_YYYY-MM"), no new tables and no
  // changes to any existing endpoint or formula.
  app.get("/api/planner/target", async (req, res, next) => {
    try {
      const { getBranchSetting } = await import("./funtopia");
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
      const { setBranchSetting } = await import("./funtopia");
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
  // branch, stored in funtopia_branch_settings (key = "planner_plan_YYYY-MM").
  // Same purely-additive pattern as planner_target above.
  app.get("/api/planner/plan", async (req, res, next) => {
    try {
      const { getBranchSetting } = await import("./funtopia");
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
      const { setBranchSetting } = await import("./funtopia");
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

  app.get("/api/funtopia/order/:orderId", async (req, res, next) => {
    try {
      const orderId = String(req.params.orderId || "");
      if (!orderId) return res.status(400).json({ error: "orderId required" });
      const orderRes = await pool.query(
        `SELECT order_id, order_code, customer_name, customer_phone, customer_email,
                note, created_at, source, channel, total_amount, order_date
           FROM funtopia_raw_orders WHERE order_id = $1 LIMIT 1`,
        [orderId],
      );
      if (orderRes.rows.length === 0) {
        return res.status(404).json({ error: "order not found" });
      }
      const order = orderRes.rows[0];
      const itemsRes = await pool.query(
        `SELECT product_name, product_category, quantity, unit_price, subtotal, discount
           FROM funtopia_orders WHERE order_id = $1
           ORDER BY id ASC`,
        [orderId],
      );
      const paymentsRes = await pool.query(
        `SELECT pay_method, payment_name, pay_amount, payment_at
           FROM funtopia_raw_payments WHERE order_id = $1
           ORDER BY id ASC`,
        [orderId],
      );
      res.json({
        order: {
          orderId: order.order_id,
          orderCode: order.order_code,
          customerName: order.customer_name,
          customerPhone: order.customer_phone,
          customerEmail: order.customer_email,
          note: order.note,
          createdAt: order.created_at,
          source: order.source,
          channel: order.channel,
          totalAmount: Number(order.total_amount || 0),
          orderDate: order.order_date,
        },
        items: itemsRes.rows.map((r) => ({
          productName: r.product_name,
          productCategory: r.product_category,
          quantity: Number(r.quantity || 0),
          unitPrice: Number(r.unit_price || 0),
          subtotal: Number(r.subtotal || 0),
          discount: Number(r.discount || 0),
        })),
        payments: paymentsRes.rows.map((r) => ({
          payMethod: r.pay_method,
          paymentName: r.payment_name,
          payAmount: Number(r.pay_amount || 0),
          paymentAt: r.payment_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/adjustments", async (req, res, next) => {
    try {
      const { getAdjustmentsData } = await import("./funtopia");
      const date = req.query.date as string;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "date query parameter required in YYYY-MM-DD format" });
      }
      const data = await getAdjustmentsData(date);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/today", async (req, res, next) => {
    try {
      const { getDailySummary, isFuntopiaConfigured, getBirthdayAllocation } = await import("./funtopia");

      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());

      const staffOnDuty = 0;
      const eventCount = 0;

      let funtopiaData = null;
      try {
        funtopiaData = await getDailySummary(today);
      } catch (e) {
        console.error("Funtopia data error:", e);
      }

      const apiConfigured = isFuntopiaConfigured();
      const hasCachedData = !!funtopiaData;

      // getDailySummary already stamps `categoryBreakdown` to the current
      // allocation and records `birthdayMovedAmount` on the cached row.
      const birthdayAllocation = funtopiaData?.birthdayAllocation
        ?? (await getBirthdayAllocation("floresta"));
      const birthdayMovedAmount = funtopiaData?.birthdayMovedAmount || 0;

      res.json({
        date: funtopiaData?.date || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date()),
        totalRevenue: funtopiaData?.totalRevenue || 0,
        totalOrders: funtopiaData?.totalOrders || 0,
        avgOrderValue: funtopiaData?.avgOrderValue || 0,
        paymentBreakdown: funtopiaData?.paymentBreakdown || {},
        topProducts: funtopiaData?.topProducts || [],
        categoryBreakdown: funtopiaData?.categoryBreakdown || {},
        guestBreakdown: funtopiaData?.guestBreakdown || null,
        hourlyBreakdown: funtopiaData?.hourlyBreakdown || [],
        customerTypeSplit: funtopiaData?.customerTypeSplit || [],
        discountTotal: funtopiaData?.discountTotal || 0,
        voucherSwingAmount: funtopiaData?.voucherSwingAmount || 0,
        pureTicketRevenue: funtopiaData?.pureTicketRevenue || 0,
        sourceBreakdown: funtopiaData?.sourceBreakdown || [],
        birthdayLinks: funtopiaData?.birthdayLinks || null,
        birthdayAllocation,
        birthdayMovedAmount,
        staffOnDuty,
        eventCount,
        funtopiaConnected: apiConfigured || hasCachedData,
      });
    } catch (err) {
      next(err);
    }
  });

  const funtopiaSyncState = {
    running: false,
    mode: null as string | null,
    startedAt: null as string | null,
    progress: "",
    error: null as string | null,
    lastResult: null as any,
    totalDays: 0,
    syncedDays: 0,
    eta: "",
    syncStartDate: null as string | null,
    syncEndDate: null as string | null,
    warnings: [] as string[],
    skippedDates: [] as string[],
  };

  app.get("/api/funtopia/sync-health", async (req, res, next) => {
    try {
      const { getSyncHealth } = await import("./funtopia");
      const dates = (req.query.dates as string || "").split(",").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (dates.length === 0) {
        return res.status(400).json({ message: "dates query parameter required (comma-separated YYYY-MM-DD)" });
      }
      const health = await getSyncHealth(dates);
      res.json({ health });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/funtopia/resync-date", async (req, res, next) => {
    try {
      const { resyncDate } = await import("./funtopia");
      const { date } = req.body;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: "date required in YYYY-MM-DD format" });
      }
      const result = await resyncDate(date);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // task-171: per-branch "POS stopped uploading mid-day" staleness check.
  app.get("/api/pos-staleness", async (_req, res, next) => {
    try {
      const { getPosStalenessAlerts } = await import("./posStaleness");
      res.json(await getPosStalenessAlerts());
    } catch (err) {
      next(err);
    }
  });

  // task-178: source gap watchdog — detects when a normally-active Floresta
  // revenue source (Sales Booth, Mascot, etc.) records zero orders for
  // CONSECUTIVE_ZERO_DAYS consecutive days.
  app.get("/api/funtopia/source-watchdog", async (_req, res, next) => {
    try {
      const { getSourceGapAlerts } = await import("./sourceWatchdog");
      res.json(await getSourceGapAlerts());
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/papaya/sync-health", async (req, res, next) => {
    try {
      const { getPapayaSyncHealth } = await import("./papaya");
      const dates = (req.query.dates as string || "").split(",").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (dates.length === 0) {
        return res.status(400).json({ message: "dates query parameter required (comma-separated YYYY-MM-DD)" });
      }
      const health = await getPapayaSyncHealth(dates);
      res.json({ health });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/papaya/resync-date", async (req, res, next) => {
    try {
      const { resyncPapayaDate } = await import("./papaya");
      const { date } = req.body;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: "date required in YYYY-MM-DD format" });
      }
      const result = await resyncPapayaDate(date);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/voucher-mappings", async (_req, res, next) => {
    try {
      const { discoverVoucherFaceValues, getVoucherChannelMap } = await import("./funtopia");
      const [discovered, mapping] = await Promise.all([
        discoverVoucherFaceValues(180),
        getVoucherChannelMap(),
      ]);
      const formatKey = (v: number) => v.toFixed(2);
      const items = discovered.map((d) => {
        const key = formatKey(d.face_value);
        const m = mapping.get(key);
        return {
          face_value: d.face_value,
          times_used: d.times_used,
          total_value: d.total_value,
          first_seen: d.first_seen,
          last_seen: d.last_seen,
          channels: m?.channels || [],
          ignored: m?.ignored || false,
          note: m?.note || "",
          mapped: !!m,
        };
      });
      const knownKeys = new Set(discovered.map((d) => formatKey(d.face_value)));
      for (const [key, m] of mapping.entries()) {
        if (!knownKeys.has(key)) {
          items.push({
            face_value: parseFloat(key),
            times_used: 0,
            total_value: 0,
            first_seen: null,
            last_seen: null,
            channels: m.channels,
            ignored: m.ignored,
            note: m.note || "",
            mapped: true,
          });
        }
      }
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/funtopia/voucher-mappings", async (req, res, next) => {
    try {
      const { upsertVoucherChannelMapping, clearAllFuntopiaSummaryCache } = await import("./funtopia");
      const { face_value, channel, channels, ignored, note } = req.body || {};
      const fv = typeof face_value === "number" ? face_value : parseFloat(face_value);
      if (!isFinite(fv) || fv <= 0) {
        return res.status(400).json({ message: "face_value must be a positive number" });
      }
      const isIgnored = !!ignored;
      // Accept either `channels: string[]` (preferred) or legacy `channel: string`
      let cleanChannels: string[] = [];
      if (Array.isArray(channels)) {
        cleanChannels = channels.map((c) => String(c || "").trim()).filter((c) => c.length > 0);
      } else if (typeof channel === "string" && channel.trim().length > 0) {
        cleanChannels = [channel.trim()];
      }
      if (!isIgnored && cleanChannels.length === 0) {
        return res.status(400).json({ message: "At least one channel is required unless ignored=true" });
      }
      await upsertVoucherChannelMapping(fv, cleanChannels, isIgnored, typeof note === "string" ? note : null);
      const cleared = await clearAllFuntopiaSummaryCache();
      res.json({ success: true, cacheCleared: cleared });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/funtopia/wallet-passes/backfill", async (req, res, next) => {
    try {
      const { backfillWalletPasses, isFuntopiaConfigured } = await import("./funtopia");
      if (!isFuntopiaConfigured()) {
        return res.status(503).json({ message: "Funtopia POS not configured" });
      }
      const parsePositiveInt = (
        raw: unknown,
        fallback: number,
        max: number,
        label: string,
      ): number | { error: string } => {
        if (raw === undefined || raw === null || raw === "") return fallback;
        const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) {
          return { error: `${label} must be an integer between 1 and ${max}` };
        }
        return n;
      };
      const maxDates = parsePositiveInt(req.body?.maxDates, 200, 5000, "maxDates");
      const daysBack = parsePositiveInt(req.body?.daysBack, 365, 3650, "daysBack");
      if (typeof maxDates !== "number") return res.status(400).json({ message: maxDates.error });
      if (typeof daysBack !== "number") return res.status(400).json({ message: daysBack.error });
      const result = await backfillWalletPasses({ maxDates, daysBack });
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/funtopia/voucher-mappings/seed", async (_req, res, next) => {
    try {
      const { seedInitialVoucherChannelMappings, clearAllFuntopiaSummaryCache } = await import("./funtopia");
      const result = await seedInitialVoucherChannelMappings();
      const cleared = result.seeded > 0 ? await clearAllFuntopiaSummaryCache() : 0;
      res.json({ success: true, ...result, cacheCleared: cleared });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/funtopia/voucher-mappings/:faceValue", async (req, res, next) => {
    try {
      const { deleteVoucherChannelMapping, clearAllFuntopiaSummaryCache } = await import("./funtopia");
      const fv = parseFloat(req.params.faceValue);
      if (!isFinite(fv) || fv <= 0) {
        return res.status(400).json({ message: "face_value must be a positive number" });
      }
      await deleteVoucherChannelMapping(fv);
      const cleared = await clearAllFuntopiaSummaryCache();
      res.json({ success: true, cacheCleared: cleared });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/funtopia/regenerate", async (req, res, next) => {
    try {
      const { regenerateSummaries, isFuntopiaConfigured } = await import("./funtopia");
      if (!isFuntopiaConfigured()) {
        return res.status(503).json({ message: "Funtopia POS not configured" });
      }
      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        return res.status(400).json({ message: "startDate and endDate required" });
      }
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return res.status(400).json({ message: "Dates must be in YYYY-MM-DD format" });
      }
      const result = await regenerateSummaries(startDate, endDate);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/funtopia/sync", async (req, res, next) => {
    try {
      console.log(`[Funtopia Sync] POST /api/funtopia/sync body:`, JSON.stringify(req.body));
      const { syncDateRange, buildSyncDateRange, isFuntopiaConfigured, setSyncMeta } = await import("./funtopia");
      const { mode, start, end } = req.body || {};
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
      const yesterday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() - 86400000));

      // Validate before configuration/status checks so malformed full-sync
      // requests cannot receive an already-running response or start any work.
      if (mode === "full") {
        const startDate = start || "2026-01-01";
        const endDate = end || today;
        try {
          buildSyncDateRange(startDate, endDate);
        } catch (rangeErr: any) {
          return res.status(400).json({ message: rangeErr?.message || "Invalid sync date range" });
        }
      }

      if (!isFuntopiaConfigured()) {
        console.log(`[Funtopia Sync] Not configured!`);
        return res.status(503).json({ message: "Funtopia POS not configured" });
      }

      if (funtopiaSyncState.running) {
        return res.json({
          success: true,
          mode: funtopiaSyncState.mode,
          status: "already_running",
          progress: funtopiaSyncState.progress,
          syncStartDate: funtopiaSyncState.syncStartDate,
          syncEndDate: funtopiaSyncState.syncEndDate,
          totalDays: funtopiaSyncState.totalDays,
          syncedDays: funtopiaSyncState.syncedDays,
          eta: funtopiaSyncState.eta,
        });
      }

      if (mode === "quick") {
        const { getPushProtectionStatus } = await import("./funtopia");
        const pushProtection = await getPushProtectionStatus();
        if (pushProtection.protected) {
          console.log(`[Funtopia Sync] Quick sync blocked: push protection active (${pushProtection.minutesRemaining}m remaining)`);
          return res.json({
            success: true,
            mode: "quick",
            status: "push_protected",
            message: `Quick sync skipped: data was pushed to production ${pushProtection.minutesRemaining} minutes ago. Protection expires in ${pushProtection.minutesRemaining} minute(s).`,
            lastPushAt: pushProtection.lastPushAt,
            minutesRemaining: pushProtection.minutesRemaining,
          });
        }
        console.log(`[Funtopia Sync] Quick sync: ${yesterday} → ${today}`);
        const result = await syncDateRange(yesterday, today, true, undefined, "quick");
        await setSyncMeta("quick");
        return res.json({ success: true, mode: "quick", ...result });
      }

      if (mode === "full") {
        const startDate = start || "2026-01-01";
        const endDate = end || today;
        const forceAll = req.body.force === true;

        const { getPushProtectionStatus } = await import("./funtopia");
        const pushProtection = await getPushProtectionStatus();
        let pushWarning: string | null = null;
        if (pushProtection.protected && !forceAll) {
          console.log(`[Funtopia Sync] Full sync blocked: push protection active (${pushProtection.minutesRemaining}m remaining). Use force:true to override.`);
          return res.json({
            success: true,
            mode: "full",
            status: "push_protected",
            message: `Full sync blocked: data was pushed to production ${pushProtection.minutesRemaining} minute(s) ago. Use forced sync to override.`,
            lastPushAt: pushProtection.lastPushAt,
            minutesRemaining: pushProtection.minutesRemaining,
          });
        }
        if (pushProtection.protected && forceAll) {
          pushWarning = `Warning: data was pushed to production ${pushProtection.minutesRemaining}m ago. Forced sync will proceed but may overwrite pushed data.`;
          console.log(`[Funtopia Sync] ${pushWarning}`);
        }

        funtopiaSyncState.running = true;
        funtopiaSyncState.mode = "full";
        funtopiaSyncState.startedAt = new Date().toISOString();
        funtopiaSyncState.progress = `Starting full sync: ${startDate} → ${endDate}${forceAll ? " (forced)" : ""}`;
        funtopiaSyncState.error = null;
        funtopiaSyncState.warnings = [];
        funtopiaSyncState.skippedDates = [];
        funtopiaSyncState.totalDays = 0;
        funtopiaSyncState.syncedDays = 0;
        funtopiaSyncState.eta = "";
        funtopiaSyncState.syncStartDate = startDate;
        funtopiaSyncState.syncEndDate = endDate;

        res.json({ success: true, mode: "full", status: "started", message: `Full sync started: ${startDate} → ${endDate}${forceAll ? " (forced)" : ""}`, pushWarning });

        (async () => {
          try {
            console.log(`[Funtopia Sync] Background task starting: startDate="${startDate}" endDate="${endDate}"`);
            const { syncDateRange: syncFn, setSyncMeta: setMeta } = await import("./funtopia");
            const result = await syncFn(startDate, endDate, forceAll, (msg: string) => {
              funtopiaSyncState.progress = msg;
              const daysMatch = msg.match(/(\d+)\/(\d+) days done/);
              if (daysMatch) {
                funtopiaSyncState.syncedDays = parseInt(daysMatch[1]);
                funtopiaSyncState.totalDays = parseInt(daysMatch[2]);
              }
              const etaMatch = msg.match(/(~\d+[ms] left)/);
              if (etaMatch) {
                funtopiaSyncState.eta = etaMatch[1];
              }
            }, "full", req.body?.exactReportDates === true);
            await setMeta("full");
            funtopiaSyncState.lastResult = result;
            funtopiaSyncState.warnings = result.warnings || [];
            funtopiaSyncState.skippedDates = result.skippedDates || [];
            const warnCount = (result.warnings || []).length;
            const skipCount = (result.skippedDates || []).length;
            const warnSuffix = warnCount > 0 ? ` (${warnCount} warning(s), ${skipCount} date(s) skipped)` : "";
            funtopiaSyncState.progress = `Completed: synced ${result.synced} days${warnSuffix}`;
            console.log(`[Funtopia Sync] Full sync completed: ${result.synced} days synced${warnSuffix}`);
          } catch (err: any) {
            funtopiaSyncState.error = err.message || "Unknown error";
            funtopiaSyncState.progress = `Failed: ${err.message || "Unknown error"}`;
            console.error(`[Funtopia Sync] Full sync failed:`, err);
          } finally {
            funtopiaSyncState.running = false;
          }
        })();

        return;
      }

      return res.status(400).json({ message: "Invalid mode. Use 'quick' or 'full'" });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/sync-progress", async (_req, res) => {
    res.json({
      running: funtopiaSyncState.running,
      mode: funtopiaSyncState.mode,
      startedAt: funtopiaSyncState.startedAt,
      progress: funtopiaSyncState.progress,
      error: funtopiaSyncState.error,
      lastResult: funtopiaSyncState.lastResult,
      totalDays: funtopiaSyncState.totalDays,
      syncedDays: funtopiaSyncState.syncedDays,
      eta: funtopiaSyncState.eta,
      syncStartDate: funtopiaSyncState.syncStartDate,
      syncEndDate: funtopiaSyncState.syncEndDate,
      warnings: funtopiaSyncState.warnings,
      skippedDates: funtopiaSyncState.skippedDates,
    });
  });

  app.get("/api/funtopia/sync-status", async (req, res, next) => {
    try {
      const { getLastSyncInfo, isFuntopiaConfigured } = await import("./funtopia");
      const syncInfo = await getLastSyncInfo();
      const apiConfigured = isFuntopiaConfigured();
      const hasCachedData = syncInfo.cachedDates > 0;
      res.json({
        ...syncInfo,
        funtopiaConnected: apiConfigured || hasCachedData,
      });
    } catch (err) {
      next(err);
    }
  });

  let funtopiaProcessRunning = false;
  let funtopiaProcessProgress = "";

  app.post("/api/funtopia/process", async (req, res, next) => {
    try {
      const { regenerateSummaries } = await import("./funtopia");
      if (funtopiaProcessRunning) {
        return res.json({ status: "already_running", progress: funtopiaProcessProgress });
      }
      const { from, to } = req.body;
      if (!from || !to) return res.status(400).json({ error: "from and to required" });

      funtopiaProcessRunning = true;
      funtopiaProcessProgress = `Starting L1→L2 processing: ${from} → ${to}`;
      res.json({ status: "started", from, to });

      (async () => {
        try {
          const result = await regenerateSummaries(from, to, (msg: string) => {
            funtopiaProcessProgress = msg;
            console.log(`[Funtopia Process] ${msg}`);
          });
          funtopiaProcessProgress = `Done: regenerated ${result.regenerated} summaries`;
          console.log(`[Funtopia Process] Complete: ${result.regenerated} summaries`);
        } catch (err: any) {
          funtopiaProcessProgress = `Error: ${err.message}`;
          console.error(`[Funtopia Process] Error:`, err);
        } finally {
          funtopiaProcessRunning = false;
        }
      })();
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/process-progress", (_req, res) => {
    res.json({ running: funtopiaProcessRunning, progress: funtopiaProcessProgress });
  });

  const funtopiaPushState = { running: false, progress: "", error: null as string | null, result: null as any };

  app.post("/api/funtopia/import-data", async (req, res, next) => {
    try {
      const { table, rows, clearFirst, fromDate, toDate } = req.body;
      const secret = req.headers["x-push-secret"];
      const expectedSecret = process.env.FUNTOPIA_CLIENT_SECRET;
      if (!secret || secret !== expectedSecret) {
        return res.status(403).json({ success: false, message: "Unauthorized" });
      }

      const ALLOWED_TABLES = ["funtopia_daily_cache", "funtopia_orders", "funtopia_daily_revenue", "funtopia_calendar_notes", "funtopia_locked_months", "papaya_daily_cache", "funtopia_raw_orders", "funtopia_raw_payments", "papaya_orders", "papaya_order_items"];
      if (!ALLOWED_TABLES.includes(table)) {
        return res.status(400).json({ success: false, message: "Invalid table" });
      }
      if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return res.json({ success: true, imported: 0 });
      }

      const { pool: localPool } = await import("./db");

      if (table === "funtopia_locked_months") {
        await localPool.query(`
          CREATE TABLE IF NOT EXISTS funtopia_locked_months (
            month TEXT PRIMARY KEY,
            locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
      }

      if (table === "papaya_daily_cache") {
        await localPool.query(`
          CREATE TABLE IF NOT EXISTS papaya_daily_cache (
            date TEXT PRIMARY KEY,
            terminal TEXT NOT NULL DEFAULT 'reception',
            synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            summary_json JSONB NOT NULL
          )
        `);
        await localPool.query(`ALTER TABLE papaya_daily_cache ADD COLUMN IF NOT EXISTS terminal TEXT NOT NULL DEFAULT 'reception'`);
        await localPool.query(`ALTER TABLE papaya_daily_cache ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
      }

      if (table === "papaya_orders") {
        await localPool.query(`
          CREATE TABLE IF NOT EXISTS papaya_orders (
            id TEXT NOT NULL,
            terminal TEXT NOT NULL DEFAULT 'reception',
            status TEXT,
            order_date TIMESTAMPTZ,
            total NUMERIC,
            bill_total NUMERIC,
            discount_total NUMERIC,
            channel_name TEXT,
            order_number TEXT,
            receipt_number TEXT,
            payments JSONB,
            applied_discounts JSONB,
            raw_json JSONB,
            synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (id, terminal)
          )
        `);
      }

      if (table === "papaya_order_items") {
        await localPool.query(`
          CREATE TABLE IF NOT EXISTS papaya_order_items (
            id SERIAL PRIMARY KEY,
            papaya_order_id TEXT NOT NULL,
            terminal TEXT NOT NULL DEFAULT 'reception',
            name TEXT,
            quantity INTEGER DEFAULT 1,
            item_total NUMERIC DEFAULT 0,
            menu_item_category_id TEXT,
            status TEXT,
            synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
      }

      if (clearFirst) {
        const { getLockedMonths, isDateInLockedMonth } = await import("./funtopia");
        const lockedMonths = await getLockedMonths();
        const dateCol = table === "funtopia_orders" ? "order_date" : "date";
        const hasDateCol = ["funtopia_daily_cache", "funtopia_orders", "funtopia_daily_revenue", "funtopia_calendar_notes"].includes(table);

        if (hasDateCol && lockedMonths.length > 0) {
          const lockedConditions = lockedMonths.map((m: string, i: number) => `"${dateCol}" NOT LIKE $${i + 1}`);
          const likePatterns = lockedMonths.map((m: string) => `${m}%`);
          await localPool.query(
            `DELETE FROM "${table}" WHERE ${lockedConditions.join(" AND ")}`,
            likePatterns
          );
          console.log(`[Funtopia Import] Cleared ${table} except locked months: ${lockedMonths.join(', ')}`);
        } else {
          await localPool.query(`DELETE FROM "${table}"`);
        }
      }

      const SERIAL_ID_TABLES = new Set([
        "funtopia_raw_orders",
        "funtopia_raw_payments",
        "funtopia_orders",
        "funtopia_daily_revenue",
        "papaya_order_items",
      ]);
      const columns = Object.keys(rows[0]).filter(c => {
        if (c === "id" && SERIAL_ID_TABLES.has(table)) return false;
        return true;
      });
      const quotedCols = columns.map(c => `"${c}"`).join(", ");

      const PK_MAP: Record<string, string | string[] | null> = {
        funtopia_daily_cache: "date",
        funtopia_orders: null,
        funtopia_daily_revenue: null,
        funtopia_calendar_notes: "date",
        funtopia_locked_months: "month",
        papaya_daily_cache: "date",
        funtopia_raw_orders: null,
        funtopia_raw_payments: null,
        papaya_orders: ["id", "terminal"],
        papaya_order_items: null,
      };
      const pk = PK_MAP[table];

      if (!clearFirst && table === "papaya_order_items" && fromDate && toDate) {
        await localPool.query(
          `DELETE FROM papaya_order_items WHERE id IN (
            SELECT oi.id FROM papaya_order_items oi
            INNER JOIN papaya_orders po ON oi.papaya_order_id = po.id AND oi.terminal = po.terminal
            WHERE po.order_date::date >= $1::date AND po.order_date::date <= $2::date
          )`,
          [fromDate, toDate]
        );
      }

      const BATCH = 50;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const placeholders: string[] = [];
        const vals: any[] = [];
        let pi = 1;

        for (const row of batch) {
          const rp: string[] = [];
          for (const col of columns) {
            let val = row[col];
            if (val !== null && typeof val === "object" && !(val instanceof Date)) {
              val = JSON.stringify(val);
            }
            vals.push(val);
            rp.push(`$${pi}`);
            pi++;
          }
          placeholders.push(`(${rp.join(", ")})`);
        }

        let conflictClause = "";
        if (pk) {
          const pkCols = Array.isArray(pk) ? pk : [pk];
          const pkSet = new Set(pkCols);
          const conflictTarget = pkCols.map(c => `"${c}"`).join(", ");
          const updateCols = columns.filter(c => !pkSet.has(c));
          if (updateCols.length > 0) {
            conflictClause = `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(", ")}`;
          } else {
            conflictClause = `ON CONFLICT (${conflictTarget}) DO NOTHING`;
          }
        }

        await localPool.query(`INSERT INTO "${table}" (${quotedCols}) VALUES ${placeholders.join(", ")} ${conflictClause}`, vals);
        inserted += batch.length;
      }

      if (table === "funtopia_daily_cache" && inserted > 0) {
        try {
          const now = new Date().toISOString();
          const metaJson = JSON.stringify({ lastFullSyncAt: now, lastQuickSyncAt: now, importedFromPush: true, lastPushAt: now });
          await localPool.query(
            `INSERT INTO funtopia_daily_cache (date, synced_at, summary_json)
             VALUES ('__meta__', NOW(), $1)
             ON CONFLICT (date) DO UPDATE SET synced_at = NOW(), summary_json = $1`,
            [metaJson]
          );
        } catch (metaErr: any) {
          console.error(`[Funtopia Import] Failed to update sync metadata:`, metaErr.message);
        }
      }

      if (table === "papaya_daily_cache" && inserted > 0) {
        try {
          await localPool.query(
            `UPDATE papaya_daily_cache SET synced_at = NOW() WHERE synced_at < NOW() - INTERVAL '1 minute'`
          );
        } catch (metaErr: any) {
          console.error(`[Funtopia Import] Failed to update papaya sync timestamps:`, metaErr.message);
        }
      }

      res.json({ success: true, imported: inserted });
    } catch (err: any) {
      console.error(`[Funtopia Import]`, err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post("/api/funtopia/wipe-data", async (req, res, next) => {
    try {
      const secret = req.headers["x-push-secret"];
      const expectedSecret = process.env.FUNTOPIA_CLIENT_SECRET;
      if (!secret || secret !== expectedSecret) {
        return res.status(403).json({ success: false, message: "Unauthorized" });
      }

      const { pool: localPool } = await import("./db");

      const TABLES_TO_WIPE = [
        "funtopia_daily_cache",
        "funtopia_raw_orders",
        "funtopia_orders",
        "funtopia_raw_payments",
        "funtopia_daily_revenue",
        "funtopia_calendar_notes",
        "funtopia_locked_months",
        "papaya_order_items",
        "papaya_orders",
        "papaya_daily_cache",
      ];

      const results: Array<{ table: string; status: string }> = [];

      for (const table of TABLES_TO_WIPE) {
        try {
          const exists = await localPool.query(
            `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
            [table]
          );
          if (!exists.rows[0]?.exists) {
            results.push({ table, status: "skipped (does not exist)" });
            continue;
          }
          await localPool.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
          results.push({ table, status: "wiped" });
        } catch (err: any) {
          results.push({ table, status: `error: ${err.message}` });
        }
      }

      const hasErrors = results.some(r => r.status.startsWith("error"));
      res.json({ success: !hasErrors, partial: hasErrors, results });
    } catch (err: any) {
      console.error(`[Funtopia Wipe]`, err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post("/api/funtopia/wipe-production", async (req, res, next) => {
    try {
      const prodUrl = req.body?.productionUrl;
      if (!prodUrl) {
        return res.status(400).json({ success: false, message: "Please enter your published app URL first." });
      }
      let parsed: URL;
      try {
        parsed = new URL(prodUrl);
      } catch {
        return res.status(400).json({ success: false, message: "Invalid URL format." });
      }
      if (parsed.protocol !== "https:") {
        return res.status(400).json({ success: false, message: "Only HTTPS URLs are allowed." });
      }
      if (!parsed.hostname.endsWith(".replit.app") && !parsed.hostname.endsWith(".repl.co")) {
        return res.status(400).json({ success: false, message: "URL must be a Replit app domain (.replit.app or .repl.co)." });
      }
      const baseUrl = prodUrl.replace(/\/+$/, "");
      const pushSecret = process.env.FUNTOPIA_CLIENT_SECRET || "";
      const resp = await fetch(`${baseUrl}/api/funtopia/wipe-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-push-secret": pushSecret },
      });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(resp.status).json(data);
      }
      res.json(data);
    } catch (err: any) {
      console.error(`[Funtopia Wipe Production]`, err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get("/api/funtopia/locked-months", async (_req, res, next) => {
    try {
      const { getLockedMonths } = await import("./funtopia");
      const months = await getLockedMonths();
      res.json({ months });
    } catch (err) { next(err); }
  });

  app.post("/api/funtopia/locked-months", async (req, res, next) => {
    try {
      const { setLockedMonths } = await import("./funtopia");
      const months: string[] = req.body?.months || [];
      await setLockedMonths(months);
      res.json({ success: true, months });
    } catch (err) { next(err); }
  });

  // task-139 (v26): Floresta product registry — read the SKU classification
  // table, manually override or clear an override. Floresta-only.
  app.get("/api/funtopia/product-registry", async (_req, res, next) => {
    try {
      const { listProductRegistry } = await import("./funtopia");
      const items = await listProductRegistry();
      const counts: Record<string, number> = {};
      for (const it of items) {
        counts[it.decisionSource] = (counts[it.decisionSource] || 0) + 1;
      }
      res.json({ items, counts, total: items.length });
    } catch (err) { next(err); }
  });

  app.post("/api/funtopia/product-registry/:key/override", async (req, res, next) => {
    try {
      const { setProductRegistryOverride } = await import("./funtopia");
      const key = req.params.key;
      const { revenueCategory, fnbSubCategory } = req.body || {};
      const VALID: string[] = [
        "Tickets & Packages", "F&B", "Events / Birthdays",
        "Nanny & Drop-off", "Merchandise", "Workshop", "Extras",
      ];
      if (!VALID.includes(revenueCategory)) {
        return res.status(400).json({ message: `revenueCategory must be one of: ${VALID.join(", ")}` });
      }
      const sub = fnbSubCategory === "Food" || fnbSubCategory === "Drinks" ? fnbSubCategory : null;
      const row = await setProductRegistryOverride(key, revenueCategory, sub);
      if (!row) return res.status(404).json({ message: "Unknown product key" });
      res.json({ success: true, item: row });
    } catch (err) { next(err); }
  });

  app.delete("/api/funtopia/product-registry/:key/override", async (req, res, next) => {
    try {
      const { clearProductRegistryOverride } = await import("./funtopia");
      const row = await clearProductRegistryOverride(req.params.key);
      if (!row) return res.status(404).json({ message: "Unknown product key" });
      res.json({ success: true, item: row });
    } catch (err) { next(err); }
  });

  app.post("/api/funtopia/push-to-production", async (req, res, next) => {
    try {
      const prodUrl = req.body?.productionUrl;
      const fromDate: string | undefined = req.body?.fromDate;
      const toDate: string | undefined = req.body?.toDate;
      if ((fromDate && !toDate) || (!fromDate && toDate)) {
        return res.status(400).json({ success: false, message: "Both fromDate and toDate must be provided for date filtering." });
      }
      const hasDateFilter = !!(fromDate && toDate);
      if (!prodUrl) {
        return res.status(400).json({ success: false, message: "Please enter your published app URL first." });
      }
      if (funtopiaPushState.running) {
        return res.json({ success: true, status: "already_running", progress: funtopiaPushState.progress });
      }

      funtopiaPushState.running = true;
      funtopiaPushState.progress = "Starting...";
      funtopiaPushState.error = null;
      funtopiaPushState.result = null;

      const dateLabel = hasDateFilter ? ` (${fromDate} → ${toDate})` : "";
      res.json({ success: true, status: "started", message: `Pushing Funtopia data to production${dateLabel}...` });

      (async () => {
        const { pool: devPool } = await import("./db");
        const pushSecret = process.env.FUNTOPIA_CLIENT_SECRET || "";
        const baseUrl = prodUrl.replace(/\/+$/, "");

        const DATE_COL_MAP: Record<string, string> = {
          funtopia_daily_cache: "date",
          funtopia_daily_revenue: "date",
          funtopia_calendar_notes: "date",
          funtopia_raw_orders: "order_date",
          funtopia_raw_payments: "order_date",
          funtopia_orders: "order_date",
          papaya_orders: "order_date",
          papaya_daily_cache: "date",
        };

        const TABLES = [
          { name: "funtopia_raw_orders", clearFirst: true },
          { name: "funtopia_raw_payments", clearFirst: true },
          { name: "funtopia_daily_cache", clearFirst: true },
          { name: "funtopia_daily_revenue", clearFirst: true },
          { name: "funtopia_calendar_notes", clearFirst: true },
          { name: "funtopia_orders", clearFirst: true },
          { name: "funtopia_locked_months", clearFirst: true },
          { name: "papaya_orders", clearFirst: true },
          { name: "papaya_order_items", clearFirst: true },
          { name: "papaya_daily_cache", clearFirst: true },
        ];

        try {
          let totalRows = 0;
          const tableResults: Array<{ name: string; rows: number; status: string }> = [];
          const failedTables: string[] = [];

          const { fixCachedRevenue } = await import("./funtopia");

          funtopiaPushState.progress = `Pre-fixing funtopia_daily_cache revenue from L1 data${dateLabel}...`;
          let prefixStatus = "OK";
          try {
            let prefixQuery = `SELECT date, summary_json FROM funtopia_daily_cache WHERE date != '__meta__'`;
            const prefixParams: string[] = [];
            if (hasDateFilter) {
              prefixQuery += ` AND date >= $1 AND date <= $2`;
              prefixParams.push(fromDate!, toDate!);
            }
            const cacheResult = await devPool.query(prefixQuery, prefixParams);
            let fixedCount = 0;
            const { setCachedSummary } = await import("./funtopia");
            for (const row of cacheResult.rows) {
              const summary = row.summary_json;
              if (summary && summary.date) {
                const oldRevenue = summary.totalRevenue;
                await fixCachedRevenue(summary);
                if (Math.abs((summary.totalRevenue || 0) - (oldRevenue || 0)) > 0.01) {
                  await setCachedSummary(summary.date, summary);
                }
                fixedCount++;
              }
            }
            funtopiaPushState.progress = `Pre-fixed ${fixedCount} summaries. Starting push...`;
          } catch (fixErr: any) {
            prefixStatus = `FAILED: ${fixErr.message}`;
            funtopiaPushState.progress = `Pre-fix failed (${fixErr.message}), continuing push...`;
          }

          for (let ti = 0; ti < TABLES.length; ti++) {
            const table = TABLES[ti];
            funtopiaPushState.progress = `Reading ${table.name} (${ti + 1}/${TABLES.length})...`;

            let rows: any[];
            try {
              const devClient = await devPool.connect();
              try {
                let selectQuery = `SELECT * FROM "${table.name}"`;
                const queryParams: string[] = [];
                const dateCol = DATE_COL_MAP[table.name];
                if (hasDateFilter && dateCol) {
                  const isTimestamp = table.name === "papaya_orders";
                  if (isTimestamp) {
                    selectQuery += ` WHERE "${dateCol}"::date >= $1::date AND "${dateCol}"::date <= $2::date`;
                  } else {
                    selectQuery += ` WHERE "${dateCol}" >= $1 AND "${dateCol}" <= $2`;
                  }
                  queryParams.push(fromDate!, toDate!);
                } else if (hasDateFilter && table.name === "papaya_order_items") {
                  selectQuery = `SELECT oi.* FROM papaya_order_items oi INNER JOIN papaya_orders po ON oi.papaya_order_id = po.id AND oi.terminal = po.terminal WHERE po.order_date::date >= $1::date AND po.order_date::date <= $2::date`;
                  queryParams.push(fromDate!, toDate!);
                }
                const result = await devClient.query(selectQuery, queryParams);
                rows = result.rows;
              } finally {
                devClient.release();
              }
            } catch (readErr: any) {
              failedTables.push(table.name);
              tableResults.push({ name: table.name, rows: 0, status: `FAILED: ${readErr.message}` });
              continue;
            }

            if (rows.length === 0) {
              tableResults.push({ name: table.name, rows: 0, status: "skipped (empty)" });
              continue;
            }

            const CHUNK = table.name === "funtopia_daily_cache" || table.name === "papaya_daily_cache" ? 10 : 100;
            let sent = 0;
            let tableFailed = false;
            for (let i = 0; i < rows.length; i += CHUNK) {
              const chunk = rows.slice(i, i + CHUNK);
              funtopiaPushState.progress = `Pushing ${table.name}: ${sent}/${rows.length} rows (${ti + 1}/${TABLES.length})`;

              let resp: Response | null = null;
              for (let retry = 0; retry < 5; retry++) {
                resp = await fetch(`${baseUrl}/api/funtopia/import-data`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-push-secret": pushSecret },
                  body: JSON.stringify({
                    table: table.name,
                    rows: chunk,
                    clearFirst: !hasDateFilter && table.clearFirst && i === 0,
                    ...(hasDateFilter && table.name === "papaya_order_items" && i === 0 ? { fromDate, toDate } : {}),
                  }),
                });
                if (resp.ok || (resp.status !== 429 && resp.status !== 503)) break;
                const wait = Math.min(2000 * Math.pow(2, retry), 30000);
                await new Promise(r => setTimeout(r, wait));
              }

              if (!resp || !resp.ok) {
                const errBody = resp ? await resp.text() : "No response";
                failedTables.push(table.name);
                tableResults.push({ name: table.name, rows: sent, status: `FAILED at row ${sent}: ${resp?.status}` });
                tableFailed = true;
                break;
              }

              const result = await resp.json();
              sent += chunk.length;
              await new Promise(r => setTimeout(r, 200));
            }

            if (!tableFailed) {
              totalRows += sent;
              tableResults.push({ name: table.name, rows: sent, status: "OK" });
            }
          }

          funtopiaPushState.result = { totalRows, tables: TABLES.length, tableResults, failedTables, prefixStatus };
          if (failedTables.length > 0) {
            funtopiaPushState.progress = `Done with errors! ${totalRows} rows pushed${dateLabel}. Failed tables: ${failedTables.join(", ")}`;
            funtopiaPushState.error = `Failed to push: ${failedTables.join(", ")}`;
          } else {
            funtopiaPushState.progress = `Done! ${totalRows} total rows pushed across ${TABLES.length} tables${dateLabel}`;
            try {
              const { setLastPushTimestamp } = await import("./funtopia");
              await setLastPushTimestamp();
            } catch (e) {}
          }
        } catch (err: any) {
          funtopiaPushState.error = err.message || "Unknown error";
          funtopiaPushState.progress = `Failed: ${err.message}`;
        } finally {
          funtopiaPushState.running = false;
        }
      })();

      return;
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/push-progress", async (_req, res) => {
    res.json({
      running: funtopiaPushState.running,
      progress: funtopiaPushState.progress,
      error: funtopiaPushState.error,
      result: funtopiaPushState.result,
    });
  });

  app.get("/api/funtopia/debug-products", async (req, res, next) => {
    try {
      const { getDailyProductDump, isFuntopiaConfigured } = await import("./funtopia");
      if (!isFuntopiaConfigured()) {
        return res.status(503).json({ message: "Funtopia POS not configured" });
      }
      const date = (req.query.date as string) || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
      const dump = await getDailyProductDump(date);
      res.json(dump);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/hourly-compare", async (req, res, next) => {
    try {
      const { getDailySummary, isFuntopiaConfigured } = await import("./funtopia");
      if (!isFuntopiaConfigured()) {
        return res.status(503).json({ message: "Funtopia POS not configured" });
      }
      const date = req.query.date as string;
      if (!date) {
        return res.status(400).json({ message: "date query param required (YYYY-MM-DD)" });
      }
      const summary = await getDailySummary(date);
      if (!summary) {
        return res.status(404).json({ message: `No data for ${date}` });
      }
      res.json({
        date,
        hourlyBreakdown: summary.hourlyBreakdown,
        totalOrders: summary.totalOrders,
        totalRevenue: summary.totalRevenue,
      });
    } catch (err) {
      next(err);
    }
  });

  // task-134: Events tab. Read-only flat list of birthday/event rows
  // across one or both branches for [from, to]. Never triggers a sync.
  app.get("/api/events/range", async (req, res, next) => {
    try {
      const from = (req.query.from || req.query.start) as string;
      const to = (req.query.to || req.query.end) as string;
      const branch = ((req.query.branch as string) || "all").toLowerCase();
      if (!from || !to) {
        return res.status(400).json({ error: "from and to required" });
      }
      if (branch !== "all" && branch !== "floresta" && branch !== "chalong") {
        return res.status(400).json({ error: "branch must be 'floresta', 'chalong', or 'all'" });
      }
      const wantFloresta = branch === "all" || branch === "floresta";
      const wantChalong = branch === "all" || branch === "chalong";
      const promises: Array<Promise<any[]>> = [];
      if (wantFloresta) {
        const { getFlorestaEventsRange, isFuntopiaConfigured } = await import("./funtopia");
        if (isFuntopiaConfigured()) promises.push(getFlorestaEventsRange(from, to));
        else promises.push(Promise.resolve([]));
      }
      if (wantChalong) {
        const { getChalongEventsRange, isPapayaConfigured } = await import("./papaya");
        if (isPapayaConfigured()) promises.push(getChalongEventsRange(from, to));
        else promises.push(Promise.resolve([]));
      }
      const results = await Promise.all(promises);
      const events = results
        .flat()
        .sort((a: any, b: any) =>
          a.date === b.date
            ? String(a.partyOrderCode).localeCompare(String(b.partyOrderCode))
            : a.date.localeCompare(b.date),
        );
      res.json({ from, to, branch, events });
    } catch (err) {
      next(err);
    }
  });

  // task-134 (manual linker): list F&B-candidate orders for a party on a date.
  app.get("/api/events/candidates", async (req, res, next) => {
    try {
      const date = String(req.query.date || "");
      const partyOrderCode = String(req.query.partyOrderCode || "");
      const branch = String(req.query.branch || "floresta").toLowerCase();
      if (!date || !partyOrderCode) {
        return res.status(400).json({ error: "date and partyOrderCode required" });
      }
      if (branch !== "floresta") {
        return res.status(400).json({ error: "manual linker only supported for Floresta today" });
      }
      const { getFlorestaEventCandidates, isFuntopiaConfigured } = await import("./funtopia");
      if (!isFuntopiaConfigured()) return res.json({ candidates: [] });
      const candidates = await getFlorestaEventCandidates(date, partyOrderCode);
      res.json({ date, partyOrderCode, candidates });
    } catch (err) {
      next(err);
    }
  });

  // task-134 (manual linker): attach an F&B order to a party order.
  app.post("/api/events/link", async (req, res, next) => {
    try {
      const { date, fnbOrderCode, partyOrderCode, branch } = req.body || {};
      if (!date || !fnbOrderCode || !partyOrderCode) {
        return res.status(400).json({ error: "date, fnbOrderCode, partyOrderCode required" });
      }
      if (branch && String(branch).toLowerCase() !== "floresta") {
        return res.status(400).json({ error: "manual linker only supported for Floresta today" });
      }
      const { upsertFuntopiaBirthdayOverride, rebuildFlorestaCacheForDate } = await import("./funtopia");
      await upsertFuntopiaBirthdayOverride({
        orderCode: String(fnbOrderCode),
        orderDate: String(date),
        partyOrderCode: String(partyOrderCode),
        note: "manual linker (events tab)",
      });
      await rebuildFlorestaCacheForDate(String(date));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // task-134 (manual linker): remove a manual link.
  app.delete("/api/events/link", async (req, res, next) => {
    try {
      const { date, fnbOrderCode, branch } = req.body || {};
      if (!date || !fnbOrderCode) {
        return res.status(400).json({ error: "date and fnbOrderCode required" });
      }
      if (branch && String(branch).toLowerCase() !== "floresta") {
        return res.status(400).json({ error: "manual linker only supported for Floresta today" });
      }
      const { deleteFuntopiaBirthdayOverride, rebuildFlorestaCacheForDate } = await import("./funtopia");
      await deleteFuntopiaBirthdayOverride({
        orderCode: String(fnbOrderCode),
        orderDate: String(date),
      });
      await rebuildFlorestaCacheForDate(String(date));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/range", async (req, res, next) => {
    try {
      const { getDateRangeSummary, isFuntopiaConfigured, getCashReportsDailyTotals } = await import("./funtopia");
      const { pool: localPool } = await import("./db");

      const startDate = req.query.start as string;
      const endDate = req.query.end as string;
      if (!startDate || !endDate) {
        return res.status(400).json({ message: "start and end query params required" });
      }

      if (!isFuntopiaConfigured()) {
        try {
          const cacheCheck = await localPool.query(
            "SELECT COUNT(*) as cnt FROM funtopia_daily_cache WHERE date != '__meta__'"
          );
          if (parseInt(cacheCheck.rows[0]?.cnt || "0") === 0) {
            return res.status(503).json({ message: "Funtopia POS not configured and no cached data" });
          }
        } catch {
          return res.status(503).json({ message: "Funtopia POS not configured" });
        }
      }

      const response = await dashboardRangeCache.getOrLoad(
        `floresta:${startDate}:${endDate}`,
        async () => {
          const [data, cashTotals] = await Promise.all([
            getDateRangeSummary(startDate, endDate),
            getCashReportsDailyTotals(startDate, endDate),
          ]);
          // getDateRangeSummary already returns categoryBreakdown stamped to the
          // current allocation, plus the total moved amount.
          return compactDashboardRange({
            ...data,
            cashReportsDailyTotals: cashTotals,
          });
        },
      );
      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // Lightweight endpoint for the Calendar tab heatmap. Reads daily cached
  // totals straight from funtopia_daily_cache (one SQL query) plus the manual
  // cash reports, with no per-day fix/reclassify/backfill passes and no
  // aggregateDailySummaries merge. Returns only the slim shape the heatmap
  // actually consumes.
  app.get("/api/funtopia/calendar-range", async (req, res, next) => {
    try {
      const { isFuntopiaConfigured, getCashReportsDailyTotals, getDailySummary } = await import("./funtopia");
      const { pool: localPool } = await import("./db");

      const startDate = req.query.start as string;
      const endDate = req.query.end as string;
      if (!startDate || !endDate) {
        return res.status(400).json({ message: "start and end query params required" });
      }

      if (!isFuntopiaConfigured()) {
        try {
          const cacheCheck = await localPool.query(
            "SELECT COUNT(*) as cnt FROM funtopia_daily_cache WHERE date != '__meta__'"
          );
          if (parseInt(cacheCheck.rows[0]?.cnt || "0") === 0) {
            return res.json({ dailyRevenue: [], cashReportsDailyTotals: [] });
          }
        } catch {
          return res.json({ dailyRevenue: [], cashReportsDailyTotals: [] });
        }
      }

      const [rangeRes, cashTotals] = await Promise.all([
        localPool.query(
          // Read raw NULL when a key is missing so we can detect incomplete
          // cache rows and fall back to the heavy per-day path for parity.
          `SELECT date,
                  (summary_json->>'totalRevenue')::float AS revenue,
                  (summary_json->>'totalOrders')::int AS orders
           FROM funtopia_daily_cache
           WHERE date >= $1 AND date <= $2 AND date != '__meta__'
           ORDER BY date ASC`,
          [startDate, endDate],
        ),
        getCashReportsDailyTotals(startDate, endDate),
      ]);

      const fallbackDates: string[] = [];
      const dailyRevenue: Array<{ date: string; revenue: number; orders: number }> = [];
      for (const r of rangeRes.rows) {
        const date = r.date as string;
        if (r.revenue === null || r.orders === null) {
          fallbackDates.push(date);
          continue;
        }
        dailyRevenue.push({
          date,
          revenue: Number(r.revenue) || 0,
          orders: Number(r.orders) || 0,
        });
      }

      if (fallbackDates.length > 0) {
        console.warn(`[calendar-range/funtopia] ${fallbackDates.length} day(s) missing cached totals; running heavy fallback for parity: ${fallbackDates.join(", ")}`);
        const recovered = await Promise.all(fallbackDates.map((d) => getDailySummary(d).catch(() => null)));
        for (let i = 0; i < fallbackDates.length; i++) {
          const s = recovered[i];
          if (s) {
            dailyRevenue.push({
              date: fallbackDates[i],
              revenue: Number(s.totalRevenue) || 0,
              orders: Number(s.totalOrders) || 0,
            });
          }
        }
        dailyRevenue.sort((a, b) => a.date.localeCompare(b.date));
      }

      res.json({ dailyRevenue, cashReportsDailyTotals: cashTotals });
    } catch (err) {
      next(err);
    }
  });

  // Lightweight endpoint for the Calendar tab heatmap (Papaya). Sums totals
  // across terminals per date with a single SQL query. Skips the heavy
  // per-day reconciliation done by getCombinedPapayaDateRangeSummary.
  app.get("/api/papaya/calendar-range", async (_req, res, next) => {
    try {
      const { pool: localPool } = await import("./db");
      const { getCombinedPapayaDateRangeSummary } = await import("./papaya");

      const startDate = (_req.query.from || _req.query.start) as string;
      const endDate = (_req.query.to || _req.query.end) as string;
      if (!startDate || !endDate) {
        return res.status(400).json({ message: "from/start and to/end query params required" });
      }

      try {
        const cacheCheck = await localPool.query(
          "SELECT COUNT(*) as cnt FROM papaya_daily_cache WHERE date != '__meta__'"
        );
        if (parseInt(cacheCheck.rows[0]?.cnt || "0") === 0) {
          return res.json({ dailyRevenue: [] });
        }
      } catch {
        return res.json({ dailyRevenue: [] });
      }

      // papaya_daily_cache key is `${terminal}:${date}`. Sum across terminals.
      // Track NULL fields per row so we can fall back to the heavy combined
      // path for any incomplete dates.
      const result = await localPool.query(
        `SELECT SUBSTRING(date FROM POSITION(':' IN date) + 1) AS day,
                SUM((summary_json->>'totalRevenue')::float) AS revenue,
                SUM((summary_json->>'totalOrders')::int) AS orders,
                BOOL_OR((summary_json->>'totalRevenue') IS NULL OR (summary_json->>'totalOrders') IS NULL) AS has_missing
         FROM papaya_daily_cache
         WHERE date != '__meta__'
           AND POSITION(':' IN date) > 0
           AND SUBSTRING(date FROM POSITION(':' IN date) + 1) >= $1
           AND SUBSTRING(date FROM POSITION(':' IN date) + 1) <= $2
         GROUP BY day
         ORDER BY day ASC`,
        [startDate, endDate],
      );

      const fallbackDates: string[] = [];
      const dailyRevenue: Array<{ date: string; revenue: number; orders: number }> = [];
      for (const r of result.rows) {
        if (r.has_missing) {
          fallbackDates.push(r.day as string);
          continue;
        }
        dailyRevenue.push({
          date: r.day as string,
          revenue: Number(r.revenue) || 0,
          orders: Number(r.orders) || 0,
        });
      }

      if (fallbackDates.length > 0) {
        console.warn(`[calendar-range/papaya] ${fallbackDates.length} day(s) missing cached totals; running heavy fallback for parity: ${fallbackDates.join(", ")}`);
        for (const d of fallbackDates) {
          try {
            const summaries = await getCombinedPapayaDateRangeSummary(d, d);
            for (const s of summaries) {
              dailyRevenue.push({
                date: s.date,
                revenue: Number(s.totalRevenue) || 0,
                orders: Number(s.totalOrders) || 0,
              });
            }
          } catch {}
        }
        dailyRevenue.sort((a, b) => a.date.localeCompare(b.date));
      }

      res.json({ dailyRevenue });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/cash-reports", async (req, res, next) => {
    try {
      const { getCashReports } = await import("./funtopia");
      const startDate = req.query.start as string || "2026-01-01";
      const endDate = req.query.end as string || "2026-12-31";
      const data = await getCashReports(startDate, endDate);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/funtopia/seed-cash-reports", async (req, res, next) => {
    try {
      const { seedCashReports } = await import("./funtopia");
      const result = await seedCashReports();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/funtopia/calendar-notes", async (req, res, next) => {
    try {
      const { getCalendarNotes } = await import("./funtopia");
      const start = req.query.start as string;
      const end = req.query.end as string;
      if (!start || !end) return res.status(400).json({ error: "start and end required" });
      const notes = await getCalendarNotes(start, end);
      res.json(notes);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/funtopia/calendar-notes", async (req, res, next) => {
    try {
      const { saveCalendarNote } = await import("./funtopia");
      const { date, note } = req.body;
      if (!date) return res.status(400).json({ error: "date required" });
      await saveCalendarNote(date, note || "");
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Pace forecast snapshots (forecast accuracy tracking) -----------------
  let paceSnapshotTableReady = false;
  async function ensurePaceSnapshotTable() {
    if (paceSnapshotTableReady) return;
    const { pool: localPool } = await import("./db");
    await localPool.query(`
      CREATE TABLE IF NOT EXISTS pace_forecast_snapshots (
        date TEXT NOT NULL,
        branch TEXT NOT NULL,
        month TEXT NOT NULL,
        forecast_revenue NUMERIC NOT NULL,
        revenue_to_date NUMERIC NOT NULL DEFAULT 0,
        elapsed_days INTEGER NOT NULL DEFAULT 0,
        target NUMERIC,
        model TEXT,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (date, branch)
      )
    `);
    paceSnapshotTableReady = true;
  }

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
      await ensurePaceSnapshotTable();
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
      await ensurePaceSnapshotTable();
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

  app.post("/api/funtopia/trends", async (req, res, next) => {
    try {
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const { question, history } = req.body;
      if (!question) return res.status(400).json({ error: "question required" });

      const { getAllDailySummaries } = await import("./funtopia");
      // getAllDailySummaries already stamps each summary's categoryBreakdown
      // to the current floresta birthday allocation.
      const allSummaries = await getAllDailySummaries();

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

      const systemPrompt = `You are OTO Radar — the business intelligence assistant for OTO Play Park (Funtopia), an indoor kids' adventure playground at Central Phuket Floresta. Currency: Thai Baht (฿). Today is ${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date())}.
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
      console.error("[Funtopia Trends] Error:", err);
      next(err);
    }
  });

  app.post("/api/funtopia/trends-parse", async (req, res, next) => {
    try {
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

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

  app.post("/api/funtopia/chart-builder", async (req, res, next) => {
    try {
      const { getAllDailySummaries } = await import("./funtopia");
      const { getAllPapayaDailySummaries } = await import("./papaya");
      const { metrics, groupBy, chartType, dateFrom, dateTo, aggregation, branches } = req.body;

      if (!metrics || !Array.isArray(metrics) || metrics.length === 0) {
        return res.status(400).json({ error: "metrics array required" });
      }

      const branchSet = new Set(branches || ["floresta"]);
      let allSummaries: Array<{ date: string; summary: any }> = [];
      if (branchSet.has("floresta")) {
        // Already stamped to the current allocation.
        const fSummaries = await getAllDailySummaries();
        allSummaries.push(...(fSummaries || []));
      }
      if (branchSet.has("chalong")) {
        const pSummaries = await getAllPapayaDailySummaries();
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
  // SYNC STATUS
  // ============================================

  app.get("/api/sync-status/overview", async (_req, res, next) => {
    try {
      const { isFuntopiaConfigured, getLastSyncInfo } = await import("./funtopia");
      const { isPapayaConfigured, getPapayaSyncStatus } = await import("./papaya");

      const sources: Array<{
        id: string;
        name: string;
        connected: boolean;
        lastSyncedAt: string | null;
        earliestDate: string | null;
        latestDate: string | null;
        syncType: string;
        cachedDays?: number;
        totalOrders?: number;
        lastSyncStatus?: string | null;
        subSources?: Array<{ name: string; connected: boolean }>;
        error?: string;
      }> = [];

      try {
        const funtopiaApiConnected = isFuntopiaConfigured();
        const info = await getLastSyncInfo();
        const hasFuntopiaData = info.cachedDates > 0;
        sources.push({
          id: "funtopia",
          name: "Floresta",
          connected: funtopiaApiConnected || hasFuntopiaData,
          lastSyncedAt: info.lastSyncedAt,
          earliestDate: info.earliestDate,
          latestDate: info.latestDate,
          syncType: info.lastFullSyncAt ? "Full" : (info.cachedDates > 0 ? "Cached" : "None"),
          cachedDays: info.cachedDates,
          totalOrders: info.totalRawOrders,
        });
      } catch (err) {
        sources.push({ id: "funtopia", name: "Floresta", connected: false, lastSyncedAt: null, earliestDate: null, latestDate: null, syncType: "None", cachedDays: 0, totalOrders: 0, error: "Failed to query status" });
      }

      try {
        const papayaApiConnected = isPapayaConfigured();
        const status = await getPapayaSyncStatus();
        const hasPapayaData = status.cachedDays > 0;
        sources.push({
          id: "papaya",
          name: "Chalong",
          connected: papayaApiConnected || hasPapayaData,
          lastSyncedAt: status.lastSyncedAt,
          earliestDate: status.earliestDate,
          latestDate: status.latestDate,
          syncType: status.cachedDays > 0 ? "Cached" : "None",
          cachedDays: status.cachedDays,
          totalOrders: status.totalOrders,
          subSources: [
            { name: "Reception", connected: status.receptionConnected },
            { name: "Cafe", connected: status.restaurantConnected },
          ],
        });
      } catch (err) {
        sources.push({ id: "papaya", name: "Chalong", connected: false, lastSyncedAt: null, earliestDate: null, latestDate: null, syncType: "None", cachedDays: 0, totalOrders: 0, error: "Failed to query status" });
      }

      res.json({ sources });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/sync-status/calendar", async (req, res, next) => {
    try {
      const { year, month } = req.query;
      if (!year || !month) return res.status(400).json({ error: "year and month required" });

      const y = parseInt(year as string);
      const m = parseInt(month as string);
      const startDate = `${y}-${String(m).padStart(2, "0")}-01`;
      const daysInMonth = new Date(y, m, 0).getDate();
      const endDate = `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

      const coverage: Record<string, string[]> = {};

      try {
        const funtopiaResult = await pool.query(
          "SELECT DISTINCT order_date FROM funtopia_raw_orders WHERE order_date >= $1 AND order_date <= $2",
          [startDate, endDate]
        );
        for (const row of funtopiaResult.rows) {
          const d = row.order_date;
          if (d && !coverage[d]) coverage[d] = [];
          if (d) coverage[d].push("funtopia");
        }
      } catch (err) {}

      try {
        const papayaResult = await pool.query(
          `SELECT DISTINCT SUBSTRING(date FROM POSITION(':' IN date) + 1) as clean_date FROM papaya_daily_cache WHERE SUBSTRING(date FROM POSITION(':' IN date) + 1) >= $1 AND SUBSTRING(date FROM POSITION(':' IN date) + 1) <= $2`,
          [startDate, endDate]
        );
        for (const row of papayaResult.rows) {
          const d = row.clean_date;
          if (!coverage[d]) coverage[d] = [];
          if (!coverage[d].includes("papaya")) coverage[d].push("papaya");
        }
      } catch (err) {}

      res.json({ year: y, month: m, coverage });
    } catch (err) {
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

    try {
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json(await buildMarketingSummary(startDate, endDate));
    } catch (error) {
      console.error(
        "[MarketingSummary] Unable to build response:",
        error instanceof Error ? error.message : error,
      );
      return res.status(503).json({
        error: "temporarily_unavailable",
        message: "OTO Radar data is temporarily unavailable; retry later",
      });
    }
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

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Error:", err);
    res.status(500).json({ message: err.message || "Internal server error" });
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
