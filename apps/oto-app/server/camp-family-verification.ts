import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { db } from "./db";
import { authRateLimits, campFamilyChallenges, campRegistrations, coreEvents } from "@shared/schema";
import { campSmsProvider, normalizePhoneToE164 } from "./twilio-service";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, "select">;
export type CampSmsProvider = typeof campSmsProvider;
export class CampFamilyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const LIFE_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
const PURPOSE = "camp-family";
const digest = (value: string) => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new CampFamilyError(503, "SMS verification is not available yet.");
  return createHmac("sha256", secret).update(`${PURPOSE}:${value}`).digest("hex");
};
export function campPhone(value: unknown): string {
  if (typeof value !== "string" || !/^[+\d\s().-]{8,30}$/.test(value.trim()))
    throw new CampFamilyError(400, "Enter a complete contact number.");
  const phone = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalizePhoneToE164(phone)))
    throw new CampFamilyError(400, "Enter a complete contact number with its country code.");
  return phone;
}
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
export async function campFamilyEvent(reader: Reader, eventId: unknown) {
  if (typeof eventId !== "string" || !uuid.test(eventId)) throw new CampFamilyError(404, "Camp not found");
  const [event] = await reader.select().from(coreEvents)
    .where(and(eq(coreEvents.id, eventId), eq(coreEvents.eventType, "camp"))).limit(1);
  if (!event) throw new CampFamilyError(404, "Camp not found");
  return event;
}

// The same primary, additional-contact and pickup-contact paths remain eligible.
// A pickup match must contain the complete supplied phone, not part of a number.
export function fullPickupPhone(text: string | null, phone: string) {
  if (!text) return false;
  return (text.match(/\+?\d[\d\s().-]*\d/g) ?? []).some(candidate => candidate.trim() === phone);
}
export async function matchingCampRegistrations(reader: Reader, tenantId: string, phone: string, lock = false) {
  const query = reader.select({ registration: campRegistrations }).from(campRegistrations)
    .innerJoin(coreEvents, eq(campRegistrations.eventId, coreEvents.id)).where(and(
      eq(campRegistrations.tenantId, tenantId), eq(coreEvents.tenantId, tenantId), eq(coreEvents.eventType, "camp"),
      or(eq(campRegistrations.emergencyContactNumber, phone),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${campRegistrations.parentContacts}, '[]'::jsonb)) AS contact WHERE contact->>'phone' = ${phone})`,
        sql`position(${phone} in coalesce(${campRegistrations.authorizedPickupPersons}, '')) > 0`),
    )).orderBy(desc(campRegistrations.createdAt), desc(campRegistrations.id));
  const rows = await (lock ? query.for("update", { of: campRegistrations }) : query);
  return rows.map(row => row.registration).filter(row => row.emergencyContactNumber === phone ||
    row.parentContacts?.some(contact => contact.phone === phone) || fullPickupPhone(row.authorizedPickupPersons, phone));
}

async function takeLimits(keys: { key: string; max: number }[]) {
  await db.transaction(async tx => {
    for (const entry of keys.sort((a, b) => a.key.localeCompare(b.key))) {
      const key = `${PURPOSE}:${entry.key}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const now = new Date();
      const [row] = await tx.select().from(authRateLimits)
        .where(and(eq(authRateLimits.key, key), gt(authRateLimits.expiresAt, now))).limit(1);
      if (row && row.count >= entry.max) throw new CampFamilyError(429, "Too many verification attempts. Please try again later.");
      if (row) await tx.update(authRateLimits).set({ count: row.count + 1 }).where(eq(authRateLimits.id, row.id));
      else await tx.insert(authRateLimits).values({ key, count: 1, windowStart: now, expiresAt: new Date(now.getTime() + HOUR_MS) });
    }
  });
}

