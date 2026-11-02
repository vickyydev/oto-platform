import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('../../../scripts/pi/bridge-install.sh', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = (path: string) => path.replaceAll('\\', '/');
function run(script: string, args: string[] = []) {
  return spawnSync(bash, ['-c', 'set -eo pipefail; source "$BRIDGE_TEST_HELPER"; ' + script.replaceAll('$2', '$BRIDGE_TEST_ARG')], {
    encoding: 'utf8', env: { ...process.env, BRIDGE_TEST_HELPER: shellPath(helper), BRIDGE_TEST_ARG: args[0] ?? '' },
  });
}

test('HIGH: an injected hostname or env line is refused without executing or printing it', () => {
  for (const host of ['box.example.com', 'till-2.park.example.com']) assert.equal(run('bridge_host_valid "$2"', [host]).status, 0);
  for (const host of ['127.0.0.1', 'https://box.example.com', '*.example.com', '-box.example.com', 'box..example.com', 'box.example.com/path', 'box.example.com\nEnvironment=BAD', 'box.example.com;id']) {
    assert.notEqual(run('bridge_host_valid "$2"', [host]).status, 0, host);
  }
  const dir = mkdtempSync(join(tmpdir(), 'oto-bridge-env-'));
  try {
    const env = join(dir, 'env'), marker = join(dir, 'executed');
    const good = 'OTO_DNS_PROVIDER=cloudflare\nOTO_DNS_MODULE=github.com/caddy-dns/cloudflare\nOTO_DNS_API_TOKEN=synthetic-secret-713\nOTO_ACME_EMAIL=ops@example.com\n';
    writeFileSync(env, good);
    const valid = run('bridge_read_env "$2"; test "$OTO_DNS_PROVIDER" = cloudflare', [env]);
    assert.equal(valid.status, 0, valid.stderr); assert.equal(valid.stdout, '');
    for (const bad of [good + 'OTO_DNS_PROVIDER=other\n', good.replace('synthetic-secret-713', ''), good + `BAD=$(touch ${shellPath(marker)})\n`, good.replace('synthetic-secret-713', `$(touch ${shellPath(marker)})`)]) {
      writeFileSync(env, bad);
      const refused = run('bridge_read_env "$2"', [env]);
      assert.notEqual(refused.status, 0); assert.equal(refused.stdout, ''); assert.equal(refused.stderr, '');
      assert.equal(existsSync(marker), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HIGH: opting in preserves other settings and existing origins, and is repeatable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-bridge-config-'));
  try {
    const file = join(dir, 'config');
    const before = '# retained\nOTO_KIOSK_URL=https://screen.example.com/display\nOTO_BOX_BRIDGE_ORIGINS=https://existing.example.com\nOTO_BOX_MIRROR_DIR=/mnt/oto-mirror/box\n';
    writeFileSync(file, before);
    assert.equal(run('bridge_append_origins "$2"', [file]).status, 0);
    const after = readFileSync(file, 'utf8');
    assert.equal(after, before.replace('https://existing.example.com', 'https://existing.example.com,https://oto-pos-staging.onrender.com,https://oto-pos-web-staging.onrender.com'));
    assert.equal(run('bridge_append_origins "$2"', [file]).status, 0); assert.equal(readFileSync(file, 'utf8'), after);
    writeFileSync(file, before + 'OTO_BOX_BRIDGE_ORIGINS=https://duplicate.example.com\n');
    const duplicate = readFileSync(file, 'utf8');
    assert.notEqual(run('bridge_append_origins "$2"', [file]).status, 0); assert.equal(readFileSync(file, 'utf8'), duplicate);
    writeFileSync(file, 'OTO_KIOSK_URL=\n');
    assert.equal(run('bridge_append_origins "$2"', [file]).status, 0);
    assert.match(readFileSync(file, 'utf8'), /^OTO_KIOSK_URL=\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the dark installer keeps its guard and Caddy publishes only the station bridge', () => {
  const install = readFileSync(new URL('../../../scripts/pi/install.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.match(install, /if \[ -n "\$BRIDGE_HOST" \]; then\n {2}\. "\$SOURCE\/pi\/bridge-install.sh"\n {2}bridge_preflight\nfi/);
  assert.match(install, /\[ -z "\$BRIDGE_HOST" \] \|\| bridge_install/);
  const caddy = readFileSync(new URL('../../../scripts/pi/Caddyfile', import.meta.url), 'utf8');
  assert.match(caddy, /@bridge path \/box\/v1\/station\/\*/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8471/);
  assert.match(caddy, /flush_interval -1/); assert.doesNotMatch(caddy.replace(/^\s*#.*$/gm, ''), /header_up|encode|8780|lb_retries/);
  assert.match(caddy, /dns \{\$OTO_DNS_PROVIDER\} \{env\.OTO_DNS_API_TOKEN\}/);
});
