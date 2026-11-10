import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { branches, coreEvents } from "@shared/schema";
import type { TillBillingReading } from "@shared/tillBilling";
import { requireAuth } from "./auth";
import { canUserAccessBranch } from "./auth-middleware";
import { db } from "./db";
import { log } from "./lib/logger";
import { generatePartyQuotePdf, partyQuoteContent } from "./lib/partyQuote";
import { suiteProvisionConfig } from "./lib/suiteSignIn";
import { readTillBilling } from "./lib/tillBilling";

/**
 * A PARTY'S MONEY IN THE BEO, FROM THE TILL (SCRUM-822).
 *
 *   GET /api/events/:eventId/beo/till-billing   the till's figures, or why there are none
 *   GET /api/events/:eventId/beo/quote.pdf      the Quote PDF of those figures
 *
 * The BEO's Billing section ("From the till"), its Party Details box and its
 * Day-of view read the first; the Billing section's "Quote PDF" opens the
 * second. Both ask the platform with this app's provisioning key
 * (server/lib/tillBilling.ts) and work no figure out themselves: the till's
 * payments are the party's one ledger (the owner's ruling, 10 November).
 *
 * Guarded as the BEO's own read and its PDF are (`GET /api/events/:eventId/beo`,
 * `/beo/pdf`): signed in, the event in the caller's park group at a park they
 * may open. The figures answer 200 with a status the screens read — "ok" with
 * the till's answer, else why not (the platform not answering, the park not
 * linked to the till, this deployment without the key) — so a screen shows
 * "Till not reachable" and never a number of its own.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TILL_PARK_NOT_LINKED = "This party's park is not linked to the till yet, so the till cannot be asked for its money.";
export const TILL_UNCONFIGURED =
  "This deployment cannot ask the till yet: PLATFORM_API_URL and OTOAPP_PROVISION_KEY are not both set.";

type EventRow = { id: string; tenantId: string; branchId: string | null; title: string; eventDate: string };

/** The event as the BEO's own routes read it: the caller's park group, a park they may open; null otherwise. */
async function eventFor(req: Request): Promise<EventRow | null> {
  const tenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;
  const eventId = req.params.eventId ?? "";
  if (!tenantId || !UUID.test(eventId)) return null;
  const [event] = await db
    .select({ id: coreEvents.id, tenantId: coreEvents.tenantId, branchId: coreEvents.branchId, title: coreEvents.title, eventDate: coreEvents.eventDate })
    .from(coreEvents)
    .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, tenantId)));
  if (!event || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, event.branchId)) return null;
  return event as EventRow;
}

/** The party's park: its link to the till, and its header for the Quote PDF. */
async function parkOf(event: EventRow) {
  if (!event.branchId) return null;
  const [park] = await db
    .select({ name: branches.name, address: branches.address, logoUrl: branches.logoUrl, coreBranchId: branches.coreBranchId })
    .from(branches)
    .where(and(eq(branches.id, event.branchId), eq(branches.tenantId, event.tenantId)));
  return park ?? null;
}

/** The till's figures for the event, or why there are none. */
async function readingFor(event: EventRow, requestId?: string): Promise<TillBillingReading> {
  const park = await parkOf(event);
  const linked = park?.coreBranchId?.trim().toLowerCase() ?? "";
  if (!UUID.test(linked)) return { status: "not_linked", message: TILL_PARK_NOT_LINKED };
  const config = suiteProvisionConfig();
  if (!config) return { status: "unconfigured", message: TILL_UNCONFIGURED };
  const read = await readTillBilling(config, event.id, requestId);
  if (!read.ok) return { status: "not_reachable", message: read.message };
  return { status: "ok", billing: read.billing, readAt: new Date().toISOString() };
}

export function registerPartyBillingRoutes(app: Express): void {
  app.get("/api/events/:eventId/beo/till-billing", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await eventFor(req);
      if (!event) return res.status(404).json({ message: "Event not found" });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await readingFor(event, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/events/:eventId/beo/quote.pdf", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await eventFor(req);
      if (!event) return res.status(404).json({ message: "Event not found" });
      const reading = await readingFor(event, req.requestId);
      if (reading.status !== "ok") {
        return res.status(502).json({ code: "TILL_NOT_REACHABLE", message: `Till not reachable: ${reading.message} No quote was made.` });
      }
      if (reading.billing.state === "sale") {
        return res.status(409).json({ code: "PARTY_SETTLED", message: "This party is settled at the till: its receipt is the record, not a quote." });
      }
      const content = partyQuoteContent(reading.billing, new Date());
      if (!content) {
        return res.status(409).json({
          code: reading.billing.noQuote?.code ?? "NO_QUOTE",
          message: reading.billing.noQuote?.message ?? "The till cannot price this party yet.",
        });
      }
      const park = await parkOf(event);
      const header = {
        name: park?.name?.trim() || `${reading.billing.park.name}, ${reading.billing.park.branchName}`,
        address: park?.address?.trim() || reading.billing.park.address || "",
        ...(park?.logoUrl ? { logoUrl: park.logoUrl } : {}),
      };
      const pdf = await generatePartyQuotePdf(content, header);
      const filename = `Quote_${event.title.replace(/[^a-zA-Z0-9]/g, "_")}_${event.eventDate}.pdf`;
      log().info({ eventId: event.id, userId: req.user?.id, totalSatang: reading.billing.quote?.totalSatang }, "a party quote PDF was made from the till's figures");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.setHeader("Content-Length", pdf.length);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(pdf);
    } catch (error) {
      next(error);
    }
  });
}
