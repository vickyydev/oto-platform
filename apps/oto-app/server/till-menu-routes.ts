import type { Express, NextFunction, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { branches } from "@shared/schema";
import type { TillMenuPark, TillMenuReading } from "@shared/tillMenu";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireManager } from "./auth-middleware";
import { db } from "./db";
import { suiteProvisionConfig } from "./lib/suiteSignIn";
import { readTillMenu } from "./lib/tillMenu";

/**
 * THE TILL'S MENU IN THE BEO (SCRUM-905).
 *
 *   GET /api/beo/till-menu?parkId=   one park's till menu (the BEO editor: the party's park)
 *   GET /api/beo/till-menu           every park of the caller's park group they may open
 *                                    (Settings > Set menu templates: a template is the park group's)
 *
 * The kitchen plan's kids' and adults' lines, the set menu's "+ Add item", the
 * bar plan's lines and the set menu templates' "Code" boxes pick from what
 * this answers, and mark a code the till no longer has. The till's own answer
 * passes through (`server/lib/tillMenu.ts`: the provisioning key, a minute in
 * memory, nothing in this app's tables).
 *
 * Guarded as the BEO's own Save and the set menu templates are (`PUT
 * /api/events/:eventId/beo`, `/api/beo/set-menu-templates`): signed in, a role
 * that may edit a BEO. A park is the caller's park group's and one they may
 * open, or it is not found. Each park answers 200 with a status the screens
 * read — "ok" with the till's items, else why not (the park not linked to the
 * till, this deployment without the key, the till not answering) — so a
 * screen offers no picker and marks nothing rather than guess.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TILL_MENU_PARK_NOT_LINKED = "This park is not linked to the till yet, so the till's menu cannot be offered. Type the item instead.";
export const TILL_MENU_UNCONFIGURED =
  "This deployment cannot ask the till yet: PLATFORM_API_URL and OTOAPP_PROVISION_KEY are not both set. Type the item instead.";

type Park = { id: string; name: string; coreBranchId: string | null };

async function parkMenu(park: Park, requestId?: string): Promise<TillMenuPark> {
  const base = { parkId: park.id, parkName: park.name };
  const linked = park.coreBranchId?.trim().toLowerCase() ?? "";
  if (!UUID.test(linked)) return { ...base, status: "not_linked", message: TILL_MENU_PARK_NOT_LINKED, items: [], readAt: null };
  const config = suiteProvisionConfig();
  if (!config) return { ...base, status: "unconfigured", message: TILL_MENU_UNCONFIGURED, items: [], readAt: null };
  const read = await readTillMenu(config, linked, requestId);
  if (!read.ok) return { ...base, status: "not_reachable", message: read.message, items: [], readAt: null };
  return { ...base, status: "ok", message: null, items: read.items, readAt: read.readAt };
}

export function registerTillMenuRoutes(app: Express): void {
  app.get("/api/beo/till-menu", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;
      const access = req.userWithAccess;
      if (!tenantId || !access) return res.status(404).json({ message: "Park not found" });
      const asked = typeof req.query.parkId === "string" ? req.query.parkId.trim() : "";
      if (req.query.parkId !== undefined && !UUID.test(asked)) return res.status(404).json({ message: "Park not found" });

      const rows: Park[] = await db
        .select({ id: branches.id, name: branches.name, coreBranchId: branches.coreBranchId })
        .from(branches)
        .where(asked ? and(eq(branches.tenantId, tenantId), eq(branches.id, asked)) : eq(branches.tenantId, tenantId))
        .orderBy(asc(branches.name));
      const parks = rows.filter((p) => canUserAccessBranch(access, p.id));
      if (asked && parks.length === 0) return res.status(404).json({ message: "Park not found" });

      const answer: TillMenuReading = { parks: await Promise.all(parks.map((p) => parkMenu(p, req.requestId))) };
      res.setHeader("Cache-Control", "private, no-store");
      res.json(answer);
    } catch (error) {
      next(error);
    }
  });
}
