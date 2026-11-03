import { Router, type Request, type RequestHandler, type Response, type NextFunction } from "express";
import { and, desc, eq, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { branches, employees, people } from "@shared/schema";
import { requireAuth } from "./auth";
import { getAllowedOperatorAndBranchIds, requireManager } from "./auth-middleware";
import { db } from "./db";
import {
  campAttendance,
  campRegistrations,
  coreEvents,
  dropoffCheckins,
  eventAttendeeCheckins,
  eventAttendees,
  serviceCheckins,
} from "./db/coreSchema";
import { parkGroupOf } from "./lib/routeFences";
import { identifyEmployeeByPhoneInput } from "./phone-utils";

/**
 * SCRUM-674 — WHO AND WHAT THIS APP KNOWS BY ONE PHONE NUMBER, for the
 * platform Console's support lookup.
 *
 *   GET /api/support/by-phone?phone=
 *
 * The Console never reads these tables. It opens this app as the person asking
 * (the suite hand-off, `apps/api/src/services/assistant/call-otoapp.ts`) and
 * calls this route, so the answer is what this app's own fences say that person
 * may see, the same fences its screens answer under:
 *
 *   - a manager rank or above (`requireManager`); anybody else is refused;
 *   - the caller's own park group, by the app's strict rule (`parkGroupOnly`);
 *   - the parks their access names. A record at another park is not listed, and
 *     neither is somebody with no park at all unless the caller has every park.
 *     An advisor has no park of their own, so an advisor is listed only to a
 *     caller who has every park.
 *
 * READS ONLY. A read-only transaction, so Postgres refuses this path anything
 * else; no check-in, no message and no row.
 *
 * BOUNDED AND PROJECTED. Each kind of record is its newest `SUPPORT_LOOKUP_LIMIT`
 * rows, `truncated` saying when more exist. A row is an allowlist of what tells
 * somebody at the desk which record this is: never the phone, an email, a photo,
 * a signature, a health or food note, a staff note or pay. A person's name is
 * always under `name` or `guardianName`, the keys the Console's mask covers.
 */

export const SUPPORT_LOOKUP_LIMIT = 20;

const QuerySchema = z.object({ phone: z.string().trim().min(1).max(40) }).strict();

/**
 * The digits a stored phone could be written with. `phone_e164` is kept on the
 * records that have it; the older raw columns hold what somebody typed, so
 * `081-234-5678`, `+66 81 234 5678` and `66812345678` all have to match.
 */
function digitForms(e164: string): string[] {
  const digits = e164.replace(/\D/g, "");
  return digits.startsWith("66") ? [digits, `0${digits.slice(2)}`] : [digits];
}

const digitsOf = (column: SQLWrapper): SQL => sql`regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g')`;

type Reach = string[] | null;

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

export interface SupportRecord extends Record<string, unknown> {
  record: "person" | "event" | "event_registration" | "checkin";
  id: string;
}

export interface SupportLookupAnswer {
  records: SupportRecord[];
  limit: number;
  truncated: boolean;
}

/** What the phone finds at this park group, within `reach` (null: every park). */
export async function supportRecordsByPhone(tenantId: string, reach: Reach, e164: string): Promise<SupportLookupAnswer> {
  if (reach !== null && reach.length === 0) return { records: [], limit: SUPPORT_LOOKUP_LIMIT, truncated: false };
  const forms = digitForms(e164);
  const matches = (column: SQLWrapper): SQL => sql`${digitsOf(column)} in (${sql.join(forms.map((form) => sql`${form}`), sql`, `)})`;
  const inReach = (column: SQLWrapper) => (reach === null ? undefined : inArray(column as never, reach));
  const fetch = SUPPORT_LOOKUP_LIMIT + 1;

  return db.transaction(
    async (tx) => {
      const staff = await tx
        .select({
          id: employees.id, name: employees.fullName, nickname: employees.nickname, status: employees.status,
          branchId: employees.branchId, park: branches.name,
        })
        .from(employees)
        .leftJoin(branches, and(eq(branches.id, employees.branchId), eq(branches.tenantId, tenantId)))
        .where(and(eq(employees.tenantId, tenantId), inReach(employees.branchId),
          or(eq(employees.phoneE164, e164), matches(employees.phone))))
        .orderBy(desc(employees.createdAt))
        .limit(fetch);

      const advisors = reach === null
        ? await tx
          .select({ id: people.id, name: people.fullName, nickname: people.preferredName, active: people.isActive })
          .from(people)
          .where(and(eq(people.tenantId, tenantId), eq(people.personType, "ADVISOR"),
            or(eq(people.phoneE164, e164), matches(people.phoneNumber))))
          .orderBy(desc(people.createdAt))
          .limit(fetch)
        : [];

      const events = await tx
        .select({
          id: coreEvents.id, eventType: coreEvents.eventType, name: coreEvents.title, guardianName: coreEvents.parentName,
          date: coreEvents.eventDate, startTime: coreEvents.startTime, status: coreEvents.status,
          branchId: coreEvents.branchId, park: branches.name,
        })
        .from(coreEvents)
        .innerJoin(branches, and(eq(branches.id, coreEvents.branchId), eq(branches.tenantId, tenantId)))
        .where(and(eq(coreEvents.tenantId, tenantId), eq(coreEvents.isArchived, false), inReach(coreEvents.branchId),
          or(eq(coreEvents.whatsappPhoneE164, e164), matches(coreEvents.whatsappPhoneRaw))))
        .orderBy(desc(coreEvents.eventDate), desc(coreEvents.id))
        .limit(fetch);

      const attendees = await tx
        .select({
          id: eventAttendees.id, eventId: eventAttendees.eventId, eventType: coreEvents.eventType, date: coreEvents.eventDate,
          name: eventAttendees.childFullName, guardianName: eventAttendees.parentName,
          branchId: coreEvents.branchId, park: branches.name,
        })
        .from(eventAttendees)
        .innerJoin(coreEvents, and(eq(coreEvents.id, eventAttendees.eventId), eq(coreEvents.tenantId, tenantId), eq(coreEvents.isArchived, false)))
        .innerJoin(branches, and(eq(branches.id, coreEvents.branchId), eq(branches.tenantId, tenantId)))
        .where(and(eq(eventAttendees.tenantId, tenantId), inReach(coreEvents.branchId), matches(eventAttendees.parentPhone)))
        .orderBy(desc(coreEvents.eventDate), desc(eventAttendees.id))
        .limit(fetch);

      const contacts = sql`case when jsonb_typeof(${campRegistrations.parentContacts}) = 'array' then ${campRegistrations.parentContacts} else '[]'::jsonb end`;
      const campers = await tx
        .select({
          id: campRegistrations.id, eventId: campRegistrations.eventId, eventType: coreEvents.eventType, date: coreEvents.eventDate,
          name: campRegistrations.childFullName, guardianName: campRegistrations.parentGuardianName,
          branchId: coreEvents.branchId, park: branches.name,
        })
        .from(campRegistrations)
        .innerJoin(coreEvents, and(eq(coreEvents.id, campRegistrations.eventId), eq(coreEvents.tenantId, tenantId), eq(coreEvents.isArchived, false)))
        .innerJoin(branches, and(eq(branches.id, coreEvents.branchId), eq(branches.tenantId, tenantId)))
        .where(and(eq(campRegistrations.tenantId, tenantId), inReach(coreEvents.branchId), or(
          matches(campRegistrations.emergencyContactNumber),
          sql`exists (select 1 from jsonb_array_elements(${contacts}) contact
            where regexp_replace(coalesce(contact->>'phone', ''), '[^0-9]', '', 'g') in (${sql.join(forms.map((form) => sql`${form}`), sql`, `)}))`,
        )))
        .orderBy(desc(coreEvents.eventDate), desc(campRegistrations.id))
        .limit(fetch);

      const services = await tx
        .select({
          id: serviceCheckins.id, serviceType: serviceCheckins.serviceType, status: serviceCheckins.status,
          name: serviceCheckins.childFullName, guardianName: serviceCheckins.parentFullName,
          registeredAt: serviceCheckins.registeredAt, checkedInAt: serviceCheckins.checkedInAt, checkedOutAt: serviceCheckins.checkedOutAt,
          branchId: serviceCheckins.branchId, park: branches.name,
        })
        .from(serviceCheckins)
        .innerJoin(branches, and(eq(branches.id, serviceCheckins.branchId), eq(branches.tenantId, tenantId)))
        .where(and(eq(serviceCheckins.tenantId, tenantId), inReach(serviceCheckins.branchId),
          or(eq(serviceCheckins.whatsappPhoneE164, e164), matches(serviceCheckins.whatsappPhoneRaw), matches(serviceCheckins.customerPhone))))
        .orderBy(desc(serviceCheckins.registeredAt), desc(serviceCheckins.id))
        .limit(fetch);

      const dropoffs = await tx
        .select({
          id: dropoffCheckins.id, status: dropoffCheckins.status, guardianName: dropoffCheckins.parentFullName,
          children: sql<number>`case when jsonb_typeof(${dropoffCheckins.children}) = 'array' then jsonb_array_length(${dropoffCheckins.children}) else 0 end`.mapWith(Number),
          createdAt: dropoffCheckins.createdAt, pickedUpAt: dropoffCheckins.pickedUpAt,
          branchId: dropoffCheckins.branchId, park: branches.name,
        })
        .from(dropoffCheckins)
        .innerJoin(branches, and(eq(branches.id, dropoffCheckins.branchId), eq(branches.tenantId, tenantId)))
        .where(and(eq(dropoffCheckins.tenantId, tenantId), inReach(dropoffCheckins.branchId),
          or(eq(dropoffCheckins.whatsappPhoneE164, e164), matches(dropoffCheckins.whatsappPhone))))
        .orderBy(desc(dropoffCheckins.createdAt), desc(dropoffCheckins.id))
        .limit(fetch);

      const attendeeRows = attendees.slice(0, SUPPORT_LOOKUP_LIMIT);
      const attendeeDays = attendeeRows.length === 0 ? [] : await tx
        .select({
          id: eventAttendeeCheckins.id, attendeeId: eventAttendeeCheckins.attendeeId, date: eventAttendeeCheckins.attendanceDate,
          status: eventAttendeeCheckins.status, checkedInAt: eventAttendeeCheckins.checkedInAt, checkedOutAt: eventAttendeeCheckins.checkedOutAt,
        })
        .from(eventAttendeeCheckins)
        .where(and(eq(eventAttendeeCheckins.tenantId, tenantId), inArray(eventAttendeeCheckins.attendeeId, attendeeRows.map((row) => row.id))))
        .orderBy(desc(eventAttendeeCheckins.attendanceDate), desc(eventAttendeeCheckins.id))
        .limit(fetch);

      const camperRows = campers.slice(0, SUPPORT_LOOKUP_LIMIT);
      const camperDays = camperRows.length === 0 ? [] : await tx
        .select({
          id: campAttendance.id, registrationId: campAttendance.campRegistrationId, date: campAttendance.attendanceDate,
          status: campAttendance.status, checkedInAt: campAttendance.checkedInAt, checkedOutAt: campAttendance.checkedOutAt,
        })
        .from(campAttendance)
        .where(and(eq(campAttendance.tenantId, tenantId), inArray(campAttendance.campRegistrationId, camperRows.map((row) => row.id))))
        .orderBy(desc(campAttendance.attendanceDate), desc(campAttendance.id))
        .limit(fetch);

      const attendeeById = new Map(attendeeRows.map((row) => [row.id, row]));
      const camperById = new Map(camperRows.map((row) => [row.id, row]));
      const head = <T>(rows: T[]): T[] => rows.slice(0, SUPPORT_LOOKUP_LIMIT);
      const records: SupportRecord[] = [
        ...head(staff).map((row): SupportRecord => ({ record: "person", personKind: "employee", ...row })),
        ...head(advisors).map(({ active, ...row }): SupportRecord => ({
          record: "person", personKind: "advisor", ...row, status: active ? "active" : "inactive", branchId: null, park: null,
        })),
        ...head(events).map((row): SupportRecord => ({ record: "event", ...row })),
        ...attendeeRows.map((row): SupportRecord => ({ record: "event_registration", registrationKind: "attendee", ...row })),
        ...camperRows.map((row): SupportRecord => ({ record: "event_registration", registrationKind: "camp", ...row })),
        ...head(services).map((row): SupportRecord => ({
          record: "checkin", checkinKind: "service", ...row,
          registeredAt: iso(row.registeredAt), checkedInAt: iso(row.checkedInAt), checkedOutAt: iso(row.checkedOutAt),
        })),
        ...head(dropoffs).map((row): SupportRecord => ({
          record: "checkin", checkinKind: "dropoff", ...row, createdAt: iso(row.createdAt), pickedUpAt: iso(row.pickedUpAt),
        })),
        ...head(attendeeDays).map(({ attendeeId, ...row }): SupportRecord => {
          const of = attendeeById.get(attendeeId)!;
          return { record: "checkin", checkinKind: "event", ...row, checkedInAt: iso(row.checkedInAt), checkedOutAt: iso(row.checkedOutAt),
            eventId: of.eventId, name: of.name, guardianName: of.guardianName, branchId: of.branchId, park: of.park };
        }),
        ...head(camperDays).map(({ registrationId, ...row }): SupportRecord => {
          const of = camperById.get(registrationId)!;
          return { record: "checkin", checkinKind: "camp", ...row, checkedInAt: iso(row.checkedInAt), checkedOutAt: iso(row.checkedOutAt),
            eventId: of.eventId, name: of.name, guardianName: of.guardianName, branchId: of.branchId, park: of.park };
        }),
      ];
      const truncated = [staff, advisors, events, attendees, campers, services, dropoffs, attendeeDays, camperDays]
        .some((rows) => rows.length > SUPPORT_LOOKUP_LIMIT);
      return { records, limit: SUPPORT_LOOKUP_LIMIT, truncated };
    },
    { accessMode: "read only" },
  );
}

/** Mounted by `registerRoutes`, which owns the park-group fence's strict rule. */
export function supportLookupRouter(parkGroupOnly: RequestHandler): Router {
  const router = Router();
  router.get("/api/support/by-phone", requireAuth, requireManager, parkGroupOnly, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = QuerySchema.safeParse(req.query);
      if (!query.success) return res.status(400).json({ message: "A phone number is required" });
      const { normalized, error } = identifyEmployeeByPhoneInput(query.data.phone);
      if (error) return res.status(400).json({ message: error });
      const user = req.userWithAccess;
      if (!user) return res.status(403).json({ message: "Access denied" });
      const scope = await getAllowedOperatorAndBranchIds(user);
      res.setHeader("cache-control", "private, no-store");
      return res.json(await supportRecordsByPhone(parkGroupOf(res), scope.branchIds, normalized));
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
