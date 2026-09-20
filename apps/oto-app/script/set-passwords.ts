/**
 * One-off script: set all user passwords to Password123!
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx script/set-passwords.ts
 *
 * For the dev environment:
 *   cd infra/pulumi
 *   APP_URL=$(pulumi stack output database_url --stack shared --show-secrets \
 *     | python3 -c "import sys,re; u=sys.stdin.read().strip(); u=u.replace('sslmode=no-verify','sslmode=require'); u=re.sub(r'(:\d+)/oto([?])', r'\1/oto_dev\2', u); print(u)")
 *   cd ../..
 *   DATABASE_URL="$APP_URL" npx tsx script/set-passwords.ts
 */

import { db } from "../server/db";
import { users } from "../shared/schema";
import { hashPassword } from "../server/auth";

const PASSWORD = "Password123!";

const hash = await hashPassword(PASSWORD);
await db.update(users).set({ password: hash });
console.log(`Updated all user passwords to ${PASSWORD}`);

process.exit(0);
