/**
 * One-off backfill: rename the beo_cake_mode enum value PROVIDED_BY_US -> INTERNAL.
 *
 * Background: The enum value was renamed to align with the AI parsing prompt which
 * already used INTERNAL. ALTER TYPE ... RENAME VALUE updates the Postgres catalog
 * in-place — all existing rows reflect the new label immediately.
 * Run this once against any database that was populated before the rename.
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx script/backfill-cake-mode-rename.ts
 *
 * For dev:
 *   DATABASE_URL=postgresql://oto:oto@localhost:5433/oto_dev npx tsx script/backfill-cake-mode-rename.ts
 *
 * For staging:
 *   cd infra/pulumi
 *   DB_URL=$(pulumi stack output database_url --stack shared --show-secrets \
 *     | python3 -c "import sys,re; u=sys.stdin.read().strip(); u=u.replace('sslmode=no-verify','sslmode=require'); u=re.sub(r'(/oto)([?])', r'\1_staging\2', u); print(u)")
 *   cd ../..
 *   DATABASE_URL="$DB_URL" npx tsx script/backfill-cake-mode-rename.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";

// Step 1: rename the enum value in Postgres.
// ALTER TYPE ... RENAME VALUE is supported from Postgres 10+.
// This is idempotent: if the old value no longer exists the statement will error,
// so we check first.
const enumCheck = await db.execute(
  sql`SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'beo_cake_mode'
        AND e.enumlabel = 'PROVIDED_BY_US'`
);

if (enumCheck.rows.length === 0) {
  console.log("Enum value PROVIDED_BY_US not found — already renamed or never existed. Nothing to do.");
  process.exit(0);
}

console.log("Renaming enum value PROVIDED_BY_US -> INTERNAL on type beo_cake_mode...");
await db.execute(sql`ALTER TYPE beo_cake_mode RENAME VALUE 'PROVIDED_BY_US' TO 'INTERNAL'`);
console.log("Enum value renamed.");

console.log("Done.");
process.exit(0);
