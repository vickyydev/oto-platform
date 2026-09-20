/**
 * One-off backfill: fix beo_kitchen_plans rows where cake_time is not a valid
 * HH:MM time string. Sets cake_time to 60 minutes after the event's start_time.
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx script/backfill-beo-cake-time.ts
 *
 * For dev:
 *   DATABASE_URL=postgresql://oto:oto@localhost:5433/oto_dev npx tsx script/backfill-beo-cake-time.ts
 *
 * For staging:
 *   cd infra/pulumi
 *   DB_URL=$(pulumi stack output database_url --stack shared --show-secrets \
 *     | python3 -c "import sys,re; u=sys.stdin.read().strip(); u=u.replace('sslmode=no-verify','sslmode=require'); u=re.sub(r'(/oto)([?])', r'\1_staging\2', u); print(u)")
 *   cd ../..
 *   DATABASE_URL="$DB_URL" npx tsx script/backfill-beo-cake-time.ts
 */

import { db } from "../server/db";
import { beoKitchenPlans, coreEvents } from "../server/db/coreSchema";
import { eq } from "drizzle-orm";

const TIME_RE = /^\d{2}:\d{2}$/;

const plans = await db
  .select({ id: beoKitchenPlans.id, eventId: beoKitchenPlans.eventId, cakeTime: beoKitchenPlans.cakeTime })
  .from(beoKitchenPlans);

const invalid = plans.filter(p => p.cakeTime && !TIME_RE.test(p.cakeTime));

if (invalid.length === 0) {
  console.log("No invalid cake_time values found. Nothing to do.");
  process.exit(0);
}

console.log(`Found ${invalid.length} row(s) with invalid cake_time. Fixing...`);

let updated = 0;
for (const plan of invalid) {
  const [event] = await db
    .select({ startTime: coreEvents.startTime })
    .from(coreEvents)
    .where(eq(coreEvents.id, plan.eventId));

  if (!event?.startTime || !TIME_RE.test(event.startTime)) {
    console.warn(`  Skipping plan ${plan.id}: event ${plan.eventId} has no valid start_time`);
    continue;
  }

  const [sh, sm] = event.startTime.split(":").map(Number);
  const cakeMins = sh * 60 + sm + 60;
  const cakeTime = `${String(Math.floor(cakeMins / 60)).padStart(2, "0")}:${String(cakeMins % 60).padStart(2, "0")}`;

  await db
    .update(beoKitchenPlans)
    .set({ cakeTime })
    .where(eq(beoKitchenPlans.id, plan.id));

  console.log(`  Fixed plan ${plan.id}: "${plan.cakeTime}" → "${cakeTime}"`);
  updated++;
}

console.log(`Done. Fixed ${updated} row(s).`);
process.exit(0);
