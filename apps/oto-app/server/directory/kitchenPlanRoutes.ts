import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { beoKitchenPlans, beoSetMenuTemplates } from "@shared/schema";
import { directoryClientOf, requireDirectoryClient } from "./clientAuth";
import { findTenantEvent } from "./eventWrites";
import { applyTillKitchenEdit, choiceGroupsOf, kitchenPlanEditBodySchema, type BeoSaveWriters } from "../lib/tillKitchenEdit";

/**
 * THE TILL'S DOOR INTO A PARTY'S KITCHEN PLAN (SCRUM-907; the owner's decision
 * 7 of 12 November: a manager or an admin edits the kitchen plan on the till
 * "and update it in BEO as well").
 *
 *   GET  /api/directory/events/:id/kitchen-plan/choices   the set menu's choice groups and their options
 *   POST /api/directory/events/:id/kitchen-plan           a manager's change, written to the BEO
 *
 * The platform's server calls these, never a browser and never a person's
 * session: the tenant-bound directory key with the `events:write` scope it
 * already writes a party's edits with (`clientAuth.ts`), so the park group a
 * change lands in is the key's, and another park group's party is "not
 * found" like one that does not exist. Only a party is changed this way.
 *
 * The write goes through the BEO's own Save (`server/lib/tillKitchenEdit.ts`,
 * which takes the Save's writers from beo-routes.ts), once per edit id, and
 * says who did it in the BEO's activity. The platform reads the party back
 * through its plan view afterwards; this answers only what was done.
 */

const invalid = (res: Response, error: { flatten(): unknown }) =>
  res.status(400).json({ error: "Validation error", message: "The request body is not valid", details: error.flatten() });

const eventNotFound = (res: Response) => res.status(404).json({ error: "event_not_found", message: "Event not found" });

export interface KitchenPlanRouteDeps {
  /** The app's drizzle handle (server/db.ts). */
  db: any;
  /** The BEO's Save, as beo-routes.ts writes it. */
  writers: BeoSaveWriters;
  /** After a write: the BEO's timeline follows its kitchen plan, as after the Save. */
  afterWrite?: (eventId: string) => Promise<void>;
}

export function directoryKitchenPlanRouter(pool: Pool, deps: KitchenPlanRouteDeps): Router {
  const router = Router();
  const auth = requireDirectoryClient(pool, "events:write");

  router.get("/api/directory/events/:id/kitchen-plan/choices", auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const client = directoryClientOf(res);
      const event = await findTenantEvent(pool, client.tenantId, req.params.id ?? "");
      if (!event) return eventNotFound(res);
      if (!event.isParty) return res.status(409).json({ error: "not_a_party", message: "Only a party's kitchen plan is changed from a till" });
      const [kitchen] = await deps.db
        .select({ setMenuEnabled: beoKitchenPlans.setMenuEnabled, setMenuTemplateId: beoKitchenPlans.setMenuTemplateId })
        .from(beoKitchenPlans)
        .where(eq(beoKitchenPlans.eventId, event.id));
      const [template] =
        kitchen?.setMenuEnabled && kitchen.setMenuTemplateId
          ? await deps.db
              .select({ name: beoSetMenuTemplates.name, items: beoSetMenuTemplates.items })
              .from(beoSetMenuTemplates)
              .where(and(eq(beoSetMenuTemplates.id, kitchen.setMenuTemplateId), eq(beoSetMenuTemplates.tenantId, client.tenantId)))
          : [];
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({
        setMenu: template
          ? {
              templateName: template.name,
              groups: choiceGroupsOf(Array.isArray(template.items) ? template.items : []).map((g) => ({
                label: g.label,
                options: g.options,
                allowMultiple: g.allowMultiple,
              })),
            }
          : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/directory/events/:id/kitchen-plan", auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = kitchenPlanEditBodySchema.safeParse(req.body);
      if (!parsed.success) return invalid(res, parsed.error);
      const client = directoryClientOf(res);
      const event = await findTenantEvent(pool, client.tenantId, req.params.id ?? "");
      if (!event) return eventNotFound(res);
      if (!event.isParty) return res.status(409).json({ error: "not_a_party", message: "Only a party's kitchen plan is changed from a till" });
      const outcome = await applyTillKitchenEdit(deps.db, deps.writers, { id: event.id, tenantId: event.tenantId }, parsed.data);
      if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error, message: outcome.message });
      if (outcome.wrote && deps.afterWrite) await deps.afterWrite(event.id);
      return res.status(outcome.status).json(outcome.body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
