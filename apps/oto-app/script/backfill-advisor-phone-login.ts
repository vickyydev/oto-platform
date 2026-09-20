/**
 * One-off backfill: ensure phone_e164 is populated on both `people` and the
 * linked `users` row for advisors whose accounts were created before phone
 * normalisation was added to the creation path.
 *
 * Root cause: the admin UI only sends `phone_number`; `phone_e164` was never
 * derived server-side on create/update, so it was left null even when
 * `phone_number` already contained an E.164 value (e.g. "+66818953926").
 *
 * This script:
 *   1. Normalises `people.phone_number` → `people.phone_e164` where the
 *      latter is null/empty.
 *   2. Copies the resolved phone fields from `people` → the linked `users`
 *      row (matched by email) where the user fields are null/empty.
 *
 * Only non-null, non-empty values are written; existing values are never
 * overwritten.
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx script/backfill-advisor-phone-login.ts
 */

import { db } from "../server/db";
import { users, people } from "../shared/schema";
import { eq, isNull, isNotNull, and, or, sql } from "drizzle-orm";

function normalizeToE164(raw: string): string | null {
  const cleaned = raw.replace(/\D/g, '');
  if (!cleaned) return null;
  if (raw.trimStart().startsWith('+')) return '+' + cleaned;   // already E.164
  if (cleaned.startsWith('66')) return '+' + cleaned;
  if (cleaned.startsWith('0'))  return '+66' + cleaned.substring(1);
  return '+' + cleaned;
}

// ── Step 1: fix people.phone_e164 ────────────────────────────────────────────

const peopleNeedingE164 = await db
  .select({ id: people.id, email: people.email, phoneNumber: people.phoneNumber })
  .from(people)
  .where(
    and(
      isNull(people.phoneE164),
      isNotNull(people.phoneNumber),
      sql`trim(${people.phoneNumber}) <> ''`
    )
  );

console.log(`Step 1: ${peopleNeedingE164.length} people row(s) need phone_e164 derived.`);

let step1Updated = 0;
for (const row of peopleNeedingE164) {
  const e164 = normalizeToE164(row.phoneNumber!);
  if (!e164) {
    console.log(`  SKIP ${row.email} — could not normalise "${row.phoneNumber}"`);
    continue;
  }
  await db.update(people)
    .set({ phoneE164: e164, updatedAt: new Date() })
    .where(eq(people.id, row.id));
  console.log(`  ✓ people  ${row.email}  phone_e164 = ${e164}`);
  step1Updated++;
}

// ── Step 2: fix users phone fields from linked people row ────────────────────

// Re-fetch people after step 1 so we have the freshest phone_e164 values.
const advisorPeople = await db
  .select({
    email: people.email,
    phoneNumber: people.phoneNumber,
    phoneE164: people.phoneE164,
  })
  .from(people)
  .where(
    and(
      isNotNull(people.phoneE164),
      sql`trim(${people.phoneE164}) <> ''`
    )
  );

console.log(`\nStep 2: checking ${advisorPeople.length} people row(s) against linked users.`);

let step2Updated = 0;
for (const person of advisorPeople) {
  const [linkedUser] = await db
    .select({ id: users.id, phoneE164: users.phoneE164 })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${person.email})`)
    .limit(1);

  if (!linkedUser) continue;                    // no login account — skip
  if (linkedUser.phoneE164) continue;           // already has a phone — skip

  await db.update(users)
    .set({
      phoneNumber: person.phoneNumber,
      phoneE164: person.phoneE164,
      updatedAt: new Date(),
    })
    .where(eq(users.id, linkedUser.id));

  console.log(`  ✓ users   ${person.email}  phone_e164 = ${person.phoneE164}`);
  step2Updated++;
}

console.log(`\nDone. people updated: ${step1Updated}, users updated: ${step2Updated}.`);
process.exit(0);