export function createCampFamilyVerification(provider: CampSmsProvider = campSmsProvider) {
  return {
    async request(eventId: unknown, suppliedPhone: unknown, ip: string) {
      const phone = campPhone(suppliedPhone);
      const event = await campFamilyEvent(db, eventId);
      if (!provider.configured()) throw new CampFamilyError(503, "SMS verification is not available yet. Please contact the park.");
      const phoneE164 = normalizePhoneToE164(phone);
      await takeLimits([{ key: `request-phone:${digest(phoneE164)}`, max: 3 }, { key: `request-ip:${digest(ip)}`, max: 10 }]);
      const registrations = await matchingCampRegistrations(db, event.tenantId, phone);
      if (!registrations.length) return { found: false };
      let providerId: string;
      try { providerId = await provider.send(phoneE164); }
      catch { throw new CampFamilyError(503, "The verification message could not be sent. Please try again later."); }
      const result = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`camp-challenge:${event.id}:${phone}`}, 0))`);
        await tx.update(campFamilyChallenges).set({ state: "expired", grantHash: null }).where(and(
          eq(campFamilyChallenges.eventId, event.id), eq(campFamilyChallenges.tenantId, event.tenantId), eq(campFamilyChallenges.phone, phone),
        ));
        const [challenge] = await tx.insert(campFamilyChallenges).values({ eventId: event.id, tenantId: event.tenantId,
          phone, phoneE164, providerId, registrationIds: registrations.map(row => row.id), expiresAt: new Date(Date.now() + LIFE_MS) }).returning();
        return challenge;
      });
      return { found: true, challengeId: result.id, expiresAt: result.expiresAt };
    },
    async verify(eventId: unknown, suppliedPhone: unknown, challengeId: unknown, code: unknown) {
      const phone = campPhone(suppliedPhone), event = await campFamilyEvent(db, eventId);
      if (typeof challengeId !== "string" || !uuid.test(challengeId) || typeof code !== "string" || !/^\d{6}$/.test(code))
        throw new CampFamilyError(400, "Enter the six-digit verification code.");
      if (!provider.configured()) throw new CampFamilyError(503, "SMS verification is not available yet.");
      await takeLimits([{ key: `verify-phone:${digest(normalizePhoneToE164(phone))}`, max: 5 }]);
      return db.transaction(async tx => {
        const [challenge] = await tx.select().from(campFamilyChallenges).where(and(
          eq(campFamilyChallenges.id, challengeId), eq(campFamilyChallenges.eventId, event.id),
          eq(campFamilyChallenges.tenantId, event.tenantId), eq(campFamilyChallenges.phone, phone),
        )).for("update");
        if (!challenge || challenge.state !== "pending" || challenge.expiresAt.getTime() <= Date.now())
          throw new CampFamilyError(403, "Request a new verification code.");
        let approved: boolean;
        try { approved = await provider.verify(challenge.providerId, code); }
        catch { throw new CampFamilyError(400, "The verification code could not be checked. Please try again."); }
        if (!approved) throw new CampFamilyError(400, "The verification code was not accepted.");
        const grant = randomBytes(32).toString("hex"), expiresAt = new Date(Date.now() + LIFE_MS);
        await tx.update(campFamilyChallenges).set({ state: "verified", grantHash: digest(grant), grantPurpose: "lookup", expiresAt })
          .where(eq(campFamilyChallenges.id, challenge.id));
        return { grant, expiresAt };
      });
    },
  };
}

export async function withCampFamilyAccess<T extends { status: number; data: unknown }>(input: {
  eventId: unknown; phone: unknown; grant: unknown; purpose: "lookup" | "write"; requiresSaved?: boolean; childNames?: string[];
}, work: (tx: Transaction, allowedRegistrationIds: string[], event: Awaited<ReturnType<typeof campFamilyEvent>>, expiresAt?: Date) => Promise<T>) {
  const phone = campPhone(input.phone);
  return db.transaction(async tx => {
    const event = await campFamilyEvent(tx, input.eventId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`camp-family:${event.tenantId}:${phone}`}, 0))`);
    const matches = await matchingCampRegistrations(tx, event.tenantId, phone, true);
    const changesSavedChild = matches.some(row => input.childNames?.includes(row.childFullName.trim().toLowerCase()));
    // A fresh sibling can be registered without authority over any saved row.
    if (!input.grant && input.purpose === "write" && !changesSavedChild && !input.requiresSaved) return work(tx, [], event);
    if (typeof input.grant !== "string" || !/^[a-f\d]{64}$/.test(input.grant))
      throw new CampFamilyError(403, "Verify this contact number before using saved family details.");
    const [challenge] = await tx.select().from(campFamilyChallenges).where(and(
      eq(campFamilyChallenges.grantHash, digest(input.grant)), eq(campFamilyChallenges.tenantId, event.tenantId),
      eq(campFamilyChallenges.eventId, event.id), eq(campFamilyChallenges.phone, phone),
    )).for("update");
    if (!challenge || challenge.state !== "verified" || challenge.grantPurpose !== input.purpose || challenge.expiresAt.getTime() <= Date.now())
      throw new CampFamilyError(403, "Verify this contact number again before continuing.");
    const allowedIds = matches.filter(row => challenge.registrationIds.includes(row.id)).map(row => row.id);
    if (!allowedIds.length) throw new CampFamilyError(403, "Saved family details are no longer available for this number.");
    const result = await work(tx, allowedIds, event, challenge.expiresAt);
    if (result.status >= 400) return result;
    const nextGrant = randomBytes(32).toString("hex");
    const returned = Array.isArray(result.data) ? result.data : [result.data];
    const createdIds = returned.flatMap(row => row && typeof row === "object" && "id" in row && typeof row.id === "string" ? [row.id] : []);
    await tx.update(campFamilyChallenges).set({ grantHash: digest(nextGrant), grantPurpose: "write",
      registrationIds: [...new Set([...challenge.registrationIds, ...createdIds])] })
      .where(eq(campFamilyChallenges.id, challenge.id));
    return { ...result, familyGrant: nextGrant, expiresAt: challenge.expiresAt };
  });
}
