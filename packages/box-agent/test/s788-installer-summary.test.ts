import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * SCRUM-788: the installer's closing part, run for real.
 *
 * A release pushed to a box with Tailscale installed but not signed in ended
 * "the install did not complete", exit 1, with the new release in and both
 * services running: after "Starting" the installer asked Tailscale for the
 * box's name, `tailscale status` exits 1 while logged out, and under
 * `set -euo pipefail` that one answer stopped the script before its summary.
 *
 * The whole installer cannot run here (it wants root, apt and systemd), so
 * these checks run the part that broke, cut out of the installer's own text:
 * its settings and helpers from the top, its Tailscale helpers, and
 * everything from "Starting" to the last line of the summary, under the
 * installer's own `set -euo pipefail`. `systemctl` and `sleep` are stood in
 * for by shell functions, and `tailscale` by a script on a PATH that holds
 * nothing else but the system's own tools — the real command is never run.
 */

const installPath = fileURLToPath(new URL('../../../scripts/pi/install.sh', import.meta.url));
const pushPath = fileURLToPath(new URL('../../../scripts/agent/push-release.sh', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
// The push script is plain sh, so it is run by sh.
const sh = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
const shellPath = (path: string) => path.replaceAll('\\', '/');
const installer = readFileSync(installPath, 'utf8').replaceAll('\r\n', '\n');

/** The installer's lines from the one that starts `from` to the one that starts `to`, both kept. */
function cut(from: string, to: string | null): string {
  const lines = installer.split('\n');
  const start = lines.findIndex((line) => line.startsWith(from));
  assert.notEqual(start, -1, `the installer has no line starting: ${from}`);
  if (to === null) return lines.slice(start).join('\n');
  const end = lines.findIndex((line, index) => index >= start && line.startsWith(to));
  assert.notEqual(end, -1, `the installer has no line starting: ${to}`);
  return lines.slice(start, end + 1).join('\n');
}

/** Only the stand-ins and the system's own tools: never a command that is installed on this machine. */
const ONLY_STAND_INS = [
  'BIN="$S788_BIN"',
  'if command -v cygpath >/dev/null 2>&1; then BIN="$(cygpath -u "$BIN")"; fi',
  'PATH="$BIN:/usr/bin:/bin"',
].join('\n');

/** What `tailscale` answers on the box under test, in the states a box is found in. */
const TAILSCALE_STAND_IN = [
  '#!/usr/bin/env bash',
  '# A stand-in for the tailscale command (SCRUM-788). Never the real one.',
  'case "${S788_TAILSCALE:-}:${1:-}" in',
  '  logged-out:status) echo "Logged out."; exit 1 ;;',
  '  logged-out:ip) echo "no current Tailscale IPs; state: NeedsLogin" >&2; exit 1 ;;',
  '  stopped:*) echo "failed to connect to local tailscaled; is it running?" >&2; exit 1 ;;',
  '  joined:status|no-address:status) echo "100.64.0.7     oto-test             tagged-devices linux   -"; exit 0 ;;',
  '  joined:ip) echo 100.64.0.7; exit 0 ;;',
  '  no-address:ip) exit 1 ;;',
  'esac',
  'exit 64',
  '',
].join('\n');

type BoxState = 'absent' | 'logged-out' | 'stopped' | 'joined' | 'no-address';

/** Run the installer from "Starting" to its last line on a box in the given Tailscale state. */
function closingPart(state: BoxState, earlierNote?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oto-s788-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    if (state !== 'absent') {
      writeFileSync(join(bin, 'tailscale'), TAILSCALE_STAND_IN);
      chmodSync(join(bin, 'tailscale'), 0o755);
    }
    const config = join(dir, 'config');
    writeFileSync(config, 'OTO_BOX_API=https://api.example.test\nOTO_KIOSK_URL=\n');
    const script = [
      ONLY_STAND_INS,
      cut('set -euo pipefail', 'die() {'),
      'systemctl() { :; }',
      'sleep() { :; }',
      cut('ts_name() {', 'TS_NOTE="not configured"'),
      // What the steps in between left behind on an ordinary update.
      earlierNote === undefined ? '' : 'TS_NOTE="$S788_EARLIER_NOTE"',
      'RELEASE="0.1.0-test"; DHCP_OK=0; KIOSK_URL_NOW=""',
      'SSH_NOTE="ssh note"; PRINTER_NOTE="printer note"; SCANNER_NOTE="scanner note"; MIRROR_NOTE="mirror note"',
      // The box's config file, by a name the shell reads as one word wherever the test's folder is.
      cut('say "Starting"', null).replaceAll('/etc/oto-box/config', '"$S788_CONFIG"'),
    ].join('\n');
    const file = join(dir, 'closing-part.sh');
    writeFileSync(file, script);
    return spawnSync(bash, [shellPath(file)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        S788_BIN: shellPath(bin),
        S788_CONFIG: shellPath(config),
        S788_TAILSCALE: state,
        S788_EARLIER_NOTE: earlierNote ?? '',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tailscaleLine = (stdout: string) => /^Tailscale: (.*)$/m.exec(stdout)?.[1];
const LAST_LINE =
  'The credential is /var/lib/oto-box/credential.json (owner-only). Never copy it to another machine.';

function reachesTheSummary(run: ReturnType<typeof closingPart>) {
  assert.equal(
    run.status,
    0,
    `the installer stopped with exit ${run.status}\n${run.stderr}\n${run.stdout}`,
  );
  assert.match(
    run.stdout,
    /^Installed: oto-box 0\.1\.0-test, talking to https:\/\/api\.example\.test$/m,
  );
  assert.equal(run.stdout.trimEnd().split('\n').at(-1), LAST_LINE);
}

test('SCRUM-788: Tailscale installed but not signed in — the installer reaches its summary, exit 0', () => {
  const run = closingPart('logged-out');
  reachesTheSummary(run);
  assert.match(tailscaleLine(run.stdout) ?? '', /^installed, not signed in\b/);
});

test('SCRUM-788: Tailscale installed, its service not answering — the same', () => {
  const run = closingPart('stopped');
  reachesTheSummary(run);
  assert.match(tailscaleLine(run.stdout) ?? '', /^installed, not signed in\b/);
});

test('SCRUM-788: a box on the network is still reported by name and address', () => {
  const run = closingPart('joined');
  reachesTheSummary(run);
  assert.match(
    tailscaleLine(run.stdout) ?? '',
    /^joined as oto-test \(100\.64\.0\.7\)\. The next release, from the laptop: scripts\/agent\/push-release\.sh oto-test /,
  );
});

test('SCRUM-788: a box on the network whose address cannot be read still gets its summary', () => {
  const run = closingPart('no-address');
  reachesTheSummary(run);
  assert.match(tailscaleLine(run.stdout) ?? '', /^joined as oto-test \(\)\. /);
});

test('SCRUM-788: a box with no Tailscale at all reads as it always has', (t) => {
  if (['/usr/bin/tailscale', '/bin/tailscale'].some((path) => existsSync(path))) {
    t.skip(
      'this machine has tailscale among its system tools; the check never runs the real command',
    );
    return;
  }
  const run = closingPart('absent');
  reachesTheSummary(run);
  assert.equal(tailscaleLine(run.stdout), 'not configured');
});

test('SCRUM-788: what a failed join said earlier in the run is not replaced', () => {
  const note =
    'NOT joined — tailscale up did not complete (the warning above). Run the installer again with --tailscale-authkey';
  const run = closingPart('logged-out', note);
  reachesTheSummary(run);
  assert.equal(tailscaleLine(run.stdout), note);
});

// The same fault one step earlier, found by reading the installer for it: the
// SSH note looks the desktop user's home up with getent, which exits 2 for a
// name it does not know (--no-kiosk skips the check on --kiosk-user). By then
// the release is in place and nothing has been restarted onto it.
test('SCRUM-788: a desktop user the box does not know cannot stop the installer at the SSH note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-s788-ssh-'));
  try {
    const script = [
      ONLY_STAND_INS,
      cut('set -euo pipefail', 'die() {'),
      'getent() { return 2; }',
      'KIOSK_USER=nobody-here',
      cut('SSH_HOME="$(getent', 'fi'),
      'echo "SSH: $SSH_NOTE"',
    ].join('\n');
    const file = join(dir, 'ssh-note.sh');
    writeFileSync(file, script);
    const run = spawnSync(bash, [shellPath(file)], {
      encoding: 'utf8',
      env: { ...process.env, S788_BIN: shellPath(dir) },
    });
    assert.equal(
      run.status,
      0,
      `the installer stopped with exit ${run.status}\n${run.stderr}\n${run.stdout}`,
    );
    assert.match(run.stdout, /^SSH: \S/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The push from the laptop: the build line --------------------------------------
// `oto-box status | head -1` closed the pipe after one line while the box's
// command was still writing the rest, and Node on the box printed an EPIPE
// stack into the push's output. The line is now taken by a reader that reads
// every line. Proved with the script's own dry run (no ssh, no box): the
// command it would send is run here against a stand-in `oto-box` that writes
// its lines a moment apart, and leaves a mark only if every write landed.

test('SCRUM-788: the push reads the build line without closing the pipe on the box', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-s788-push-'));
  try {
    const name = 'oto-box-0.1.0-20261111-abc1234.tgz';
    const release = join(dir, name);
    writeFileSync(release, 'not a real release');
    const hash = createHash('sha256').update('not a real release').digest('hex');
    writeFileSync(`${release}.sha256`, `${hash}  ${name}\n`);
    // A key file of the test's own, so neither this machine's key nor its .env
    // is read; and no ssh: --dry-run prints its commands and runs none of them.
    const key = join(dir, 'key');
    writeFileSync(key, 'not a real key');
    const env: NodeJS.ProcessEnv = { ...process.env, PUSH_RELEASE_KEY: shellPath(key) };
    const dry = spawnSync(
      sh,
      [
        shellPath(pushPath),
        'box.example.test',
        shellPath(release),
        '--dry-run',
        '--',
        '--no-kiosk',
      ],
      {
        encoding: 'utf8',
        env,
      },
    );
    assert.equal(dry.status, 0, dry.stderr);
    assert.doesNotMatch(dry.stdout, /oto-box status \| head/);
    assert.equal(
      dry.stdout.match(/oto-box status \| sed -n 1p/g)?.length,
      3,
      'before, at the end of the install, and after',
    );

    // The "Before" command, exactly as the dry run prints it.
    const before = /^ssh .* oto@box\.example\.test "(.*)"$/m.exec(dry.stdout)?.[1];
    assert.ok(before, dry.stdout);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const mark = join(dir, 'every-line-written');
    const writer = join(dir, 'status.mjs');
    writeFileSync(
      writer,
      [
        "import { writeFileSync } from 'node:fs';",
        "process.stdout.write('build       oto-box 0.1.0 build 2026-11-11 abc1234\\n');",
        'setTimeout(() => {',
        "  process.stdout.write('home        /var/lib/oto-box\\n', (error) => {",
        "    if (!error) writeFileSync(process.argv[2], 'ok');",
        '  });',
        '}, 400);',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(bin, 'oto-box'),
      `#!/usr/bin/env bash\nexec "${shellPath(process.execPath)}" "${shellPath(writer)}" "${shellPath(mark)}"\n`,
    );
    chmodSync(join(bin, 'oto-box'), 0o755);
    const run = spawnSync(bash, ['-c', `${ONLY_STAND_INS}\neval "$S788_COMMAND"`], {
      encoding: 'utf8',
      env: { ...env, S788_BIN: shellPath(bin), S788_COMMAND: before },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'build       oto-box 0.1.0 build 2026-11-11 abc1234\n');
    assert.equal(run.stderr, '', 'no stack trace beside the build line');
    assert.equal(existsSync(mark), true, 'the box wrote every line: nobody closed the pipe on it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
