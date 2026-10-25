// Native Staff payroll status checks run on their own disposable database.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const appDir = fileURLToPath(new URL("../", import.meta.url));
let server: URL;
try { server = new URL(process.env.DATABASE_URL ?? ""); }
catch { throw new Error("SCRUM_634_ISOLATED_DATABASE_REQUIRED"); }
if (!(process.env.CI === "true" || process.env.SCRUM_634_SUITE === "1")
  || !["postgres:", "postgresql:"].includes(server.protocol)
  || !["localhost", "127.0.0.1", "::1", "pg"].includes(server.hostname.replace(/^\[|\]$/g, ""))
  || server.search || server.hash
  || !(server.pathname === "/otoapp_ci" || /^\/zz_test_634_[a-z0-9_]+$/.test(server.pathname))) {
  throw new Error("SCRUM_634_ISOLATED_DATABASE_GUARD_REFUSED");
}
const database = "zz_test_634_ci_" + randomBytes(12).toString("hex");
if (!/^zz_test_634_ci_[a-f0-9]{24}$/.test(database)) throw new Error("SCRUM_634_OWN_DATABASE_REQUIRED");
const target = new URL(server); target.pathname = "/" + database;
const admin = new pg.Client({ connectionString: server.href, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (/^(?:DATABASE_URL|TEST_DATABASE_URL|REHEARSAL_DATABASE_URL|PLATFORM_API_URL|OTOAPP_PROVISION_|TWILIO_|RENDER_|AWS_|SENTRY_|VITE_SENTRY_|ANTHROPIC_|OPENAI_)/.test(key)) delete environment[key];
}
Object.assign(environment, { DATABASE_URL: target.href, DB_SCHEMA: "otoapp", NODE_ENV: "test", APP_ENV: "dev", DEPLOY_ENV: "local",
  OBJECT_STORAGE: "local", OTOAPP_JOBS: "platform", LOG_LEVEL: "warn", CI: "false", SCRUM_633_SUITE: "0", SCRUM_634_SUITE: "0" });
let active: ChildProcess | undefined;
function stop() {
  if (!active?.pid) return;
  if (process.platform !== "win32") { try { process.kill(-active.pid, "SIGKILL"); return; } catch { /* Already closed. */ } }
  active.kill("SIGKILL");
}
async function command(label: string, args: string[], expectedChecks?: number) {
  let stdout = "", bytes = 0, timedOut = false, outputLimited = false, failedToSpawn = false;
  const child = spawn(process.execPath, args, { cwd: appDir, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  active = child;
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4_000_000) { outputLimited = true; stop(); } else stdout += chunk; });
  child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4_000_000) { outputLimited = true; stop(); } });
  child.on("error", () => { failedToSpawn = true; });
  const timer = setTimeout(() => { timedOut = true; stop(); }, 180_000);
  const exitCode = await new Promise<number | null>(resolve => child.on("close", resolve));
  clearTimeout(timer); stop(); active = undefined;
  const summaries: Array<{ passed: number; total: number; cases: Record<string, { passed: boolean }> }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    try { const value = JSON.parse(line); if (value.suite === "s634-payroll-status") summaries.push(value); } catch { /* Non-summary output stays private. */ }
  }
  const result = summaries[0];
  const countsMatch = expectedChecks === undefined || (summaries.length === 1 && result?.passed === expectedChecks
    && result.total === expectedChecks && Object.keys(result.cases).length === expectedChecks && Object.values(result.cases).every(row => row.passed));
  const passed = exitCode === 0 && !timedOut && !outputLimited && !failedToSpawn && countsMatch;
  console.log(JSON.stringify({ stage: label, passed, exitCode, timedOut, outputLimited, failedToSpawn,
    checksPassed: result?.passed ?? null, checksTotal: result?.total ?? null, stdoutSha256: createHash("sha256").update(stdout).digest("hex") }));
  if (!passed) throw new Error("SCRUM_634_CHILD_CHECK_FAILED");
}
let creationAttempted = false, complete = false, removed = false;
try {
  await admin.connect();
  if ((await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [database])).rows[0].n !== 0) throw new Error("SCRUM_634_DATABASE_ALREADY_EXISTS");
  creationAttempted = true; await admin.query('CREATE DATABASE "' + database + '"');
  const fixture = new pg.Client({ connectionString: target.href });
  try { await fixture.connect(); await fixture.query("CREATE SCHEMA otoapp"); } finally { await fixture.end(); }
  await command("standalone-app-migrate", [join(appDir, "script/migrate.mjs")]);
  await command("s634-payroll-status", [join(appDir, "node_modules/tsx/dist/cli.mjs"), join(appDir, "tests/s634-payroll-status.check.ts")], 9);
  complete = true;
} catch {
  process.exitCode = 1; console.error("s634-suite.check: a guarded child or isolated setup failed");
} finally {
  stop();
  try {
    if (creationAttempted) {
      await admin.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
      removed = (await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [database])).rows[0].n === 0;
    }
  } catch { process.exitCode = 1; }
  finally { await admin.end().catch(() => {}); }
  console.log(JSON.stringify({ suite: "s634", passed: complete && removed, checks: complete ? 9 : null, ownDatabaseRemoved: removed }));
  if (!complete || !removed) process.exitCode = 1;
}
