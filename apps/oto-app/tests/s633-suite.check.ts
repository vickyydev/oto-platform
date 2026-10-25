// The existing suite-sign-in CI entry imports this after its own cleanup.
// A standalone app migration plus one ownership-only core fixture runs all39
// SCRUM-633 app checks without platform migrations, providers or shared data.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
let server: URL;
try { server = new URL(process.env.DATABASE_URL ?? ""); }
catch { throw new Error("SCRUM_633_ISOLATED_DATABASE_REQUIRED"); }
const host = server.hostname.replace(/^\[|\]$/g, "");
let baseName: string;
try { baseName = decodeURIComponent(server.pathname.slice(1)); }
catch { throw new Error("SCRUM_633_ISOLATED_DATABASE_REQUIRED"); }
if (!(process.env.CI === "true" || process.env.SCRUM_633_SUITE === "1")
  || !["postgres:", "postgresql:"].includes(server.protocol)
  || server.search !== "" || server.hash !== ""
  || !["localhost", "127.0.0.1", "::1", "pg"].includes(host)
  || !(baseName === "otoapp_ci" || /^zz_test_633_[a-z0-9_]+$/.test(baseName))) {
  throw new Error("SCRUM_633_ISOLATED_DATABASE_GUARD_REFUSED");
}

const database = "zz_test_633_ci_" + randomBytes(12).toString("hex");
if (!/^zz_test_633_ci_[a-f0-9]{24}$/.test(database)) throw new Error("SCRUM_633_OWN_DATABASE_REQUIRED");
const target = new URL(server.href); target.pathname = "/" + database;
const admin = new pg.Client({ connectionString: server.href, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (/^(?:DATABASE_URL|TEST_DATABASE_URL|REHEARSAL_DATABASE_URL|PLATFORM_API_URL|OTOAPP_PROVISION_|TWILIO_|RENDER_|AWS_|SENTRY_|VITE_SENTRY_|ANTHROPIC_|OPENAI_)/.test(key)) delete environment[key];
}
Object.assign(environment, { DATABASE_URL: target.href, APP_ENV: "dev", NODE_ENV: "test", DEPLOY_ENV: "local", DB_SCHEMA: "otoapp",
  OBJECT_STORAGE: "local", STORAGE_ENV_PREFIX: "zz-test-633-ci", OTOAPP_JOBS: "platform", LOG_LEVEL: "warn", CI: "false", SCRUM_633_SUITE: "0",
  SCRUM_633_LIFECYCLE_TESTS: "1", SCRUM_633_EXPECT_DB_HOST: target.hostname, SCRUM_633_EXPECT_DB_NAME: database });
for (const key of ["SESSION_SECRET", "SESSION_PEPPER", "KIOSK_CODE_PEPPER", "PIN_FINGERPRINT_SECRET"]) environment[key] = randomBytes(32).toString("hex");

let activeChild: ChildProcess | undefined;
function stopChild() {
  if (!activeChild?.pid) return;
  if (process.platform !== "win32") { try { process.kill(-activeChild.pid, "SIGKILL"); return; } catch { /* already closed */ } }
  activeChild.kill("SIGKILL");
}
async function command(label: string, argv: string[], expectedChecks?: number) {
  let stdout = "", bytes = 0, timedOut = false, failedToSpawn = false, outputLimited = false;
  const child = spawn(process.execPath, argv, { cwd: APP_DIR, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  activeChild = child;
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4_000_000) { outputLimited = true; stopChild(); } else stdout += chunk; });
  // Child errors can contain request bodies or credentials: never forward them.
  child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4_000_000) { outputLimited = true; stopChild(); } });
  child.on("error", () => { failedToSpawn = true; });
  const timer = setTimeout(() => { timedOut = true; stopChild(); }, 120_000);
  let exitCode: number | null = null, signal: NodeJS.Signals | null = null;
  try { ({ exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, reason) => resolve({ exitCode: code, signal: reason })))); }
  finally { clearTimeout(timer); stopChild(); activeChild = undefined; }
  const summaries = stdout.split(/\r?\n/).filter(line => /^s633-[a-z-]+\.check: \d+\/\d+ (?:checks )?passed$/.test(line));
  const summary = summaries.length === 1 ? summaries[0].match(/: (\d+)\/(\d+) (?:checks )?passed$/) : null;
  const countsMatch = expectedChecks === undefined || (summary !== null && Number(summary[1]) === expectedChecks && Number(summary[2]) === expectedChecks);
  const passed = exitCode === 0 && signal === null && !timedOut && !failedToSpawn && !outputLimited && countsMatch;
  console.log(JSON.stringify({ stage: label, passed, exitCode, signal, timedOut, failedToSpawn, outputLimited,
    ...(expectedChecks === undefined ? {} : { expectedChecks, checksPassed: summary ? Number(summary[1]) : null, checksTotal: summary ? Number(summary[2]) : null }),
    stdoutSha256: createHash("sha256").update(stdout).digest("hex") }));
  if (!passed) throw new Error("SCRUM_633_CHILD_CHECK_FAILED");
}
async function setupTarget(statement: string) {
  const client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  try { await client.connect(); await client.query(statement); } finally { await client.end(); }
}

let creationAttempted = false, completed = false, removed = false;
try {
  await admin.connect();
  if ((await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [database])).rows[0].n !== 0) throw new Error("SCRUM_633_DATABASE_ALREADY_EXISTS");
  creationAttempted = true;
  await admin.query('CREATE DATABASE "' + database + '"');
  await setupTarget("CREATE SCHEMA otoapp");
  await command("standalone-app-migrate", [join(APP_DIR, "script/migrate.mjs")]);
  // Ownership metadata only. No platform migration, account, identity, role,
  // grant or employee fixture is provisioned by this minimal core table.
  await setupTarget("CREATE SCHEMA core; CREATE TABLE core.account (id uuid PRIMARY KEY)");
  const tsx = join(APP_DIR, "node_modules/tsx/dist/cli.mjs");
  for (const [file, expected] of [
    ["s633-employee-suite-sign-in.check.ts", 15],
    ["s633-employee-wizard.check.ts", 9],
    ["s633-lifecycle.check.ts", 11],
    ["s633-lifecycle-privileges.check.ts", 4],
  ] as const) await command(file, [tsx, join(APP_DIR, "tests", file)], expected);
  completed = true;
} catch {
  process.exitCode = 1;
  console.error("s633-suite.check: a guarded child or isolated setup failed");
} finally {
  stopChild();
  try {
    if (creationAttempted) {
      await admin.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
      removed = (await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [database])).rows[0].n === 0;
    }
  } catch { process.exitCode = 1; }
  finally { await admin.end().catch(() => {}); }
  console.log(JSON.stringify({ suite: "s633", passed: completed && removed, checks: completed ? 39 : null, ownDatabaseRemoved: removed }));
  if (!completed || !removed) process.exitCode = 1;
}
