import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const [root, ...specs] = process.argv.slice(2);
if (!root || !specs.length) throw new Error('Worktree and whole spec file required');
delete process.env.TEST_DATABASE_URL;
const req = createRequire(resolve(root, 'packages/db/package.json'));
req('tsx/esm/api').register();
const { createTestDatabase, stopTestServer } = await import(pathToFileURL(resolve(root, 'packages/db/src/testing.ts')));
let db, failed = false;
try {
  db = await createTestDatabase();
  const server = new URL(db.url); server.pathname = '/postgres';
  const code = await new Promise((ok, fail) => {
    const child = spawn('pnpm', ['--filter', '@oto/console', 'e2e', ...specs], {
      cwd: root, shell: process.platform === 'win32', stdio: 'inherit',
      env: { ...process.env, CONSOLE_E2E_SERVER_URL: server.toString(), CONSOLE_E2E_BUILT: '1', CONSOLE_E2E_BROWSER: 'msedge' },
    });
    child.on('error', fail); child.on('exit', ok);
  });
  if (code !== 0) failed = true;
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ failed: true, kind: error.name }));
} finally {
  try { await db?.drop(); } finally { await stopTestServer(); }
  console.log('Disposable embedded server stopped.');
}
if (failed) process.exitCode = 1;
