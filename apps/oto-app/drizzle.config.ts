import { defineConfig } from "drizzle-kit";

/**
 * Generating SQL needs no database — only `push` and `introspect` connect, and
 * neither is ever run against the platform database. So an unset DATABASE_URL
 * is left to fail at the point a command actually opens a connection, instead
 * of stopping `generate` on a machine that has no database at all.
 */
export default defineConfig({
  out: "./migrations",
  schema: ["./shared/schema.ts", "./server/db/coreSchema.ts"],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  /**
   * The 184 table definitions carry no schema, so Drizzle models them as
   * `public` and writes unqualified SQL. The real schema is chosen when the
   * SQL is applied: `script/migrate.mjs` sets `search_path` to `otoapp`
   * first. Keeping the filter at `public` stops a diff from noticing — and
   * offering to drop — the platform's own schemas on the same database.
   */
  schemaFilter: ["public"],
});
