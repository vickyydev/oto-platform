import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createTestContext, teardownAll, ADMIN } from './codex-till-codes-20261104/apps/api/test/helpers.ts';

const root = 'C:/oto-lanes/codex-till-codes-20261104';
const require = createRequire(root + '/apps/pos/package.json');
const free = () => new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(() => resolve(address.port)); }); });
const apiPort = await free(), posPort = await free(), origin = `http://127.0.0.1:${posPort}`;
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const out = root + '/docs/qa/proof-2026-11-04/s747-746/local'; mkdirSync(out, { recursive: true });
const ctx = await createTestContext({ env: { DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge,jobs', PGW_PROVIDER: 'simulator', ALLOWED_ORIGINS: origin, COOKIE_SECURE: 'false' } });
let vite: { close: () => Promise<void> } | undefined, code = 1;
try {
  await ctx.app.listen({ port: apiPort, host: '127.0.0.1' });
  process.env.API_PORT = String(apiPort); process.env.POS_PORT = String(posPort);
  const { createServer: createVite } = await import(pathToFileURL(require.resolve('vite')).href);
  const server = await createVite({ configFile: root + '/apps/pos/vite.config.ts', root: root + '/apps/pos', server: { port: posPort, host: '127.0.0.1', strictPort: true } });
  vite = server; await server.listen();
  const base = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, ['C:/oto-lanes/s747-native-browser.mjs', root, source], { cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...base, S747_LOCAL_ORIGIN: origin, S747_LOCAL_PHONE: ADMIN.phone, S747_LOCAL_PASSWORD: ADMIN.password } });
  code = await new Promise<number>(resolve => child.once('exit', value => resolve(value ?? 1)));
  assert.equal(ctx.smsLog.length, 0);
} catch (error) {
  console.error(JSON.stringify({ localProofFailed: true, name: (error as Error).name, message: (error as Error).message.split('\n')[0].replace(/postgres[^\s]*/gi, '[database omitted]') })); code = 1;
} finally {
  await vite?.close(); await ctx.close(); await teardownAll();
  writeFileSync(out + '/latest-database-cleanup.json', JSON.stringify({ source, at: new Date().toISOString(), dropped: true, smsCount: ctx.smsLog.length, exitCode: code }, null, 2) + '\n');
}
process.exit(code);
