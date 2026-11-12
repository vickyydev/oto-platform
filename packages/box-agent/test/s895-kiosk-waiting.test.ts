import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { main, screenLines, type CliStreams } from '../src/runner/cli';
import { KIOSK_WAITING_PATH, createKioskServer, kioskWaitingPage } from '../src/runner/kiosk-server';

/**
 * SCRUM-895: the counter's screen opens the display by itself once the
 * connection is back, however late; and point 6 of SCRUM-962: which page the
 * screen opens can be read without guessing.
 *
 * The television's launcher (scripts/pi/oto-kiosk.sh) runs here for real,
 * under bash, with stand-ins for the only three things it reaches outside
 * itself: `curl` (an address that answers after a while, or with an error),
 * the browser (which writes down each address it is opened on and, on the
 * waiting page, stays open until it is stopped) and `sleep` (a hundredth of a
 * second, so a minute of waiting takes a moment). /etc/oto-box/config is a
 * file of the test's own. Nothing here opens a browser or the network.
 */

const kioskPath = fileURLToPath(new URL('../../../scripts/pi/oto-kiosk.sh', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = (path: string) => path.replaceAll('\\', '/');
const launcher = readFileSync(kioskPath, 'utf8').replaceAll('\r\n', '\n');

const STAGING_DISPLAY = 'https://oto-pos-web-staging.onrender.com/display?keyboard=screen';

const CURL = `#!/usr/bin/env bash
# A stand-in for curl (SCRUM-895). The box always answers; the display's web
# address answers S895_UP_CODE once it has been asked more than S895_DOWN
# times, and S895_DOWN_CODE (000: no answer at all) before that.
url="\${!#}"
case "$url" in
  http://127.0.0.1:*) printf 200; exit 0 ;;
esac
echo "$url" >>"$S895/curl.log"
n=$(( $(cat "$S895/curl-count" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$S895/curl-count"
if [ "$n" -gt "\${S895_DOWN:-0}" ]; then code="\${S895_UP_CODE:-200}"; else code="\${S895_DOWN_CODE:-000}"; fi
printf '%s' "$code"
[ "$code" = 000 ] && exit 7
exit 0
`;

const BROWSER = `#!/usr/bin/env bash
# A stand-in for Chromium (SCRUM-895): writes down where it was opened and with what.
url="\${!#}"
echo "$url" >>"$S895/browser.log"
printf '%s\\n' "$@" >"$S895/browser-args"
case "$url" in
  *kiosk/waiting*)
    if [ -n "\${S895_WAITING_EXIT:-}" ]; then /usr/bin/sleep 0.2; exit "$S895_WAITING_EXIT"; fi
    trap 'echo stopped >>"$S895/browser.log"; exit 0' TERM
    while :; do /usr/bin/sleep 0.05; done
    ;;
esac
exit 0
`;

type Run = SpawnSyncReturns<string>;

interface Launch {
  config: string;
  env?: Record<string, string>;
}

/** Run the launcher once, as systemd would, and say what it did. */
function launch({ config, env = {} }: Launch) {
  const dir = mkdtempSync(join(tmpdir(), 'oto-s895-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(join(dir, 'run'));
    // The desktop's Wayland socket, which the launcher waits for.
    writeFileSync(join(dir, 'run', 'wayland-0'), '');
    for (const [name, text] of [
      ['curl', CURL],
      ['chromium-browser', BROWSER],
      ['sleep', '#!/bin/sh\nexec /usr/bin/sleep 0.01\n'],
    ] as const) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(dir, 'config'), config);
    const script = join(dir, 'kiosk.sh');
    writeFileSync(
      script,
      [
        'BIN="$S895_BIN"',
        'if command -v cygpath >/dev/null 2>&1; then BIN="$(cygpath -u "$BIN")"; fi',
        'PATH="$BIN:/usr/bin:/bin"',
        launcher.replaceAll('/etc/oto-box/config', '"$S895_CONFIG"'),
      ].join('\n'),
    );
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.DISPLAY;
    const run: Run = spawnSync(bash, [shellPath(script)], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...base,
        S895: shellPath(dir),
        S895_BIN: shellPath(bin),
        S895_CONFIG: shellPath(join(dir, 'config')),
        HOME: shellPath(dir),
        XDG_RUNTIME_DIR: shellPath(join(dir, 'run')),
        ...env,
      },
    });
    const lines = (name: string) =>
      existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean) : [];
    return { run, browser: lines('browser.log'), curl: lines('curl.log'), args: lines('browser-args') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WEB_CONFIG = `OTO_BOX_PORT=8780\nOTO_KIOSK_ROTATE=off\nOTO_KIOSK_URL=${STAGING_DISPLAY}\nOTO_KIOSK_SCALE=1\n`;
const WAITING = 'http://127.0.0.1:8780/kiosk/waiting?for=oto-pos-web-staging.onrender.com';

function finished(run: Run, status = 0) {
  assert.equal(run.error, undefined, `the launcher did not finish: ${String(run.error)}\n${run.stderr}`);
  assert.equal(run.status, status, `exit ${run.status}\n${run.stderr}\n${run.stdout}`);
}

test('SCRUM-895: a web address that answers at boot is opened straight away, as before', () => {
  const { run, browser, curl, args } = launch({ config: WEB_CONFIG });
  finished(run);
  assert.deepEqual(browser, [STAGING_DISPLAY], 'no waiting page when there is nothing to wait for');
  assert.deepEqual(curl, [STAGING_DISPLAY]);
  assert.ok(args.includes('--kiosk') && args.includes('--ozone-platform=wayland'), args.join(' '));
  assert.ok(!args.some((arg) => arg.startsWith('--disable-auto-reload') || arg === '--enable-automation'),
    "Chromium's own reload of a page that failed to load stays on");
});

test('SCRUM-895: with no Wi-Fi at power-on the screen shows the box\'s waiting page, then opens the display by itself', () => {
  // Fifteen tries at start, then three more while the waiting page is up.
  const { run, browser, curl } = launch({ config: WEB_CONFIG, env: { S895_DOWN: '17' } });
  finished(run);
  assert.deepEqual(browser, [WAITING, 'stopped', STAGING_DISPLAY]);
  assert.equal(curl.length, 18, 'asked until it answered, and not once after');
  assert.match(run.stderr, /the display address does not answer yet: the screen shows the box's waiting page until it does/);
  assert.match(run.stderr, /the display address answers: opening it/);
});

test('SCRUM-895: however late the connection comes back, the waiting page gives way to the display', () => {
  const { run, browser, curl } = launch({ config: WEB_CONFIG, env: { S895_DOWN: '50' } });
  finished(run);
  assert.deepEqual(browser, [WAITING, 'stopped', STAGING_DISPLAY]);
  assert.equal(curl.length, 51);
});

test('SCRUM-895: a server error is not an answer (a deploy); a wrong address is opened for a person to see', () => {
  const deploying = launch({ config: WEB_CONFIG, env: { S895_DOWN: '16', S895_DOWN_CODE: '502' } });
  finished(deploying.run);
  assert.deepEqual(deploying.browser, [WAITING, 'stopped', STAGING_DISPLAY]);
  const wrong = launch({ config: WEB_CONFIG, env: { S895_UP_CODE: '404' } });
  finished(wrong.run);
  assert.deepEqual(wrong.browser, [STAGING_DISPLAY]);
});

test('SCRUM-895: a waiting browser that closes by itself ends the launcher, and systemd starts it again', () => {
  const { run, browser } = launch({ config: WEB_CONFIG, env: { S895_DOWN: '100000', S895_WAITING_EXIT: '4' } });
  finished(run, 4);
  assert.deepEqual(browser, [WAITING]);
});

test('SCRUM-895: a page turn asked of the web address travels to it, not to the waiting page', () => {
  const { run, browser } = launch({
    config: WEB_CONFIG.replace('OTO_KIOSK_ROTATE=off', 'OTO_KIOSK_ROTATE=ccw'),
    env: { S895_DOWN: '15' },
  });
  finished(run);
  assert.deepEqual(browser, [WAITING, 'stopped', `${STAGING_DISPLAY}#ccw`]);
});

test("SCRUM-895: the box's own booth page needs no network and opens as it always has", () => {
  const { run, browser, curl } = launch({ config: 'OTO_BOX_PORT=8780\nOTO_KIOSK_ROTATE=cw\nOTO_KIOSK_URL=\n', env: { S895_DOWN: '100000' } });
  finished(run);
  assert.deepEqual(browser, ['http://127.0.0.1:8780/#cw']);
  assert.deepEqual(curl, [], 'never asks the web');
});

test("SCRUM-895: the box's own copy of the display opens straight away, with no waiting page", () => {
  const local = 'http://127.0.0.1:8780/display?keyboard=screen';
  const { run, browser, curl } = launch({
    config: `OTO_BOX_PORT=8780\nOTO_KIOSK_ROTATE=off\nOTO_KIOSK_URL=${local}\nOTO_KIOSK_SCALE=1.25\n`,
    env: { S895_DOWN: '100000' },
  });
  finished(run);
  assert.deepEqual(browser, [local]);
  assert.deepEqual(curl, []);
});

// --- The waiting page the box serves ------------------------------------------------

test('SCRUM-895: the box serves its waiting page whatever state it is in, and writes no markup it was handed', async () => {
  const kiosk = createKioskServer({
    port: 0,
    pageDir: null,
    booth: () => null,
    state: async () => ({ registered: false, online: false, booths: [], selectedStationId: null, agentVersion: 'test' }),
    claim: async () => ({ ok: false, reason: 'invalid' }),
    selectBooth: async () => false,
    condition: () => ({ state: 'starting' }),
  });
  const { port } = await kiosk.listen();
  const origin = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${origin}${KIOSK_WAITING_PATH}?for=oto-pos-web-staging.onrender.com`);
    assert.equal(page.status, 200, 'served while the box is still starting');
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
    const html = await page.text();
    assert.match(html, /<h1>Waiting for the connection<\/h1>/);
    assert.match(html, /This display opens by itself as soon as the connection is back\. Nothing needs pressing\./);
    assert.match(html, /Waiting for oto-pos-web-staging\.onrender\.com/);
    assert.doesNotMatch(html, /<script/i, 'nothing on it runs');

    const hostile = await (await fetch(`${origin}${KIOSK_WAITING_PATH}?for=${encodeURIComponent('"><script>alert(1)</script>')}`)).text();
    assert.doesNotMatch(hostile, /alert|<script/i);
    assert.doesNotMatch(hostile, /data-waiting-for/);
    assert.equal(kioskWaitingPage(null), kioskWaitingPage('not a host'));

    assert.equal(
      (await fetch(`${origin}${KIOSK_WAITING_PATH}`, { method: 'POST', headers: { origin } })).status,
      405,
    );
  } finally {
    await kiosk.close();
  }
});

// --- Which page the screen opens (SCRUM-962 point 6) -----------------------------------

test('SCRUM-962: status says which page the screen opens, and whether a change needs a web deploy or a box release', () => {
  const base = { port: 8780, boothDir: '/opt/oto-box/releases/0.1.0-20261113-abc/booth', displayDir: '/opt/oto-box/releases/0.1.0-20261113-abc/display' };
  assert.deepEqual(screenLines({ ...base, url: STAGING_DISPLAY, screen: 'on' }), [
    `screen      ${STAGING_DISPLAY}: a web address: a display change reaches it with a web deploy, no box release`,
  ]);
  assert.deepEqual(screenLines({ ...base, url: 'http://127.0.0.1:8780/display?keyboard=screen', screen: 'on' }), [
    "screen      http://127.0.0.1:8780/display?keyboard=screen: the box's own copy of the display page, served from /opt/oto-box/releases/0.1.0-20261113-abc/display, this release's page folder: a display change needs a new box release",
  ]);
  assert.deepEqual(screenLines({ ...base, url: '' }), [
    "screen      the box's own booth page, http://127.0.0.1:8780/, served from /opt/oto-box/releases/0.1.0-20261113-abc/booth, this release's page folder: a change to it needs a new box release",
  ]);
  assert.deepEqual(screenLines({ ...base, url: STAGING_DISPLAY, screen: 'off' }), [
    'screen      none: installed with --no-kiosk, this box draws nothing on a screen',
  ]);
  assert.deepEqual(screenLines({ ...base, url: '', displayDir: null, boothDir: null }), [
    "screen      the box's own booth page, http://127.0.0.1:8780/, the booth page is not in this release: a change to it needs a new box release",
  ]);
  // Another box's port is a web address as far as this box goes.
  assert.match(screenLines({ ...base, url: 'http://127.0.0.1:9999/display' })[0]!, /a web address/);
  assert.deepEqual(
    screenLines({ ...base, url: STAGING_DISPLAY, rotate: '90', output: 'HDMI-A-1', camera: 'allow' }).slice(1),
    [
      'display     turned 90 by the desktop on HDMI-A-1, the touch mapped to the same output',
      'camera      allowed without a tap for https://oto-pos-web-staging.onrender.com only',
    ],
  );
  assert.equal(screenLines({ ...base, url: STAGING_DISPLAY, rotate: 'off', camera: 'off' }).length, 1);
});

test('SCRUM-962: `oto-box status` prints the screen line from the configuration it is handed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oto-s962-'));
  const keys = ['OTO_KIOSK_SCREEN', 'OTO_KIOSK_URL', 'OTO_DISPLAY_ROTATE', 'OTO_DISPLAY_OUTPUT', 'OTO_DISPLAY_CAMERA', 'OTO_BOX_PORT'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      OTO_KIOSK_SCREEN: 'on',
      OTO_KIOSK_URL: STAGING_DISPLAY,
      OTO_DISPLAY_ROTATE: '90',
      OTO_DISPLAY_OUTPUT: 'HDMI-A-1',
      OTO_DISPLAY_CAMERA: 'off',
      OTO_BOX_PORT: '8780',
    });
    let out = '';
    const stdin = new PassThrough();
    stdin.end();
    const io: CliStreams = { stdin, stdout: { write: (chunk: string) => ((out += chunk), true) }, stderr: { write: () => true } };
    assert.equal(await main(['status', '--home', home], io), 0);
    assert.match(out, /^build {7}oto-box /, 'the build is still the first line');
    assert.match(out, new RegExp(`^screen {6}${STAGING_DISPLAY.replaceAll('?', '\\?').replaceAll('.', '\\.')}: a web address: a display change reaches it with a web deploy, no box release$`, 'm'));
    assert.match(out, /^display {5}turned 90 by the desktop on HDMI-A-1, the touch mapped to the same output$/m);
    assert.doesNotMatch(out, /^camera /m);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
});
