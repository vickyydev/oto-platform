/**
 * The Console's end-to-end harness: a database of its own, a stack on top of
 * it, the specs, and then nothing left behind.
 *
 *   pnpm --filter @oto/console e2e            # the whole set
 *   pnpm --filter @oto/console e2e -- --headed
 *   pnpm --filter @oto/console e2e -- e2e/console-smoke.spec.ts
 *
 * WHY A DATABASE PER RUN. The api tests do the same thing
 * (`packages/db/src/testing.ts`) and for the same reason: every case here
 * reads seeded rows — both parks on Branches, Booth 1's spins today, the
 * printers on Reception Till 1 — and one queues a command at the virtual box.
 * Run against the dev database those are readings of whatever somebody last
 * did at the till, and the run would leave its own test print behind. A fresh
 * database makes each of them a claim that can be true or false.
 *
 * The Postgres SERVER is the one already on the machine (Docker, :5433) or
 * whatever `TEST_DATABASE_URL` names, the same variable CI hands the api
 * tests; only the database on it is new.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
// Imported rather than taken from the globals: this file is linted by the
// repository's flat config, which declares Node's globals for `scripts/**`
// and nowhere else.
import process from 'node:process';
import { URL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

/**
 * The Postgres driver, borrowed from the package that owns migrations rather
 * than added to the Console's own dependencies. `apps/console` is a browser
 * app: a `pg` in its manifest would be a standing invitation to import it from
 * something that ships.
 */
const pg = createRequire(resolve(repoRoot, 'packages/db/package.json'))('pg');

/** The server to make the run's database on — never the database itself. */
const serverUrl =
  process.env.CONSOLE_E2E_SERVER_URL ||
  process.env.TEST_DATABASE_URL ||
  'postgres://oto:oto@localhost:5433/postgres';

/** Time-stamped, so a crashed run's leftovers are obvious and never collide. */
const databaseName = `oto_console_e2e_${Date.now()}`;

/**
 * The same server, with this run's database in place of whichever one the
 * string above names.
 *
 * Through `URL` rather than by replacing the tail of the string: a connection
 * string may carry a query — `?sslmode=require` is the usual one on a hosted
 * Postgres, and CI could hand this one over any day — and a replace on the
 * last `/…` segment would swallow it into the database name.
 */
const databaseUrl = (() => {
  const url = new URL(serverUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();

const say = (...parts) => process.stdout.write(`[console-e2e] ${parts.join(' ')}\n`);

async function onServer(sql) {
  const client = new pg.Client({ connectionString: serverUrl, application_name: 'console-e2e' });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * A port nothing is listening on right now.
 *
 * There is a window between this closing the probe and a server binding, which
 * is why both servers are started with `strictPort`/a fixed port and fail
 * loudly rather than sliding to the next one. Other slices run their own api
 * and dev servers on this machine, so the fixed defaults (3001, 25743) are
 * exactly the ones not to take.
 */
function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

function run(command, args, env = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      // pnpm is a .cmd on Windows, which `spawn` will not execute directly.
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    });
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

let playwright = null;
// Ctrl-C must still reach the teardown below, or the run leaves a database
// and two servers behind.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => playwright?.kill());
}

let created = false;
try {
  say(`making ${databaseName} on ${serverUrl.replace(/:[^:@/]*@/, ':***@')}`);
  await onServer(`CREATE DATABASE ${databaseName}`);
  created = true;

  say('applying migrations');
  await run('pnpm', ['db:migrate'], { DATABASE_URL: databaseUrl });
  say('seeding');
  await run('pnpm', ['db:seed'], { DATABASE_URL: databaseUrl });

  const apiPort = String(await freePort());
  const consolePort = String(await freePort());
  say(`api on ${apiPort}, console on ${consolePort}`);

  // `pnpm … e2e -- --headed` hands the separator through as an argument of its
  // own; Playwright's CLI reads it as the end of its options and then ignores
  // the spec path behind it, so the run silently widens to everything.
  const forwarded = process.argv.slice(2).filter((arg) => arg !== '--');

  const code = await new Promise((ok, fail) => {
    playwright = spawn('pnpm', ['exec', 'playwright', 'test', ...forwarded], {
      cwd: resolve(repoRoot, 'apps', 'console'),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        CONSOLE_E2E_DATABASE_URL: databaseUrl,
        CONSOLE_E2E_API_PORT: apiPort,
        CONSOLE_E2E_PORT: consolePort,
      },
    });
    playwright.on('error', fail);
    playwright.on('exit', (status) => ok(status ?? 1));
  });
  process.exitCode = code;
} catch (err) {
  say(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
} finally {
  if (created) {
    // FORCE, because Playwright has just killed the api and its pool's
    // connections may not have been reaped yet.
    await onServer(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
      .then(() => say(`dropped ${databaseName}`))
      .catch((err) => say(`could not drop ${databaseName}: ${err.message}`));
  }
}
