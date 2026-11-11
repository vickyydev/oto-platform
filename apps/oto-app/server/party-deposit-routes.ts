import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { beoSetMenuSelections, branches, coreEvents } from "@shared/schema";
import { NO_CONVERSATION_WORDS, depositRequestProblem, satangOfWholeBaht, type PartyDepositReading } from "@shared/partyDeposit";
import { isTillPartyEventType } from "@shared/tillBilling";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireManager } from "./auth-middleware";
import { db } from "./db";
import { log } from "./lib/logger";
import {
  actOnPartyDeposit,
  postPartyMenuLink,
  postPartyMenuReceived,
  readPartyDeposit,
  requestPartyDeposit,
  type PlatformRefusal,
} from "./lib/partyDepositRequest";
import { suiteProvisionConfig } from "./lib/suiteSignIn";
import { TILL_NOT_A_PARTY, TILL_PARK_NOT_LINKED, TILL_UNCONFIGURED } from "./party-billing-routes";

/**
 * A PARTY'S DEPOSIT ASKED FROM THE BEO, AND THE PARENT'S MENU LINK (SCRUM-825).
 *
 *   GET  /api/events/:eventId/beo/deposit-request                      the requests as the platform holds them, or why none
 *   POST /api/events/:eventId/beo/deposit-request                      "Request deposit" — an amount in baht and the press's action id
 *   POST /api/events/:eventId/beo/deposit-request/:requestId/resend    "Resend"
 *   POST /api/events/:eventId/beo/deposit-request/:requestId/cancel    "Cancel request"
 *   POST /api/events/:eventId/beo/menu-link                            "Send the menu choice link"
 *   and, before the BEO's own submit route, a hook on
 *   POST /api/beo/set-menu-selections/public/:token/submit             the parent's choices landed: the platform is told
 *
 * The platform does the work (its `otoapp-party-deposit` doors): it mints the
 * 2C2P link, has the inbox assistant post it in the family's chat, watches
 * the payment, moves the party's ONE deposit figure and writes it back here
 * (SCRUM-804's party edit), reminds the family and hands the thread over. This
 * app asks with its provisioning key (server/lib/partyDepositRequest.ts) and
 * works nothing out itself.
 *
 * Guarded as the BEO's own routes are: signed in, the event in the caller's
 * park group at a park they may open; every press a manager's. The read
 * answers 200 with a status the screen reads — "ok" with the platform's
 * answer, else why not (the platform not answering, the park not linked, this
 * deployment without the key, an event the till never settles) — so the
 * Billing section says "Till not reachable" and never guesses.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EventRow = { id: string; tenantId: string; branchId: string | null; eventType: string; inboxConversationId: string | null; eventDate: string };

/** The event as the BEO's own routes read it: the caller's park group, a park they may open; null otherwise. */
async function eventFor(req: Request): Promise<EventRow | null> {
  const tenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;
  const eventId = req.params.eventId ?? "";
  if (!tenantId || !UUID.test(eventId)) return null;
  const [event] = await db
    .select({
      id: coreEvents.id,
      tenantId: coreEvents.tenantId,
      branchId: coreEvents.branchId,
      eventType: coreEvents.eventType,
      inboxConversationId: coreEvents.inboxConversationId,
      eventDate: coreEvents.eventDate,
    })
    .from(coreEvents)
    .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, tenantId)));
  if (!event || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, event.branchId)) return null;
  return event as EventRow;
}

/** Whether the party's park is linked to the till, and this deployment holds the key: the same three reasons as the till's money. */
async function platformFor(event: Pick<EventRow, "tenantId" | "branchId" | "eventType">): Promise<
  { ok: true; config: ReturnType<typeof suiteProvisionConfig> & object } | { ok: false; reading: Exclude<PartyDepositReading, { status: "ok" }> }
> {
  if (!isTillPartyEventType(event.eventType)) return { ok: false, reading: { status: "not_a_party", message: TILL_NOT_A_PARTY } };
  const [park] = event.branchId
    ? await db
        .select({ coreBranchId: branches.coreBranchId })
        .from(branches)
        .where(and(eq(branches.id, event.branchId), eq(branches.tenantId, event.tenantId)))
    : [];
  const linked = park?.coreBranchId?.trim().toLowerCase() ?? "";
  if (!UUID.test(linked)) return { ok: false, reading: { status: "not_linked", message: TILL_PARK_NOT_LINKED } };
  const config = suiteProvisionConfig();
  if (!config) return { ok: false, reading: { status: "unconfigured", message: TILL_UNCONFIGURED } };
  return { ok: true, config };
}

