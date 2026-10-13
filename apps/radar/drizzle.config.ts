import { defineConfig } from "drizzle-kit";

/**
 * Generating SQL needs no database — only `push` and `introspect` connect, and
 * neither is ever run against the platform database. So an unset DATABASE_URL
 * is left to fail where a command actually opens a connection.
 */
export default defineConfig({
  out: "./migrations",
  schema: ["./shared/schema.ts"],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  /**
   * The table definitions carry no schema, so Drizzle models them as `public`
   * and writes unqualified SQL. The real schema is chosen when the SQL is
   * applied: `script/migrate.mjs` sets search_path to `radar` first.
   */
  schemaFilter: ["public"],
});
