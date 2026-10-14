import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db as database } from "./db";
import { campRegistrations, coreEvents as coreEventsTable, type CampRegistration } from "@shared/schema";
import { CampFamilyError, campPhone, campFamilyEvent, matchingCampRegistrations, createCampFamilyVerification, withCampFamilyAccess, type CampSmsProvider } from "./camp-family-verification";

type Transaction = Parameters<Parameters<typeof database.transaction>[0]>[0];
type PhotoField = "childPhotoUrl" | "parentPhotoUrl" | "pickupPhotoUrl";
type CampIdentity = { id: string; tenantId: string; branchId: string | null };
type Dependencies = {
  campPreviewUrl: (registration: Pick<CampRegistration, "id" | "eventId" | "tenantId"> & Partial<CampRegistration>, field: PhotoField, branchId: string | null, proofExpiresAt?: number) => string | null;
  resolveCampAttachment: (supplied: unknown, field: PhotoField, event: CampIdentity, actor: string,
    identity: { childName?: string; phone?: string; registrationIds?: string[] }) => Promise<string | null | false>;
  provider?: CampSmsProvider;
};
type Submission = Record<string, any>; // Keep the existing public form payload during this extraction.

export function registerCampRegistrationRoutes(app: Express, dependencies: Dependencies) {
  const { campPreviewUrl, resolveCampAttachment } = dependencies;
  const verification = createCampFamilyVerification(dependencies.provider);
  const fail = (res: Response, error: unknown) => res.status(error instanceof CampFamilyError ? error.status : 500)
    .json({ message: error instanceof CampFamilyError ? error.message : "Camp registration could not be completed." });
  const privateResponse = (res: Response) => { res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Referrer-Policy", "no-referrer"); };
  const lookup = async (db: Transaction, eventId: string, phone: string, allowedIds: string[], proofExpiresAt?: Date) => {

      if (!eventId || !phone || phone.trim().length < 5) return { status: 200, data: { found: false } };

      const event = await db
        .select({ tenantId: coreEventsTable.tenantId })
        .from(coreEventsTable)
        .where(and(eq(coreEventsTable.id, eventId), eq(coreEventsTable.eventType, "camp")))
        .limit(1);
      if (!event.length) return { status: 200, data: { found: false } };

      // Fetch ALL registrations across ALL camps for this phone number, newest first.
      // Also match if the phone appears anywhere in authorizedPickupPersons (e.g. after a merge).
      const phoneTrimmed = phone.trim();
      const regs = await db
        .select({
          id: campRegistrations.id,
          tenantId: campRegistrations.tenantId,
          eventId: campRegistrations.eventId,
          childFullName: campRegistrations.childFullName,
          dateOfBirth: campRegistrations.dateOfBirth,
          parentGuardianName: campRegistrations.parentGuardianName,
          emergencyContactNumber: campRegistrations.emergencyContactNumber,
          authorizedPickupPersons: campRegistrations.authorizedPickupPersons,
          parentContacts: campRegistrations.parentContacts,
          foodRestrictions: campRegistrations.foodRestrictions,
          allergies: campRegistrations.allergies,
          behavioralNotes: campRegistrations.behavioralNotes,
          primaryLanguage: campRegistrations.primaryLanguage,
          childPhotoUrl: campRegistrations.childPhotoUrl,
          pickupPhotoUrl: campRegistrations.pickupPhotoUrl,
          attendanceDays: campRegistrations.attendanceDays,
          agreedCampRulesDate: campRegistrations.agreedCampRulesDate,
          createdAt: campRegistrations.createdAt,
        })
        .from(campRegistrations)
        .where(and(
          eq(campRegistrations.tenantId, event[0].tenantId),
          inArray(campRegistrations.id, allowedIds),
          or(
            eq(campRegistrations.emergencyContactNumber, phoneTrimmed),
            sql`${campRegistrations.parentContacts} IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(${campRegistrations.parentContacts}) AS e WHERE e->>'phone' = ${phoneTrimmed})`,
            sql`${campRegistrations.authorizedPickupPersons} ilike ${'%' + phoneTrimmed + '%'}`
          )
        ))
        .orderBy(desc(campRegistrations.createdAt));

      if (!regs.length) return { status: 200, data: { found: false } };
      const photoEvents = await db.select({ id: coreEventsTable.id, branchId: coreEventsTable.branchId })
        .from(coreEventsTable).where(and(
          eq(coreEventsTable.tenantId, event[0].tenantId),
          inArray(coreEventsTable.id, [...new Set(regs.map(reg => reg.eventId))]),
        ));
      const photoBranchByEvent = new Map(photoEvents.map(row => [row.id, row.branchId]));

      // Determine if the phone matched the primary number or only as a secondary/pickup number
      const matchedPrimary = regs.some(r => r.emergencyContactNumber.trim() === phoneTrimmed);

      // Deduplicate children by name — keep the most recent record per child
      // Also check which children are already registered for the requested eventId
      const seen = new Set<string>();
      const uniqueChildren: Array<{
        childFullName: string;
        dateOfBirth: string | null;
        primaryLanguage: string | null;
        childPhotoUrl: string | null;
        childPhotoPreviewUrl: string | null;
        allergies: string | null;
        behavioralNotes: string | null;
        alreadyRegisteredForThisCamp: boolean;
        registeredDates: string[];
        existingRegistrationId: string | null;
      }> = [];

      for (const reg of regs) {
        const key = reg.childFullName.trim().toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          // Check if this child has a registration for the current camp
          const currentCampReg = regs.find(
            r => r.childFullName.trim().toLowerCase() === key && r.eventId === eventId
          );
          uniqueChildren.push({
            childFullName: reg.childFullName,
            dateOfBirth: reg.dateOfBirth,
            primaryLanguage: reg.primaryLanguage,
            childPhotoUrl: reg.childPhotoUrl,
            childPhotoPreviewUrl: campPreviewUrl(reg, "childPhotoUrl", photoBranchByEvent.get(reg.eventId) ?? null, proofExpiresAt?.getTime()),
            allergies: reg.allergies || reg.foodRestrictions || null,
            behavioralNotes: reg.behavioralNotes,
            alreadyRegisteredForThisCamp: !!currentCampReg,
            registeredDates: currentCampReg?.attendanceDays ?? [],
            existingRegistrationId: currentCampReg?.id ?? null,
          });
        }
      }

      // Parent info from most recent registration
      const latest = regs[0];

      // Agreement validity: the most recent signing date, valid only if within the same
      // calendar year as the event (same "camp season").
      // Fetch event date to determine season boundary
      const eventRecord = await db
        .select({ eventDate: coreEventsTable.eventDate })
        .from(coreEventsTable)
        .where(eq(coreEventsTable.id, eventId))
        .limit(1);
      const campYear = eventRecord.length ? new Date(eventRecord[0].eventDate).getFullYear() : new Date().getFullYear();

      // Gather all agreement dates from all registrations, sorted newest first
      const allRulesDates = regs
        .map(r => r.agreedCampRulesDate)
        .filter((d): d is Date => d != null)
        .sort((a, b) => b.getTime() - a.getTime());

      // A prior agreement is considered valid for this camp if it was signed in the same calendar year
      const validRulesDate = allRulesDates.find(d => d.getFullYear() === campYear) ?? null;

      // Build parentContacts from stored array or fall back to single legacy fields.
      // If this phone is a secondary contact, find and promote it to the front.
      let parentContacts: Array<{name: string; phone: string}>;
      if (latest.parentContacts && Array.isArray(latest.parentContacts) && latest.parentContacts.length > 0) {
        parentContacts = latest.parentContacts;
      } else {
        // Legacy record: construct from single fields
        parentContacts = [{ name: latest.parentGuardianName, phone: latest.emergencyContactNumber }];
      }
      // If the phone matched as a secondary contact (not the primary), zero out any name we'd
      // pre-fill for position 0 — the person typing is a different parent.
      if (!matchedPrimary) {
        parentContacts = parentContacts.map(c => ({ ...c, name: c.phone === phoneTrimmed ? c.name : c.name }));
        // Actually just clear the first contact's name so the new parent types their own name:
        parentContacts = [{ name: "", phone: phoneTrimmed }, ...parentContacts.filter(c => c.phone !== phoneTrimmed)];
      }

      return { status: 200, data: {
        found: true,
        parentContacts,
        authorizedPickupPersons: latest.authorizedPickupPersons,
        pickupPhotoUrl: latest.pickupPhotoUrl,
        pickupPhotoPreviewUrl: campPreviewUrl(latest, "pickupPhotoUrl", photoBranchByEvent.get(latest.eventId) ?? null, proofExpiresAt?.getTime()),
        foodRestrictions: latest.foodRestrictions,
        agreedCampRulesDate: validRulesDate,
        children: uniqueChildren,
      } };
  };

  const submit = async (db: Transaction, body: Submission, allowedIds: string[]) => {
      const {
        eventId,
        childFullName,
        dateOfBirth,
        parentGuardianName: _parentGuardianNameRaw,
        emergencyContactNumber: _emergencyContactNumberRaw,
        parentContacts: _parentContactsRaw,
        allergies,
        foodRestrictions,
        behavioralNotes,
        specialNotes,
        authorizedPickupPersons,
        primaryLanguage,
        childPhotoUrl,
        parentPhotoUrl,
        pickupPhotoUrl,
        agreedCampRules,
        agreedChildHealthy,
        parentSignature,
        signatureDate,
        attendanceDays,
        existingRegistrationId,
        usePriorAgreement,
      } = body;

      // Support both the new parentContacts array and legacy individual fields
      const parentContactsArr: Array<{name: string; phone: string}> | null =
        Array.isArray(_parentContactsRaw) && _parentContactsRaw.length > 0
          ? _parentContactsRaw
          : null;
      const parentGuardianName = parentContactsArr?.[0]?.name || _parentGuardianNameRaw || "";
      const emergencyContactNumber = parentContactsArr?.[0]?.phone || _emergencyContactNumberRaw || "";

      if (!eventId || !childFullName || !dateOfBirth || !parentGuardianName || !emergencyContactNumber || !signatureDate) {
        return { status: 400, data: { message: "Missing required fields" } };
      }
      // Signature required unless the parent is explicitly relying on a valid prior agreement
      if (!parentSignature && !usePriorAgreement) {
        return { status: 400, data: { message: "Missing required fields" } };
      }
      if (!agreedCampRules || !agreedChildHealthy) {
        return { status: 400, data: { message: "Parent must agree to all conditions" } };
      }

      // Verify the event exists and is a camp
      const event = await db
        .select({ id: coreEventsTable.id, tenantId: coreEventsTable.tenantId, branchId: coreEventsTable.branchId, eventType: coreEventsTable.eventType, status: coreEventsTable.status })
        .from(coreEventsTable)
        .where(and(eq(coreEventsTable.id, eventId), eq(coreEventsTable.eventType, "camp")))
        .limit(1);
      if (!event.length) return { status: 404, data: { message: "Camp event not found" } };
      // A cancelled camp takes no public sign-ups or changes; staff still see
      // its existing registrations (the cancel dialog says so).
      if (event[0].status === "cancelled") return { status: 409, data: { message: "This camp has been cancelled, so registration is closed. Please contact the park for details." } };

      const tenantId = event[0].tenantId;
      const normalizedPhone = emergencyContactNumber.trim();
      const normalizedName = childFullName.trim().toLowerCase();
      if (existingRegistrationId && !allowedIds.includes(existingRegistrationId)) return { status: 403, data: { message: "Verify this saved registration before continuing." } };
      const photoIdentity = { childName: childFullName, phone: normalizedPhone, registrationIds: allowedIds };
      const submittedChildPhoto = childPhotoUrl === undefined ? undefined
        : await resolveCampAttachment(childPhotoUrl, "childPhotoUrl", event[0], "public", photoIdentity);
      const submittedParentPhoto = parentPhotoUrl === undefined ? undefined
        : await resolveCampAttachment(parentPhotoUrl, "parentPhotoUrl", event[0], "public", photoIdentity);
      const submittedPickupPhoto = pickupPhotoUrl === undefined ? undefined
        : await resolveCampAttachment(pickupPhotoUrl, "pickupPhotoUrl", event[0], "public", photoIdentity);
      if (submittedChildPhoto === false || submittedParentPhoto === false || submittedPickupPhoto === false) {
        return { status: 400, data: { message: "Invalid camp photo attachment" } };
      }
      const newDays: string[] = Array.isArray(attendanceDays) ? attendanceDays : [];
      const now = new Date();
      // Only stamp a new agreement date/history when the parent is actively re-signing.
      // When usePriorAgreement is true and no fresh signature was provided, we preserve the
      // existing date and skip the history append.
      const isActivelySigning = Boolean(agreedCampRules && parentSignature);
      const agreedRulesDate = isActivelySigning ? now : null;
      const agreedRulesIso = agreedRulesDate ? agreedRulesDate.toISOString() : null;

      // Profile fields — the reusable data that should sync across all registrations for this child+phone
      const profileUpdate = {
        parentGuardianName: parentGuardianName.trim(),
        dateOfBirth,
        allergies: allergies?.trim() || null,
        foodRestrictions: foodRestrictions?.trim() || null,
        behavioralNotes: behavioralNotes?.trim() || null,
        specialNotes: specialNotes?.trim() || null,
        primaryLanguage: primaryLanguage?.trim() || null,
        ...(submittedChildPhoto !== undefined ? { childPhotoUrl: submittedChildPhoto } : {}),
      };

      // Check for an existing registration in this specific camp:
      // ALWAYS require phone ownership match regardless of whether an explicit ID was supplied.
      let existingReg: { id: string; attendanceDays: string[] | null; agreedCampRulesHistory: string[] | null; agreedCampRulesDate: Date | null } | null = null;

      const existingRegSelect = {
        id: campRegistrations.id,
        attendanceDays: campRegistrations.attendanceDays,
        agreedCampRulesHistory: campRegistrations.agreedCampRulesHistory,
        agreedCampRulesDate: campRegistrations.agreedCampRulesDate,
      };

      if (existingRegistrationId) {
        // Verify by ID AND phone — prevents unauthorized modification via guessed ID
        const found = await db
          .select(existingRegSelect)
          .from(campRegistrations)
          .where(and(
            eq(campRegistrations.id, existingRegistrationId),
            eq(campRegistrations.tenantId, tenantId),
            inArray(campRegistrations.id, allowedIds),
            eq(campRegistrations.eventId, eventId),
          ))
          .limit(1);
        if (found.length) existingReg = found[0];
      }

      if (existingRegistrationId && !existingReg) return { status: 403, data: { message: "Saved registration does not belong to this camp." } };

      if (!existingReg) {
        // Fallback / fresh device: match by normalised child name + phone + eventId
        const found = await db
          .select(existingRegSelect)
          .from(campRegistrations)
          .where(and(
            eq(campRegistrations.tenantId, tenantId),
            inArray(campRegistrations.id, allowedIds),
            eq(campRegistrations.eventId, eventId),
            eq(campRegistrations.emergencyContactNumber, normalizedPhone),
            sql`lower(trim(${campRegistrations.childFullName})) = ${normalizedName}`
          ))
          .limit(1);
        if (found.length) existingReg = found[0];
      }

      // Helper to append to agreement history without duplicating the same second
      const buildHistory = (existing: string[] | null): string[] => {
        const history = Array.isArray(existing) ? [...existing] : [];
        if (agreedRulesIso && !history.includes(agreedRulesIso)) {
          history.push(agreedRulesIso);
        }
        return history;
      };

      if (existingReg) {
        // Merge attendance days: union of existing + new, deduplicated and sorted
        const existingDays: string[] = Array.isArray(existingReg.attendanceDays) ? existingReg.attendanceDays : [];
        const mergedDays = Array.from(new Set([...existingDays, ...newDays])).sort();
        const newHistory = buildHistory(existingReg.agreedCampRulesHistory);

        // When using a prior agreement without re-signing, keep the existing signature on file.
        // When a new signature was provided, update it.
        const signatureFields = parentSignature
          ? { parentSignature, signatureDate }
          : {}; // preserve existing signature stored in the row

        const [updated] = await db
          .update(campRegistrations)
          .set({
            ...profileUpdate,
            ...signatureFields,
            authorizedPickupPersons: authorizedPickupPersons?.trim() || null,
            ...(submittedParentPhoto !== undefined ? { parentPhotoUrl: submittedParentPhoto } : {}),
            ...(submittedPickupPhoto !== undefined ? { pickupPhotoUrl: submittedPickupPhoto } : {}),
            parentContacts: parentContactsArr,
            attendanceDays: mergedDays,
            agreedCampRules: Boolean(agreedCampRules),
            agreedChildHealthy: Boolean(agreedChildHealthy),
            agreedCampRulesDate: agreedRulesDate ?? existingReg.agreedCampRulesDate,
            agreedCampRulesHistory: newHistory,
            updatedAt: now,
          })
          .where(and(
            eq(campRegistrations.id, existingReg.id),
            eq(campRegistrations.tenantId, tenantId),
            inArray(campRegistrations.id, allowedIds),
          ))
          .returning();

        // Propagate profile fields to all OTHER registrations for this child+phone (all camps)
        if (updated) {
          await db
            .update(campRegistrations)
            .set({
              ...profileUpdate,
              updatedAt: now,
            })
            .where(and(
              eq(campRegistrations.tenantId, tenantId),
            inArray(campRegistrations.id, allowedIds),
              eq(campRegistrations.emergencyContactNumber, normalizedPhone),
              sql`lower(trim(${campRegistrations.childFullName})) = ${normalizedName}`,
              ne(campRegistrations.id, existingReg.id),
            ));
        }

        return { status: 200, data: updated };
      }

      // No existing registration in this camp — create a new one.
      // When usePriorAgreement is true and no fresh signature was drawn, look up a prior
      // signature + agreement from any other camp registration for this child+phone so we
      // don't violate the NOT NULL constraint on parentSignature.
      let resolvedSignature = parentSignature || null;
      let resolvedAgreedDate = agreedRulesDate;
      let resolvedHistory = buildHistory(null);

      if (!resolvedSignature && usePriorAgreement) {
        const priorReg = await db
          .select({
            parentSignature: campRegistrations.parentSignature,
            signatureDate: campRegistrations.signatureDate,
            agreedCampRulesDate: campRegistrations.agreedCampRulesDate,
            agreedCampRulesHistory: campRegistrations.agreedCampRulesHistory,
          })
          .from(campRegistrations)
          .where(and(
            eq(campRegistrations.tenantId, tenantId),
            inArray(campRegistrations.id, allowedIds),
            eq(campRegistrations.emergencyContactNumber, normalizedPhone),
            sql`lower(trim(${campRegistrations.childFullName})) = ${normalizedName}`,
            sql`${campRegistrations.parentSignature} IS NOT NULL`,
          ))
          .orderBy(desc(campRegistrations.createdAt))
          .limit(1);

        if (priorReg.length) {
          resolvedSignature = priorReg[0].parentSignature;
          // Preserve the prior agreement date and history — no new signing event occurred
          resolvedAgreedDate = priorReg[0].agreedCampRulesDate;
          resolvedHistory = Array.isArray(priorReg[0].agreedCampRulesHistory)
            ? priorReg[0].agreedCampRulesHistory
            : [];
        }
      }

      if (!resolvedSignature) {
        return { status: 400, data: { message: "A signature is required for new registrations." } };
      }

      const [registration] = await db.insert(campRegistrations).values({
        tenantId,
        eventId,
        childFullName: childFullName.trim(),
        dateOfBirth,
        parentGuardianName: parentGuardianName.trim(),
        emergencyContactNumber: normalizedPhone,
        parentContacts: parentContactsArr,
        allergies: allergies?.trim() || null,
        foodRestrictions: foodRestrictions?.trim() || null,
        behavioralNotes: behavioralNotes?.trim() || null,
        specialNotes: specialNotes?.trim() || null,
        authorizedPickupPersons: authorizedPickupPersons?.trim() || null,
        primaryLanguage: primaryLanguage?.trim() || null,
        childPhotoUrl: submittedChildPhoto || null,
        parentPhotoUrl: submittedParentPhoto || null,
        pickupPhotoUrl: submittedPickupPhoto || null,
        attendanceDays: newDays,
        agreedCampRules: Boolean(agreedCampRules),
        agreedChildHealthy: Boolean(agreedChildHealthy),
        agreedCampRulesDate: resolvedAgreedDate,
        agreedCampRulesHistory: resolvedHistory,
        parentSignature: resolvedSignature,
        signatureDate,
      }).returning();

      // Propagate profile fields to any prior registrations for this child+phone in other camps
      if (registration) {
        await db
          .update(campRegistrations)
          .set({
            ...profileUpdate,
            updatedAt: now,
          })
          .where(and(
            eq(campRegistrations.tenantId, tenantId),
            inArray(campRegistrations.id, allowedIds),
            eq(campRegistrations.emergencyContactNumber, normalizedPhone),
            sql`lower(trim(${campRegistrations.childFullName})) = ${normalizedName}`,
            ne(campRegistrations.id, registration.id),
          ));
      }

      return { status: 201, data: registration };
  };

  const publicLookup = async (req: Request, res: Response) => {
    privateResponse(res);
    try {
      const input = req.method === "GET" ? req.query : req.body;
      const phone = campPhone(input.phone);
      const event = await campFamilyEvent(database, input.eventId);
      if (!req.headers["x-camp-family-grant"]) {
        const found = (await matchingCampRegistrations(database, event.tenantId, phone)).length > 0;
        return res.json({ found, verificationRequired: found });
      }
      const result = await withCampFamilyAccess({ eventId: event.id, phone, purpose: "lookup", grant: req.headers["x-camp-family-grant"] },
        (tx, ids, _event, expiresAt) => lookup(tx, event.id, phone, ids, expiresAt));
      res.status(result.status).json({ ...result.data,
        familyGrant: "familyGrant" in result ? result.familyGrant : undefined,
        expiresAt: "expiresAt" in result ? result.expiresAt : undefined });
    } catch (error) { fail(res, error); }
  };
  app.get("/api/public/camp-registrations/lookup", publicLookup);
  app.post("/api/public/camp-registrations/lookup", publicLookup);
  app.post("/api/public/camp-registrations/sms/request", async (req, res) => {
    privateResponse(res);
    try {
      if (req.body.purpose !== "camp-family") throw new CampFamilyError(400, "Choose camp family verification.");
      res.json(await verification.request(req.body.eventId, req.body.phone, req.ip || req.socket.remoteAddress || "unknown"));
    } catch (error) { fail(res, error); }
  });
  app.post("/api/public/camp-registrations/sms/verify", async (req, res) => {
    privateResponse(res);
    try {
      if (req.body.purpose !== "camp-family") throw new CampFamilyError(400, "Choose camp family verification.");
      res.json(await verification.verify(req.body.eventId, req.body.phone, req.body.challengeId, req.body.code));
    } catch (error) { fail(res, error); }
  });
  const submitRoute = (batch: boolean) => async (req: Request, res: Response) => {
    privateResponse(res);
    try {
      const bodies: Submission[] = batch ? req.body.registrations : [req.body];
      if (!Array.isArray(bodies) || !bodies.length || bodies.length > 50 || bodies.some(body => !body || typeof body !== "object"))
        throw new CampFamilyError(400, "Provide the child registrations.");
      const phoneOf = (body: Submission) => campPhone(body.parentContacts?.[0]?.phone || body.emergencyContactNumber);
      const phone = phoneOf(bodies[0]), eventId = bodies[0].eventId;
      if (bodies.some(body => body.eventId !== eventId || phoneOf(body) !== phone))
        throw new CampFamilyError(400, "Use one camp and contact number per submission.");
      const outcome = await withCampFamilyAccess({ eventId, phone, purpose: "write", grant: req.headers["x-camp-family-grant"],
        requiresSaved: bodies.some(body => !!body.existingRegistrationId || !!body.usePriorAgreement),
        childNames: bodies.map(body => typeof body.childFullName === "string" ? body.childFullName.trim().toLowerCase() : "") }, async (tx, ids) => {
        const results = [];
        for (const body of bodies) {
          const result = await submit(tx, body, ids);
          if (result.status >= 400) throw new CampFamilyError(result.status, (result.data as { message: string }).message);
          results.push(result);
        }
        return batch ? { status: 200, data: results.map(result => result.data) } : results[0];
      });
      if ("familyGrant" in outcome && typeof outcome.familyGrant === "string") res.setHeader("X-Camp-Family-Grant", outcome.familyGrant);
      res.status(outcome.status).json(outcome.data);
    } catch (error) { fail(res, error); }
  };
  app.post("/api/public/camp-registrations", submitRoute(false));
  app.post("/api/public/camp-registrations/batch", submitRoute(true));
}