/** A refusal as the screen reads it: the platform's words, its status. */
const refused = (res: Response, r: PlatformRefusal) => res.status(r.status).json({ code: r.code, message: r.message });
/** A deployment or a park that cannot ask the platform: 409 for a press, said in words. */
const cannotAsk = (res: Response, reading: Exclude<PartyDepositReading, { status: "ok" }>) =>
  res.status(reading.status === "unconfigured" ? 503 : 409).json({ code: reading.status.toUpperCase(), message: reading.message });

const PressSchema = z.object({ actionId: z.string().uuid() }).strict();
const RequestSchema = z.object({ actionId: z.string().uuid(), amount: z.number() }).strict();

/**
 * The parent's selection link as the editor builds it for the clipboard
 * (`/menu-select/<token>` on this app's own address): `OTOAPP_PUBLIC_ORIGIN`
 * where the deployment names itself, else the address the browser used.
 */
export function menuLinkOf(req: Request, token: string): string {
  const configured = (process.env.OTOAPP_PUBLIC_ORIGIN ?? "").trim().replace(/\/$/, "");
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  const own = `${protocol}://${req.get("host") ?? ""}`;
  return `${configured || own}/menu-select/${encodeURIComponent(token)}`;
}

export function registerPartyDepositRoutes(app: Express): void {
  app.get("/api/events/:eventId/beo/deposit-request", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await eventFor(req);
      if (!event) return res.status(404).json({ message: "Event not found" });
      res.setHeader("Cache-Control", "private, no-store");
      const platform = await platformFor(event);
      if (!platform.ok) return res.json(platform.reading satisfies PartyDepositReading);
      const read = await readPartyDeposit(platform.config, event.id, req.requestId);
      if (!read.ok) return res.json({ status: "not_reachable", message: read.message } satisfies PartyDepositReading);
      return res.json({ status: "ok", answer: read.answer, readAt: new Date().toISOString() } satisfies PartyDepositReading);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/deposit-request", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ message: "The request is not in the shape this form sends. Type the deposit in baht and press again." });
      const problem = depositRequestProblem(parsed.data.amount);
      if (problem) return res.status(400).json({ message: problem });
      const event = await eventFor(req);
      const userId = req.user?.id ?? "";
      if (!event || !userId) return res.status(404).json({ message: "Event not found" });
      const platform = await platformFor(event);
      if (!platform.ok) return cannotAsk(res, platform.reading);
      if (!event.inboxConversationId) return res.status(409).json({ code: "PARTY_NO_CONVERSATION", message: NO_CONVERSATION_WORDS });
      const made = await requestPartyDeposit(
        platform.config,
        event.id,
        { actionId: parsed.data.actionId, amountSatang: satangOfWholeBaht(parsed.data.amount), actorAppUserId: userId, conversationId: event.inboxConversationId },
        req.requestId,
      );
      if (!made.ok) return refused(res, made);
      log().info({ eventId: event.id, userId, amountSatang: made.answer.request.amountSatang, replayed: made.answer.replayed }, "a party deposit was requested from the BEO");
      return res.json(made.answer);
    } catch (error) {
      next(error);
    }
  });

  for (const action of ["resend", "cancel"] as const) {
    app.post(`/api/events/:eventId/beo/deposit-request/:requestId/${action}`, requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = PressSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ message: "The press is not in the shape this form sends. Open the BEO again and press again." });
        const event = await eventFor(req);
        const userId = req.user?.id ?? "";
        const requestId = req.params.requestId ?? "";
        if (!event || !userId || !UUID.test(requestId)) return res.status(404).json({ message: "Event not found" });
        const platform = await platformFor(event);
        if (!platform.ok) return cannotAsk(res, platform.reading);
        const done = await actOnPartyDeposit(platform.config, event.id, requestId, action, { actionId: parsed.data.actionId, actorAppUserId: userId }, req.requestId);
        if (!done.ok) return refused(res, done);
        log().info({ eventId: event.id, userId, requestId, action, replayed: done.answer.replayed }, `a party deposit request was ${action === "resend" ? "resent" : "cancelled"} from the BEO`);
        return res.json(done.answer);
      } catch (error) {
        next(error);
      }
    });
  }

  app.post("/api/events/:eventId/beo/menu-link", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = PressSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ message: "The press is not in the shape this form sends. Open the BEO again and press again." });
      const event = await eventFor(req);
      const userId = req.user?.id ?? "";
      if (!event || !userId) return res.status(404).json({ message: "Event not found" });
      const platform = await platformFor(event);
      if (!platform.ok) return cannotAsk(res, platform.reading);
      if (!event.inboxConversationId) return res.status(409).json({ code: "PARTY_NO_CONVERSATION", message: NO_CONVERSATION_WORDS });
      const [selection] = await db
        .select({ token: beoSetMenuSelections.token, isSubmitted: beoSetMenuSelections.isSubmitted })
        .from(beoSetMenuSelections)
        .where(eq(beoSetMenuSelections.eventId, event.id));
      if (!selection) {
        return res.status(409).json({ code: "NO_MENU_LINK", message: "This party has no menu choice link yet. Generate the parent link in the BEO's set menu first." });
      }
      if (selection.isSubmitted) {
        return res.status(409).json({ code: "MENU_ALREADY_CHOSEN", message: "The family has already sent their menu choices on this link." });
      }
      const link = menuLinkOf(req, selection.token);
      const posted = await postPartyMenuLink(platform.config, event.id, { actionId: parsed.data.actionId, link, actorAppUserId: userId }, req.requestId);
      if (!posted.ok) return refused(res, posted);
      log().info({ eventId: event.id, userId, replayed: posted.answer.replayed }, "the parent's menu link was posted from the BEO");
      return res.json(posted.answer);
    } catch (error) {
      next(error);
    }
  });
}

