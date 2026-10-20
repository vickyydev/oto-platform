import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { employees, users } from "../../shared/schema";

/**
 * The signed-in person's own employee record, resolved the way My Account
 * resolves it (GET /api/my-account/employee-info in server/routes.ts): the
 * record whose login is this user first, then the record with this user's
 * email (case-insensitive), then the record with this user's phone (the last
 * nine digits, as My Account compares them).
 *
 * Fences:
 *  - only records of the user's own park group (`tenantId`) are considered;
 *  - the email and phone steps consider only records with no login attached,
 *    so a record that belongs to another login is never taken for this one;
 *  - an email or phone shared by more than one such record resolves to no
 *    record rather than to an arbitrary one.
 *
 * Returns null when nothing matches; a caller then behaves as for a login
 * with no employee record.
 */
export async function resolveSelfEmployeeId(userId: string, tenantId: string | null | undefined): Promise<string | null> {
  if (!userId || !tenantId) return null;

  const [linked] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, userId), eq(employees.tenantId, tenantId)))
    .limit(1);
  if (linked) return linked.id;

  const [user] = await db
    .select({ email: users.email, phoneE164: users.phoneE164, phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const unlinkedInGroup = and(eq(employees.tenantId, tenantId), isNull(employees.userId));

  if (user.email) {
    const byEmail = await db
      .select({ id: employees.id })
      .from(employees)
      .where(and(unlinkedInGroup, sql`LOWER(${employees.email}) = LOWER(${user.email})`))
      .limit(2);
    if (byEmail.length === 1) return byEmail[0].id;
    if (byEmail.length > 1) return null;
  }

  const phone = (user.phoneE164 || user.phoneNumber || "").replace(/\D/g, "").slice(-9);
  if (phone.length >= 9) {
    const byPhone = await db
      .select({ id: employees.id })
      .from(employees)
      .where(and(unlinkedInGroup, sql`RIGHT(REGEXP_REPLACE(${employees.phone}, '[^0-9]', '', 'g'), 9) = ${phone}`))
      .limit(2);
    if (byPhone.length === 1) return byPhone[0].id;
  }

  return null;
}
