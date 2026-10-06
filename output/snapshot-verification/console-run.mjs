import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runnerRoot, repoRoot, safeError } from './safe-output.mjs';

const dbRequire = createRequire(resolve(repoRoot, 'packages/db/package.json'));
const consoleRequire = createRequire(resolve(repoRoot, 'apps/console/package.json'));
const pg = dbRequire('pg');
const tsxCli = dbRequire.resolve('tsx/cli');
const playwrightCli = resolve(dirname(consoleRequire.resolve('@playwright/test/package.json')), 'cli.js');
const viteCli = resolve(dirname(consoleRequire.resolve('vite/package.json')), 'bin/vite.js');
const drizzleCli = resolve(repoRoot, 'packages/db/node_modules/drizzle-kit/bin.cjs');
const configPath = resolve(runnerRoot, 'console-native.config.mts');
const runId = `run_${Date.now()}_${randomBytes(4).toString('hex')}`;
const artifactDir = resolve(runnerRoot, 'artifacts', runId);
const resultsPath = resolve(runnerRoot, `results-${runId}.json`);
const ownedPath = relative(runnerRoot, artifactDir);
if (isAbsolute(ownedPath) || ownedPath.startsWith('..') || !ownedPath.startsWith(`artifacts`)) throw new Error('Unsafe artifact path.');
if (![tsxCli, playwrightCli, viteCli, drizzleCli, configPath].every(existsSync)) throw new Error('Native runner dependency is missing.');
if (process.argv.includes('--check')) {
  process.stdout.write('Native Console runner paths verified; no database or process was started.\n');
  process.exit(0);
}

// Match the existing harness without embedding or printing connection values.
const harness = readFileSync(resolve(repoRoot, 'apps/console/e2e/run.mjs'), 'utf8');
const fallback = /process\.env\.TEST_DATABASE_URL\s*\|\|\s*['"]([^'"]+)['"]/.exec(harness)?.[1];
const serverUrl = process.env.CONSOLE_E2E_SERVER_URL || process.env.TEST_DATABASE_URL || fallback;
if (!serverUrl) throw new Error('The existing Console test server could not be resolved.');
const databaseName = `oto_snapshot_console_${Date.now()}_${randomBytes(4).toString('hex')}`;
if (!/^oto_snapshot_console_[0-9]+_[a-f0-9]+$/.test(databaseName)) throw new Error('Unsafe disposable database name.');
const databaseUrl = new URL(serverUrl);
databaseUrl.pathname = `/${databaseName}`;
const children = new Set();
let created = false;
let cancelled = false;
let phase = 'setup';
const record = { status: 'not-run', tests: [], cleanup: { processes: false, database: false } };
mkdirSync(artifactDir, { recursive: true });
const say = (message) => process.stdout.write(`[snapshot-console] ${message}\n`);

function native(args, { cwd = repoRoot, env = {} } = {}) {
  const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  children.add(child);
  let output = '';
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-100_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.completion = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveDone({ code, signal, output }));
  });
  return child;
}
async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') await new Promise((done) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', done); killer.once('exit', done);
  }); else child.kill('SIGTERM');
}
async function stopChildren() { await Promise.all([...children].reverse().map(stopChild)); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; void stopChildren(); });
async function command(label, args, options) {
  phase = label; say(label);
  if (cancelled) throw new Error('Run cancelled.');
  const child = native(args, options);
  const timeout = setTimeout(() => { void stopChild(child); }, label === 'tests' ? 420_000 : 180_000);
  try {
    const result = await child.completion;
    if (result.code !== 0) {
      const specific = result.output.split(/\r?\n/).find(line => /ENOMEM|EPERM|EACCES|Cannot find|Error:/.test(line));
      throw new Error(`${label} failed${specific ? `: ${safeError(specific)}` : ''}`);
    }
  } finally { clearTimeout(timeout); }
}
async function onServer(sql) {
  const client = new pg.Client({ connectionString: serverUrl, application_name: 'snapshot-console-native',
    connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}
async function freePort() {
  return new Promise((done, fail) => {
    const server = createServer(); server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(String(port))); });
  });
}
async function waitReady(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (cancelled) throw new Error('Run cancelled.');
    if (child.exitCode !== null || child.signalCode) throw new Error(`${phase} process exited before readiness.`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* Poll only our process. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
  }
  throw new Error(`${phase} did not become ready.`);
}

try {
  phase = 'create disposable database'; say(phase);
  await onServer(`CREATE DATABASE ${databaseName}`); created = true;
  const env = { DATABASE_URL: databaseUrl.toString(), DEPLOY_ENV: 'local', NODE_ENV: 'development',
    COOKIE_SECURE: 'false', PLAYWRIGHT_NO_COPY_PROMPT: '1', SNAPSHOT_VERIFICATION_RUN: runId };
  await command('migrate', [drizzleCli, 'migrate'], { cwd: resolve(repoRoot, 'packages/db'), env });
  await command('seed', [tsxCli, 'src/seed/index.ts'], { cwd: resolve(repoRoot, 'packages/db'), env });
  const apiPort = await freePort(); const consolePort = await freePort();
  phase = 'start own API'; say(phase);
  const api = native([tsxCli, 'src/index.ts'], { cwd: resolve(repoRoot, 'apps/api'),
    env: { ...env, API_PORT: apiPort, PORT: apiPort, PROCESS_ROLES: 'api,edge', LOG_LEVEL: 'warn' } });
  await waitReady(`http://127.0.0.1:${apiPort}/health`, api);
  phase = 'start own Console'; say(phase);
  const console = native([viteCli, '--config', 'vite.config.ts'], { cwd: resolve(repoRoot, 'apps/console'),
    env: { ...env, API_PORT: apiPort, CONSOLE_PORT: consolePort, BASE_PATH: '/' } });
  await waitReady(`http://127.0.0.1:${consolePort}/`, console);
  await command('tests', [playwrightCli, 'test', '--config', configPath,
    '--grep', 'display snapshots|station-read grant', '--workers=1', '--retries=0', '--output', artifactDir], {
    cwd: resolve(repoRoot, 'apps/console'), env: { ...env, CONSOLE_E2E_DATABASE_URL: databaseUrl.toString(),
      CONSOLE_E2E_API_PORT: apiPort, CONSOLE_E2E_PORT: consolePort },
  });
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  record.status = results.status; record.tests = results.tests; record.errors = results.errors;
  if (record.tests.length !== 2 || record.tests.some(test => test.status !== 'passed')) throw new Error('Expected exactly two passing existing Console cases.');
  say('Two existing Console cases passed.');
} catch (error) {
  record.status = 'failed'; record.phase = phase; record.error = safeError(error);
  try { const results = JSON.parse(readFileSync(resultsPath, 'utf8')); record.tests = results.tests; record.errors = results.errors; } catch { /* A startup failure has no test report. */ }
  say(record.error); process.exitCode = 1;
} finally {
  await stopChildren(); record.cleanup.processes = true;
  if (created) {
    try { await onServer(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); record.cleanup.database = true; }
    catch (error) { record.cleanup.error = safeError(error); record.cleanup.databaseName = databaseName; process.exitCode = 1; }
  } else record.cleanup.database = true;
  writeFileSync(resolve(runnerRoot, 'native-report.json'), JSON.stringify(record, null, 2) + '\n');
  say(`Cleanup: own processes stopped; disposable database ${record.cleanup.database ? 'removed' : 'requires recovery'}.`);
}