/**
 * THE PARENT'S CHOICES LANDED. The BEO's own public submit route
 * (`beo-routes.ts`) writes them; this hook, registered BEFORE it on the same
 * path, waits for its answer and — when it was a 200 — tells the platform so
 * the assistant confirms in the family's chat. Keyed by the selection and the
 * moment it was submitted, so a retried hook confirms once. Best effort: a
 * platform that cannot be reached is a log line, never a failed submit.
 */
export function registerPartyMenuSubmissionHook(app: Express): void {
  app.post("/api/beo/set-menu-selections/public/:token/submit", (req: Request, res: Response, next: NextFunction) => {
    const token = req.params.token ?? "";
    res.on("finish", () => {
      if (res.statusCode !== 200) return;
      void tellPlatformMenuReceived(token, req.requestId).catch((err: unknown) => {
        log().warn({ err: err instanceof Error ? err.message : String(err) }, "the platform could not be told a family's menu choices landed");
      });
    });
    next();
  });
}

/** The submit's selection, its party and its park; the platform told once per submission. */
export async function tellPlatformMenuReceived(token: string, requestId?: string): Promise<boolean> {
  if (!token) return false;
  const [selection] = await db
    .select({ id: beoSetMenuSelections.id, eventId: beoSetMenuSelections.eventId, isSubmitted: beoSetMenuSelections.isSubmitted, submittedAt: beoSetMenuSelections.submittedAt })
    .from(beoSetMenuSelections)
    .where(eq(beoSetMenuSelections.token, token));
  if (!selection?.isSubmitted) return false;
  const [event] = await db
    .select({ id: coreEvents.id, tenantId: coreEvents.tenantId, branchId: coreEvents.branchId, eventType: coreEvents.eventType, inboxConversationId: coreEvents.inboxConversationId })
    .from(coreEvents)
    .where(eq(coreEvents.id, selection.eventId));
  if (!event?.inboxConversationId) return false;
  const platform = await platformFor(event);
  if (!platform.ok) {
    log().info({ eventId: event.id, reason: platform.reading.status }, "a family's menu choices landed, but the platform cannot be asked to confirm them");
    return false;
  }
  const submittedAt = selection.submittedAt ? new Date(selection.submittedAt).toISOString() : null;
  const told = await postPartyMenuReceived(
    platform.config,
    event.id,
    { actionId: `menu-received:${selection.id}:${submittedAt ?? "unknown"}`, submittedAt },
    requestId,
  );
  if (!told.ok) {
    log().warn({ eventId: event.id, code: told.code }, "the platform refused the confirmation of a family's menu choices");
    return false;
  }
  log().info({ eventId: event.id, replayed: told.answer.replayed }, "a family's menu choices were confirmed in their chat");
  return true;
}
