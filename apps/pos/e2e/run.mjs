/** SCRUM-369: the till smoke owns its database, accounts and server ports. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '../../..');
const requireDb = createRequire(resolve(root, 'packages/db/package.json'));
const { register } = requireDb('tsx/esm/api');
register();
const { createTestDatabase, stopTestServer } = await import('../../../packages/db/src/testing.ts');
const { seed } = await import('../../../packages/db/src/seed/index.ts');
const { drizzle } = requireDb('drizzle-orm/node-postgres');
const { Pool } = requireDb('pg');
const { hash } = requireDb('@node-rs/argon2');
const say = message => process.stdout.write(`[pos-e2e] ${message}\n`);

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(String(port)));
    });
  });
}

let child;
function run(args, env = {}, cwd = root) {
  return new Promise((resolveRun, reject) => {
    child = spawn('pnpm', args, {
      cwd, stdio: 'inherit', shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`Child process exited with ${code}`)));
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));

let database;
let pool;
let failed = false;
try {
  // A deployment URL must never bypass the disposable fixture.
  if (process.env.SMOKE_BASE_URL) throw new Error('Unset SMOKE_BASE_URL for the isolated till smoke');
  if (process.env.POS_E2E_BUILT === '1') await run(['--filter', '@oto/pos', 'build']);
  say('creating and migrating a disposable database');
  database = await createTestDatabase();
  pool = new Pool({ connectionString: database.url });
  await seed(drizzle(pool));
  // Keep the seed's roles but replace these two local accounts' passwords.
  // No fixed password or external sign-in is carried into the browser run.
  const password = randomBytes(24).toString('hex');
  const accounts = await pool.query(`
    update core.account a set password_hash = $1 from core.employee e
    where a.employee_id = e.id and e.name in ('Som (Reception)', 'Khun Anan (Owner)')
    returning e.name, a.phone`, [await hash(password)]);
  const staff = accounts.rows.find(row => row.name === 'Som (Reception)');
  const admin = accounts.rows.find(row => row.name === 'Khun Anan (Owner)');
  if (accounts.rowCount !== 2 || !staff || !admin) throw new Error('The two seeded smoke accounts are missing');
  await pool.end();
  pool = null;
  const apiPort = await freePort();
  let posPort = await freePort();
  while (posPort === apiPort) posPort = await freePort();
  const forwarded = process.argv.slice(2).filter(arg => arg !== '--');
  await run(['exec', 'playwright', 'test', ...(forwarded.length ? forwarded : ['e2e/smoke.spec.ts'])], {
    POS_E2E_DATABASE_URL: database.url,
    POS_E2E_API_PORT: apiPort, POS_E2E_PORT: posPort,
    // The staff input already supplies Thailand's country code; API setup takes E.164.
    POS_E2E_PHONE: staff.phone.replace(/^\+66/, ''), POS_E2E_PASSWORD: password,
    POS_E2E_ADMIN_PHONE: admin.phone, POS_E2E_ADMIN_PASSWORD: password,
    PLAYWRIGHT_NO_COPY_PROMPT: '1',
  }, resolve(root, 'apps/pos'));
} catch (error) {
  failed = true;
  // Setup errors may include connection strings; the stage is named above.
  say(error instanceof Error && error.message.startsWith('Child process exited')
    ? error.message : `Harness failed (${error?.name ?? 'unknown error'})`);
  process.exitCode = 1;
} finally {
  try {
    await pool?.end();
    await database?.drop();
    say('disposable database removed');
  } finally {
    await stopTestServer();
  }
}
// embedded-postgres uses async-exit-hook, whose beforeExit handler defaults to
// zero rather than preserving process.exitCode. Pass the outcome explicitly.
process.exit(failed ? 1 : 0);
