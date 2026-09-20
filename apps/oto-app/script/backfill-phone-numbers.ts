/**
 * One-off backfill: assign a unique Thai phone number and mark it verified
 * for every user that doesn't already have one.
 *
 * Known fixture and named users get their canonical hardcoded numbers.
 * All other users without a phone number get a unique random Thai number.
 * Existing phoneE164 values are preserved untouched.
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx script/backfill-phone-numbers.ts
 *
 * For dev:
 *   DATABASE_URL=postgresql://oto:oto@localhost:5433/oto_dev npx tsx script/backfill-phone-numbers.ts
 *
 * For staging:
 *   cd infra/pulumi
 *   DB_URL=$(pulumi stack output database_url --stack shared --show-secrets \
 *     | python3 -c "import sys,re; u=sys.stdin.read().strip(); u=u.replace('sslmode=no-verify','sslmode=require'); u=re.sub(r'(/oto)([?])', r'\1_staging\2', u); print(u)")
 *   cd ../..
 *   DATABASE_URL="$DB_URL" npx tsx script/backfill-phone-numbers.ts
 */

import { db } from "../server/db";
import { users } from "../shared/schema";
import { isNull, eq } from "drizzle-orm";

// Canonical phone numbers for known accounts — must match fixtures/users.json
// and the hardcoded values in the seed scripts.
const KNOWN_PHONES: Record<string, { phoneE164: string; phoneNumber: string }> = {
  "admin@example.com":              { phoneE164: "+66810000000", phoneNumber: "0810000000" },
  "manager@example.com":            { phoneE164: "+66810000001", phoneNumber: "0810000001" },
  "staff@example.com":              { phoneE164: "+66810000002", phoneNumber: "0810000002" },
  "manager.bangkok@example.com":    { phoneE164: "+66810000010", phoneNumber: "0810000010" },
  "manager.francisco@example.com":  { phoneE164: "+66810000011", phoneNumber: "0810000011" },
};

const affected = await db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(isNull(users.phoneE164));

if (affected.length === 0) {
  console.log("No users without phone numbers. Nothing to do.");
  process.exit(0);
}

console.log(`Backfilling phone numbers for ${affected.length} users...`);

// Collect existing phone numbers to guarantee uniqueness for random assignments
const existing = await db.select({ phoneE164: users.phoneE164 }).from(users);
const usedPhones = new Set(existing.map((r) => r.phoneE164).filter(Boolean));

let updated = 0;
for (const { id, email } of affected) {
  let phoneE164: string;
  let phoneNumber: string;

  if (KNOWN_PHONES[email]) {
    ({ phoneE164, phoneNumber } = KNOWN_PHONES[email]);
  } else {
    do {
      const suffix = Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0");
      phoneE164 = `+6681${suffix}`;
    } while (usedPhones.has(phoneE164));
    phoneNumber = `0${phoneE164.slice(3)}`;
  }

  usedPhones.add(phoneE164);

  await db.update(users)
    .set({
      phoneNumber,
      phoneE164,
      phoneVerified: true,
      phoneVerifiedAt: new Date(),
    })
    .where(eq(users.id, id));

  updated++;
}

console.log(`Done. Updated ${updated} users.`);
process.exit(0);
