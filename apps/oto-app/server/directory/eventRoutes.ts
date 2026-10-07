import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { directoryClientOf, requireDirectoryClient } from "./clientAuth";
import {
  createEventAttendee,
  findTenantEvent,
  recordAttendeeCheckin,
  type WriteOutcome,
} from "./eventWrites";

/**
 * The directory API's event writes — the POS's way back into this app
 * (events-kiosk PLAN s8, round 0):
 *
 *   POST /api/directory/events/:id/attendees
 *   POST /api/directory/events/:id/attendees/:attendeeId/checkins
 *
 * Both authenticate a tenant-bound directory key with the `events:write` scope
 * (`clientAuth.ts`), never the shared HR key, and both take the id the caller
 * minted, so a retry is a replay (`eventWrites.ts`). The POS reads the result
 * back through the `otoapp_v` views (migration 0004).
 *
 * The pool is passed in rather than imported so the routes can be mounted on a
 * bare server in a test without the app's boot-time configuration.
 */

const isRealDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected yyyy-MM-dd")
  .refine(isRealDate, "Not a calendar date");

const optionalText = (max: number) => z.string().max(max).nullish();

export const attendeeBodySchema = z
  .object({
    id: z.string().uuid(),
    childFullName: z.string().trim().min(1).max(200),
    dateOfBirth: isoDate.nullish(),
    ageYears: z.number().int().min(0).max(30).nullish(),
    primaryLanguage: optionalText(100),
    allergies: optionalText(2000),
    foodRestrictions: optionalText(2000),
    parentName: optionalText(200),
    parentPhone: optionalText(50),
    parentAttending: z.boolean().default(false),
    attendanceDays: z.array(isoDate).max(366).default([]),
    notes: optionalText(2000),
    bookingId: z.string().uuid().nullish(),
    source: z.enum(["pos", "booking", "kiosk"]).default("pos"),
    createdBy: optionalText(255),
  })
  .strict();

export const checkinBodySchema = z
  .object({
    id: z.string().uuid(),
    date: isoDate,
    checkedInAt: z.string().datetime({ offset: true }).nullish(),
    checkedInBy: optionalText(255),
  })
  .strict();

function send<T>(res: Response, outcome: WriteOutcome<T>) {
  if (outcome.ok) return res.status(outcome.status).json(outcome.body);
  const { status, error, message, details } = outcome;
  return res.status(status).json(details === undefined ? { error, message } : { error, message, details });
}

const invalid = (res: Response, error: z.ZodError) =>
  res.status(400).json({ error: "Validation error", message: "The request body is not valid", details: error.flatten() });

const eventNotFound = (res: Response) =>
  res.status(404).json({ error: "event_not_found", message: "Event not found" });

export function directoryEventRouter(pool: Pool): Router {
  const router = Router();
  const auth = requireDirectoryClient(pool, "events:write");

  router.post(
    "/api/directory/events/:id/attendees",
    auth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = attendeeBodySchema.safeParse(req.body);
        if (!parsed.success) return invalid(res, parsed.error);
        const client = directoryClientOf(res);
        const event = await findTenantEvent(pool, client.tenantId, req.params.id);
        if (!event) return eventNotFound(res);
        return send(res, await createEventAttendee(pool, event, parsed.data));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/api/directory/events/:id/attendees/:attendeeId/checkins",
    auth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = checkinBodySchema.safeParse(req.body);
        if (!parsed.success) return invalid(res, parsed.error);
        const client = directoryClientOf(res);
        const event = await findTenantEvent(pool, client.tenantId, req.params.id);
        if (!event) return eventNotFound(res);
        return send(res, await recordAttendeeCheckin(pool, event, req.params.attendeeId, parsed.data));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
