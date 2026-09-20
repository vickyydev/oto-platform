import { Router, Request, Response } from "express";
import {
  syncTracking,
  syncPL,
  syncCash,
  queryPLCompare,
  queryCashSeries,
  getTrackingLocations,
  getSyncHistory,
} from "./finance-sync";
import { db } from "./db";
import { xeroTokens } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

const router = Router();

function requireAuth(req: Request, res: Response): boolean {
  if (!req.isAuthenticated?.() || !req.user) {
    res.status(401).json({ message: "Not authenticated" });
    return false;
  }
  return true;
}

async function resolvetenantId(req: Request): Promise<string> {
  const bodyTenantId = req.body?.tenantId || req.query?.tenantId;
  if (bodyTenantId) return bodyTenantId as string;

  const [token] = await db
    .select()
    .from(xeroTokens)
    .where(eq(xeroTokens.isActive, true))
    .orderBy(desc(xeroTokens.updatedAt))
    .limit(1);

  if (!token?.xeroTenantId) throw new Error("No active Xero connection found");
  return token.xeroTenantId;
}

router.post("/sync/tracking", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const tenantId = await resolvetenantId(req);
    const result = await syncTracking(tenantId);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error("[FinanceSync] tracking sync error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

router.post("/sync/pl", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const { fromDate, toDate } = req.body;
  if (!fromDate || !toDate) {
    return res.status(400).json({ message: "fromDate and toDate required" });
  }
  try {
    const tenantId = await resolvetenantId(req);
    const result = await syncPL(tenantId, fromDate, toDate);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error("[FinanceSync] P&L sync error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

router.post("/sync/cash", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const { fromDate, toDate } = req.body;
  if (!fromDate || !toDate) {
    return res.status(400).json({ message: "fromDate and toDate required" });
  }
  try {
    const tenantId = await resolvetenantId(req);
    const result = await syncCash(tenantId, fromDate, toDate);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error("[FinanceSync] cash sync error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

router.get("/pl/compare", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const { fromDate, toDate, compareMode } = req.query;
  if (!fromDate || !toDate) {
    return res.status(400).json({ message: "fromDate and toDate required" });
  }
  const mode = (compareMode as string) || "STLY";
  if (mode !== "STLY" && mode !== "PREV_PERIOD") {
    return res.status(400).json({ message: "compareMode must be STLY or PREV_PERIOD" });
  }
  try {
    const tenantId = await resolvetenantId(req);
    const result = await queryPLCompare({
      tenantId,
      fromDate: fromDate as string,
      toDate: toDate as string,
      compareMode: mode,
    });
    res.json(result);
  } catch (error: any) {
    console.error("[FinanceSync] P&L compare error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

router.get("/cash/series", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const { fromDate, toDate, granularity } = req.query;
  if (!fromDate || !toDate) {
    return res.status(400).json({ message: "fromDate and toDate required" });
  }
  const gran = (granularity as string) || "day";
  if (gran !== "day" && gran !== "week") {
    return res.status(400).json({ message: "granularity must be day or week" });
  }
  try {
    const tenantId = await resolvetenantId(req);
    const result = await queryCashSeries({
      tenantId,
      fromDate: fromDate as string,
      toDate: toDate as string,
      granularity: gran,
    });
    res.json(result);
  } catch (error: any) {
    console.error("[FinanceSync] cash series error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

router.get("/tracking-locations", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const tenantId = await resolvetenantId(req);
    const result = await getTrackingLocations(tenantId);
    res.json(result);
  } catch (error: any) {
    console.error("[FinanceSync] tracking locations error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

router.get("/sync-history", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const tenantId = await resolvetenantId(req);
    const limit = parseInt(req.query.limit as string) || 20;
    const result = await getSyncHistory(tenantId, limit);
    res.json(result);
  } catch (error: any) {
    console.error("[FinanceSync] sync history error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

export default router;
