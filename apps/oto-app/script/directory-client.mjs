/**
 * Issue, list and revoke the directory API's tenant-bound keys
 * (`directory_clients`, migration 0003; checked by
 * server/directory/clientAuth.ts).
 *
 *   npm run directory:client -- create --tenant <tenant uuid> --name <who> [--scope events:write]
 *   npm run directory:client -- list [--tenant <tenant uuid>]
 *   npm run directory:client -- revoke --id <client uuid>
 *
 * `create` prints the key ONCE. Only its sha256 is stored, so a lost key is
 * revoked and a new one issued; it cannot be read back. Put it straight into
 * the caller's secret store (the platform api's environment) and nowhere else.
 *
 * Plain JavaScript for the same reason as migrate.mjs: the runtime image has
 * no tsx, and this has to run there, against the deployment's own database.
 * The hashing is the same one-liner as `hashDirectoryKey` in clientAuth.ts.
 *
 * DATABASE_URL in the environment.
 */
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const SCHEMA = "otoapp";
const SCOPES = ["events:write"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  console.error(`\ndirectory-client: ${message}\n`);
  process.exit(1);
}

function options(argv) {
  const out = { scope: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) fail(`unexpected argument "${flag}"`);
    const key = flag.slice(2);
    if (key === "scope") out.scope.push(value);
    else out[key] = value;
    i += 1;
  }
  return out;
}

const [command, ...rest] = process.argv.slice(2);
const opts = options(rest);
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set.");

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  application_name: "oto-app-directory-client",
});
await client.connect();

try {
  if (command === "create") {
    if (!opts.tenant || !UUID.test(opts.tenant)) fail("--tenant <tenant uuid> is required.");
    if (!opts.name || !opts.name.trim()) fail("--name <who the key is for> is required.");
    const scopes = opts.scope.length ? opts.scope : ["events:write"];
    const unknown = scopes.filter((s) => !SCOPES.includes(s));
    if (unknown.length) fail(`unknown scope ${unknown.join(", ")}; known: ${SCOPES.join(", ")}`);

    const tenant = await client.query(`select id, name from ${SCHEMA}.tenants where id = $1`, [opts.tenant]);
    if (tenant.rowCount === 0) fail(`no tenant ${opts.tenant} in ${SCHEMA}.tenants.`);

    const key = "odk_" + randomBytes(32).toString("base64url");
    const keyHash = createHash("sha256").update(key).digest("hex");
    const { rows } = await client.query(
      `insert into ${SCHEMA}.directory_clients (tenant_id, name, key_hash, scopes)
       values ($1, $2, $3, $4) returning id`,
      [opts.tenant, opts.name.trim(), keyHash, scopes],
    );
    console.log(`directory client ${rows[0].id}`);
    console.log(`  tenant  ${tenant.rows[0].name} (${opts.tenant})`);
    console.log(`  name    ${opts.name.trim()}`);
    console.log(`  scopes  ${scopes.join(", ")}`);
    console.log(`  key     ${key}`);
    console.log("\nThe key is shown this once. Store it in the caller's secret store now.");
  } else if (command === "list") {
    const params = [];
    let where = "";
    if (opts.tenant) {
      if (!UUID.test(opts.tenant)) fail("--tenant must be a uuid.");
      params.push(opts.tenant);
      where = "where c.tenant_id = $1";
    }
    const { rows } = await client.query(
      `select c.id, c.name, c.scopes, c.is_active, c.revoked_at, c.last_used_at, t.name as tenant
         from ${SCHEMA}.directory_clients c join ${SCHEMA}.tenants t on t.id = c.tenant_id
         ${where} order by c.created_at`,
      params,
    );
    if (rows.length === 0) console.log("no directory clients");
    for (const r of rows) {
      const state = r.revoked_at ? `revoked ${r.revoked_at.toISOString()}` : r.is_active ? "active" : "inactive";
      const used = r.last_used_at ? r.last_used_at.toISOString() : "never";
      console.log(`${r.id}  ${r.tenant}  ${r.name}  [${r.scopes.join(", ")}]  ${state}  last used ${used}`);
    }
  } else if (command === "revoke") {
    if (!opts.id || !UUID.test(opts.id)) fail("--id <client uuid> is required.");
    const { rowCount } = await client.query(
      `update ${SCHEMA}.directory_clients
          set is_active = false, revoked_at = coalesce(revoked_at, now()), updated_at = now()
        where id = $1`,
      [opts.id],
    );
    if (rowCount === 0) fail(`no directory client ${opts.id}.`);
    console.log(`directory client ${opts.id} revoked`);
  } else {
    fail("usage: directory-client.mjs create|list|revoke [options] (see the header of this file)");
  }
} finally {
  await client.end();
}
