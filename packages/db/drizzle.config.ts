import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set (see .env.example at the repository root)');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL },
  /**
   * Only the schemas this package owns (S2-01b): `OWNED_SCHEMAS` in
   * `src/schema/helpers.ts`, spelled out here because drizzle-kit loads this
   * file on its own. `inbox` joined with I1 (SCRUM-578). Everything else on the
   * same database — the lifted apps' schemas (`otoapp`, `radar`) and the job
   * runner's managed `pgboss` — is migrated by its own tool, and without this
   * filter a Drizzle diff would offer to drop every one of them.
   */
  schemaFilter: ['core', 'crm', 'pos', 'promo', 'booth', 'analytics', 'edge', 'inbox'],
  strict: true,
  verbose: true,
});
