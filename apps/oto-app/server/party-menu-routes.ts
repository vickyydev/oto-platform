import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { beoKitchenPlans, branches, coreEvents } from "@shared/schema";
import { adultsDifferOf } from "@shared/kitchenAdults";
import {
  PartyMenuItemBodySchema,
  partyMenuItemProblem,
  partyMenuLineOf,
  satangOfBaht,
  type PartyMenuLine,
} from "@shared/partyMenuItem";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireManager } from "./auth-middleware";
import { db } from "./db";
import { log } from "./lib/logger";
import { PARTY_MENU_UNCONFIGURED, createPartyMenuProduct } from "./lib/partyMenuItem";
import { suiteProvisionConfig } from "./lib/suiteSignIn";

/**
 * "New item" on the BEO's food lines (SCRUM-828).
 *
 *   POST /api/events/:eventId/beo/party-menu-items
 *        { actionId, menu: kids|adults, name, station: kitchen|bar, price|null, free }
 *
 * Staff add an item the till's catalogue does not have yet. In this order,
 * and nothing is written before the till has made the product:
 *   1. the event is the caller's park group's, at a park they may open, and
 *      that park is linked to a platform branch (`branches.core_branch_id`);
 *   2. the platform makes it a BEO-only till product with this app's
 *      provisioning key (`lib/partyMenuItem.ts`), the press's action id as the
 *      Idempotency-Key;
 *   3. the line is written to the kitchen plan's list at once, under the lock
 *      every BEO writer takes, with the product's code as `productCode`, the
 *      name as typed, one of it, and the price or "included". Its id comes
 *      from the press, so a retry after a lost answer is the same line.
 * Any refusal on the way answers in words and writes nothing: the line is
 * never saved without its code, and never twice.
 *
 * Guarded as the BEO's own Save is (`PUT /api/events/:eventId/beo`): any role
 * that may create and save a BEO may add an item.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type KitchenLine = Record<string, unknown>;
const asLines = (v: unknown): KitchenLine[] =>
  Array.isArray(v) ? (v.filter((l) => l && typeof l === "object" && !Array.isArray(l)) as KitchenLine[]) : [];
const asCollection = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const PARTY_MENU_PARK_NOT_LINKED =
  "This party's park is not linked to the till yet, so a new item cannot be made there. The line was not added.";

export function registerPartyMenuRoutes(app: Express): void {
  app.post("/api/events/:eventId/beo/party-menu-items", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = PartyMenuItemBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "The new item is not in the shape this form sends. Open it again and fill in the name, the station and the price." });
      }
      const body = parsed.data;
      const problem = partyMenuItemProblem(body);
      if (problem) return res.status(400).json({ message: problem });

      // The event as the BEO's own routes read it: the caller's park group, a park they may open.
      const tenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;
      // Who pressed: named to the platform, which records them on its audit rows, and on this app's log line.
      const userId = req.user?.id ?? "";
      const eventId = req.params.eventId ?? "";
      if (!tenantId || !userId || !UUID.test(eventId)) return res.status(404).json({ message: "Event not found" });
      const [event] = await db
        .select({ id: coreEvents.id, tenantId: coreEvents.tenantId, branchId: coreEvents.branchId })
        .from(coreEvents)
        .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, tenantId)));
      if (!event || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, event.branchId)) {
        return res.status(404).json({ message: "Event not found" });
      }
      const [park] = event.branchId
        ? await db
            .select({ coreBranchId: branches.coreBranchId })
            .from(branches)
            .where(and(eq(branches.id, event.branchId), eq(branches.tenantId, event.tenantId)))
        : [];
      const coreBranchId = park?.coreBranchId?.trim().toLowerCase() ?? "";
      if (!UUID.test(coreBranchId)) return res.status(409).json({ code: "PARK_NOT_LINKED", message: PARTY_MENU_PARK_NOT_LINKED });

      const config = suiteProvisionConfig();
      if (!config) return res.status(503).json({ code: "UNCONFIGURED", message: PARTY_MENU_UNCONFIGURED });

      const made = await createPartyMenuProduct(
        config,
        {
          actionId: body.actionId,
          branchId: coreBranchId,
          name: body.name,
          station: body.station,
          priceSatang: body.free ? null : satangOfBaht(body.price ?? 0),
          free: body.free,
          source: { eventId: event.id, lineLabel: body.name },
          actorAppUserId: userId,
        },
        req.requestId,
      );
      if (!made.ok) return res.status(made.status).json({ code: made.code, message: made.message });

      const line = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`);
        const [plan] = await tx.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, event.id));
        const menus = asCollection(plan?.menus);
        const fresh = partyMenuLineOf(body, made.code, plan?.setMenuEnabled ?? false);
        const held = asLines(menus[body.menu]);
        const at = held.findIndex((l) => l.id === fresh.id);
        // A retry of the same press finds its line and gives it the code again; nothing is added twice.
        const written = (at < 0 ? fresh : { ...held[at], productCode: made.code }) as PartyMenuLine;
        const lines = at < 0 ? [...held, written] : held.map((l, i) => (i === at ? written : l));
        const nextMenus = { ...menus, [body.menu]: lines };
        // SCRUM-829: the plan records "Different for adults" as its readers resolve it, so a line
        // added to the adults' list here reads one way on the till, in the editor and on the PDF.
        if (typeof nextMenus.adultsDiffer !== "boolean") nextMenus.adultsDiffer = adultsDifferOf(nextMenus);
        const values = {
          menus: nextMenus,
          simplifiedMenus: { kids: asLines(nextMenus.kids), adults: asLines(nextMenus.adults) },
          updatedAt: new Date(),
        };
        if (plan) await tx.update(beoKitchenPlans).set(values).where(eq(beoKitchenPlans.id, plan.id));
        else await tx.insert(beoKitchenPlans).values({ eventId: event.id, ...values });
        return written;
      });
      log().info(
        {
          eventId: event.id,
          userId,
          productId: made.productId,
          code: made.code,
          station: body.station,
          free: body.free,
          replayed: made.replayed,
        },
        "a new party menu item was made on the till and added to the BEO",
      );
      res.json({ line, productId: made.productId, productCode: made.code, replayed: made.replayed });
    } catch (error) {
      next(error);
    }
  });
}
