import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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
 * SCRUM-928 (and SCRUM-896, point 6 of SCRUM-962): the counter box's
 * installer sets up a customer display standing on its end, its touch, its
 * camera, and says which page the screen opens.
 *
 * Nothing here reaches a Pi. The helpers in scripts/pi/display-install.sh are
 * run for real by bash against copies of the files they read and write (the
 * kernel's connector and input lists, the desktop user's kanshi and labwc
 * files, Chromium's policy folders), in folders of the test's own; the
 * installer's own parts (its options, its config file, its summary) are cut
 * out of its text and run under its own `set -euo pipefail`, as the SCRUM-788
 * checks do. What only the real Pi can show (the picture turning, a press
 * landing where it is pressed, the camera prompt) is listed in
 * BOX_QUICKSTART.md part I.
 */

const installPath = fileURLToPath(new URL('../../../scripts/pi/install.sh', import.meta.url));
const helperPath = fileURLToPath(new URL('../../../scripts/pi/display-install.sh', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = (path: string) => path.replaceAll('\\', '/');
const installer = readFileSync(installPath, 'utf8').replaceAll('\r\n', '\n');

/** The installer's lines from the one that starts `from` to the one that starts `to`, both kept. */
function cut(from: string, to: string | null): string {
  const lines = installer.split('\n');
  const start = lines.findIndex((line) => line.startsWith(from));
  assert.notEqual(start, -1, `the installer has no line starting: ${from}`);
  if (to === null) return lines.slice(start).join('\n');
  const end = lines.findIndex((line, index) => index > start && line.startsWith(to));
  assert.notEqual(end, -1, `the installer has no line starting: ${to}`);
  return lines.slice(start, end + 1).join('\n');
}

/** Only the stand-ins and the system's own tools: never a command that is installed on this machine. */
const ONLY_STAND_INS = [
  'BIN="$S928_BIN"',
  'if command -v cygpath >/dev/null 2>&1; then BIN="$(cygpath -u "$BIN")"; fi',
  'PATH="$BIN:/usr/bin:/bin"',
].join('\n');

/** The installer's own die and warn, written so a test can read them. */
const DIE_AND_WARN = [
  `die() { printf 'DIE: %s\\n' "$*" >&2; exit 3; }`,
  `warn() { printf 'WARN: %s\\n' "$*" >&2; }`,
].join('\n');

type Run = SpawnSyncReturns<string>;

function inFolder<T>(work: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'oto-s928-'));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `script` with the helper sourced, under the installer's own shell options. */
function helper(dir: string, script: string, env: Record<string, string> = {}): Run {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = join(dir, `run-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(
    file,
    [ONLY_STAND_INS, 'set -euo pipefail', DIE_AND_WARN, '. "$S928_HELPER"', script, ''].join('\n'),
  );
  return spawnSync(bash, [shellPath(file)], {
    encoding: 'utf8',
    env: { ...process.env, S928_BIN: shellPath(bin), S928_HELPER: shellPath(helperPath), S928: shellPath(dir), ...env },
  });
}

function ok(run: Run): Run {
  assert.equal(run.status, 0, `exit ${run.status}\n${run.stderr}\n${run.stdout}`);
  return run;
}

// --- What the Pi says about itself ----------------------------------------------

/** A Pi 5's connectors: the 10-inch monitor on HDMI0, nothing on HDMI1. */
function drm(dir: string, connected: string[]): string {
  const root = join(dir, 'drm');
  for (const name of ['HDMI-A-1', 'HDMI-A-2', 'Writeback-1']) {
    mkdirSync(join(root, `card1-${name}`), { recursive: true });
    writeFileSync(join(root, `card1-${name}`, 'status'), `${connected.includes(name) ? 'connected' : 'disconnected'}\n`);
  }
  mkdirSync(join(root, 'card1'), { recursive: true });
  return shellPath(root);
}

/** /proc/bus/input/devices with a keyboard, a touch pad and the monitor's touch screen. */
const INPUTS = `I: Bus=0003 Vendor=046d Product=c31c Version=0110
N: Name="Logitech USB Keyboard"
P: Phys=usb-xhci-hcd.0-1/input0
H: Handlers=sysrq kbd leds event0
B: PROP=0
B: EV=120013

I: Bus=0003 Vendor=046d Product=4024 Version=0111
N: Name="Logitech K400 Touchpad"
H: Handlers=mouse0 event2
B: PROP=5
B: EV=b

I: Bus=0003 Vendor=222a Product=0001 Version=0110
N: Name="ILITEK ILITEK-TP"
H: Handlers=mouse1 event3
B: PROP=2
B: EV=1b
`;

test('SCRUM-928: the connected output and the touch screen are read from what the kernel says', () =>
  inFolder((dir) => {
    const root = drm(dir, ['HDMI-A-1', 'Writeback-1']);
    writeFileSync(join(dir, 'inputs'), INPUTS);
    const run = ok(helper(dir, `display_connected_outputs "${root}"; echo ---; display_touch_devices "$S928/inputs"`));
    assert.equal(run.stdout, 'HDMI-A-1\n---\nILITEK ILITEK-TP\n', 'a writeback connector and a touch pad are neither');
    const none = ok(helper(dir, `display_connected_outputs "${drm(join(dir, 'b'), [])}"; display_touch_devices "$S928/missing"`));
    assert.equal(none.stdout, '');
  }));

// --- The turn: the desktop user's kanshi file ---------------------------------------

/** What the park's Pi was turned with by hand, the way the Screen Configuration tool writes it. */
const HAND_MADE_KANSHI = `profile {
\toutput HDMI-A-1 enable mode 1024x600@60.000 position 0,0 transform 90
}
`;
const KANSHI_BLOCK = (output: string, transform: string) =>
  `# >>> oto-box display (SCRUM-928): written by the OTO box installer; --display-rotate off removes this block
profile oto-box-display {
\toutput ${output} enable transform ${transform}
}
# <<< oto-box display (SCRUM-928)
`;

test('SCRUM-928: the box\'s kanshi profile goes on top of a hand-made one, which is kept byte for byte', () =>
  inFolder((dir) => {
    const file = join(dir, 'kanshi-config');
    writeFileSync(file, HAND_MADE_KANSHI);
    ok(helper(dir, 'display_kanshi_set "$S928/kanshi-config" HDMI-A-1 90'));
    assert.equal(readFileSync(file, 'utf8'), KANSHI_BLOCK('HDMI-A-1', '90') + HAND_MADE_KANSHI);
    // An update runs it again: the same bytes, never a second block.
    ok(helper(dir, 'display_kanshi_set "$S928/kanshi-config" HDMI-A-1 90'));
    assert.equal(readFileSync(file, 'utf8'), KANSHI_BLOCK('HDMI-A-1', '90') + HAND_MADE_KANSHI);
    // 270 replaces the box's block, and only it.
    ok(helper(dir, 'display_kanshi_set "$S928/kanshi-config" HDMI-A-1 270'));
    assert.equal(readFileSync(file, 'utf8'), KANSHI_BLOCK('HDMI-A-1', '270') + HAND_MADE_KANSHI);
    // off: exactly the file the person had.
    ok(helper(dir, 'display_kanshi_clear "$S928/kanshi-config"'));
    assert.equal(readFileSync(file, 'utf8'), HAND_MADE_KANSHI);
    // Nothing of the box's left: clearing again says so and changes nothing.
    assert.equal(helper(dir, 'display_kanshi_clear "$S928/kanshi-config"').status, 1);
    assert.equal(readFileSync(file, 'utf8'), HAND_MADE_KANSHI);
  }));

test('SCRUM-928: a kanshi file the box made holds only its block, and goes with it', () =>
  inFolder((dir) => {
    const file = join(dir, 'home', '.config', 'kanshi', 'config');
    ok(helper(dir, 'display_kanshi_set "$S928/home/.config/kanshi/config" HDMI-A-2 180'));
    assert.equal(readFileSync(file, 'utf8'), KANSHI_BLOCK('HDMI-A-2', '180'));
    ok(helper(dir, 'display_kanshi_clear "$S928/home/.config/kanshi/config"'));
    assert.equal(existsSync(file), false);
  }));

// --- The touch: labwc's rc.xml --------------------------------------------------------

/** A touch mapping made by hand, the root as Raspberry Pi OS writes it. */
const HAND_MADE_RC = `<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
\t<touch deviceName="ILITEK ILITEK-TP" mapToOutput="HDMI-A-1" mouseEmulation="no"/>
</openbox_config>
`;
const SYSTEM_RC = `<?xml version="1.0"?>
<labwc_config>
  <theme><name>PiXnoir_l</name></theme>
</labwc_config>
`;
const XML_BEGIN =
  '<!-- >>> oto-box display (SCRUM-928): written by the OTO box installer; its display-rotate off removes this block -->';
const XML_END = '<!-- <<< oto-box display (SCRUM-928) -->';
const XML_MADE =
  '<!-- oto-box display (SCRUM-928): this file was made by the OTO box installer from the system rc.xml -->';

test('SCRUM-928: the touch lines go last in a hand-made rc.xml, so labwc finds them first, and come out exactly', () =>
  inFolder((dir) => {
    const file = join(dir, 'rc.xml');
    writeFileSync(file, HAND_MADE_RC);
    ok(helper(dir, 'display_labwc_set "$S928/rc.xml" HDMI-A-1 \'ZZ "Touch" <&>\' "$S928/none.xml"'));
    const written = readFileSync(file, 'utf8');
    assert.equal(
      written,
      HAND_MADE_RC.replace(
        '</openbox_config>',
        `${XML_BEGIN}
<touch deviceName="ZZ &quot;Touch&quot; &lt;&amp;&gt;" mapToOutput="HDMI-A-1" mouseEmulation="no" />
<touch mapToOutput="HDMI-A-1" mouseEmulation="no" />
${XML_END}
</openbox_config>`,
      ),
    );
    assert.doesNotMatch(written.replace(/^<\?xml.*$/m, ''), /<!--(?:(?!-->)[\s\S])*--(?!>)/, 'no two hyphens inside an XML comment');
    ok(helper(dir, 'display_labwc_set "$S928/rc.xml" HDMI-A-1 "" "$S928/none.xml"'));
    assert.equal(
      readFileSync(file, 'utf8'),
      HAND_MADE_RC.replace(
        '</openbox_config>',
        `${XML_BEGIN}\n<touch mapToOutput="HDMI-A-1" mouseEmulation="no" />\n${XML_END}\n</openbox_config>`,
      ),
      'run again with no touch screen named: one block, the fallback line only',
    );
    ok(helper(dir, 'display_labwc_clear "$S928/rc.xml" "$S928/none.xml"'));
    assert.equal(readFileSync(file, 'utf8'), HAND_MADE_RC, 'off: the hand-made file, byte for byte');
  }));

test('SCRUM-928: with no rc.xml of the user\'s, one is made from the system\'s and goes again on off', () =>
  inFolder((dir) => {
    writeFileSync(join(dir, 'system.xml'), SYSTEM_RC);
    const file = join(dir, 'home', '.config', 'labwc', 'rc.xml');
    ok(helper(dir, 'display_labwc_set "$S928/home/.config/labwc/rc.xml" HDMI-A-1 "" "$S928/system.xml"'));
    assert.equal(
      readFileSync(file, 'utf8'),
      SYSTEM_RC.replace(
        '</labwc_config>',
        `${XML_BEGIN}\n<touch mapToOutput="HDMI-A-1" mouseEmulation="no" />\n${XML_END}\n</labwc_config>`,
      ) + `${XML_MADE}\n`,
    );
    ok(helper(dir, 'display_labwc_clear "$S928/home/.config/labwc/rc.xml" "$S928/system.xml"'));
    assert.equal(existsSync(file), false);

    // Made by the box, then changed by somebody: off keeps their change.
    ok(helper(dir, 'display_labwc_set "$S928/home/.config/labwc/rc.xml" HDMI-A-1 "" "$S928/system.xml"'));
    writeFileSync(file, readFileSync(file, 'utf8').replace('PiXnoir_l', 'PiXnoir_d'));
    ok(helper(dir, 'display_labwc_clear "$S928/home/.config/labwc/rc.xml" "$S928/system.xml"'));
    assert.equal(readFileSync(file, 'utf8'), SYSTEM_RC.replace('PiXnoir_l', 'PiXnoir_d') + `${XML_MADE}\n`);
  }));

test('SCRUM-928: an rc.xml with no closing tag the installer knows is left untouched', () =>
  inFolder((dir) => {
    writeFileSync(join(dir, 'rc.xml'), '<?xml version="1.0"?>\n<something/>\n');
    assert.equal(helper(dir, 'display_labwc_set "$S928/rc.xml" HDMI-A-1 "" "$S928/none.xml"').status, 1);
    assert.equal(readFileSync(join(dir, 'rc.xml'), 'utf8'), '<?xml version="1.0"?>\n<something/>\n');
  }));

// --- The camera: Chromium's managed policy ----------------------------------------------

test('SCRUM-896: the camera is allowed for the screen address\'s origin, and only for it', () =>
  inFolder((dir) => {
    const origins = ok(
      helper(
        dir,
        [
          'display_origin "https://oto-pos-web-staging.onrender.com/display?keyboard=screen"; echo',
          'display_origin "https://User@OTO-POS-Web-Staging.onrender.com:443/display#cw"; echo',
          'display_origin "http://127.0.0.1:8780/display?keyboard=screen"; echo',
          'display_origin "http://[::1]:8780/display"; echo',
          'display_origin "javascript:alert(1)" || echo refused',
        ].join('\n'),
      ),
    );
    assert.equal(
      origins.stdout,
      [
        'https://oto-pos-web-staging.onrender.com',
        'https://oto-pos-web-staging.onrender.com',
        'http://127.0.0.1:8780',
        'http://[::1]:8780',
        'refused',
        '',
      ].join('\n'),
    );

    // Chromium's own folder always; the chromium-browser package's only where it is installed.
    mkdirSync(join(dir, 'etc', 'chromium', 'policies', 'managed'), { recursive: true });
    writeFileSync(join(dir, 'etc', 'chromium', 'policies', 'managed', 'park.json'), '{"HomepageLocation":"x"}\n');
    ok(helper(dir, 'display_camera_set https://oto-pos-web-staging.onrender.com "$S928/etc/chromium" "$S928/etc/chromium-browser"'));
    const policy = join(dir, 'etc', 'chromium', 'policies', 'managed', 'oto-box-display-camera.json');
    assert.deepEqual(JSON.parse(readFileSync(policy, 'utf8')), {
      VideoCaptureAllowedUrls: ['https://oto-pos-web-staging.onrender.com/'],
    });
    assert.equal(existsSync(join(dir, 'etc', 'chromium-browser')), false, 'no folder made for a package that is not there');
    mkdirSync(join(dir, 'etc', 'chromium-browser'));
    ok(helper(dir, 'display_camera_set https://oto-pos-web-staging.onrender.com "$S928/etc/chromium" "$S928/etc/chromium-browser"'));
    assert.equal(existsSync(join(dir, 'etc', 'chromium-browser', 'policies', 'managed', 'oto-box-display-camera.json')), true);

    // off: the box's files go, the park's own policy stays.
    ok(helper(dir, 'display_camera_clear "$S928/etc/chromium" "$S928/etc/chromium-browser"'));
    assert.equal(existsSync(policy), false);
    assert.equal(existsSync(join(dir, 'etc', 'chromium-browser', 'policies', 'managed', 'oto-box-display-camera.json')), false);
    assert.equal(readFileSync(join(dir, 'etc', 'chromium', 'policies', 'managed', 'park.json'), 'utf8'), '{"HomepageLocation":"x"}\n');
    assert.equal(helper(dir, 'display_camera_clear "$S928/etc/chromium" "$S928/etc/chromium-browser"').status, 1);
  }));

// --- What a run settles before it changes anything ---------------------------------

interface Options {
  withKiosk?: 0 | 1;
  rotate?: string;
  kioskUrl?: string;
  kioskUrlGiven?: 0 | 1;
  displayRotate?: string;
  displayOutput?: string;
  displayCamera?: string;
}

const STAGING_DISPLAY = 'https://oto-pos-web-staging.onrender.com/display?keyboard=screen';

function preflight(dir: string, options: Options, config: string | null, connected: string[] = ['HDMI-A-1']): Run {
  if (config !== null) writeFileSync(join(dir, 'config'), config);
  else rmSync(join(dir, 'config'), { force: true });
  const root = drm(dir, connected);
  return helper(
    dir,
    [
      `WITH_KIOSK=${options.withKiosk ?? 1}`,
      `ROTATE='${options.rotate ?? ''}'`,
      `KIOSK_URL='${options.kioskUrl ?? ''}'`,
      `KIOSK_URL_GIVEN=${options.kioskUrlGiven ?? (options.kioskUrl === undefined ? 0 : 1)}`,
      `DISPLAY_ROTATE='${options.displayRotate ?? ''}'`,
      `DISPLAY_OUTPUT='${options.displayOutput ?? ''}'`,
      `DISPLAY_CAMERA='${options.displayCamera ?? ''}'`,
      `display_preflight "$S928/config" "${root}"`,
      'echo "rotate=$DISPLAY_ROTATE_NOW output=$DISPLAY_OUTPUT_NOW camera=$DISPLAY_CAMERA_NOW origin=$DISPLAY_ORIGIN_NOW"',
    ].join('\n'),
  );
}

const refusal = (run: Run) => {
  assert.equal(run.status, 3, `expected a refusal\n${run.stderr}\n${run.stdout}`);
  return /^DIE: (.*)$/m.exec(run.stderr)?.[1] ?? '';
};

test('SCRUM-928: a first install for the vertical display settles the turn on the output it sees', () =>
  inFolder((dir) => {
    const run = ok(preflight(dir, { kioskUrl: STAGING_DISPLAY, rotate: 'off', displayRotate: '90', displayCamera: 'allow' }, null));
    assert.equal(run.stdout, 'rotate=90 output=HDMI-A-1 camera=allow origin=https://oto-pos-web-staging.onrender.com\n');
  }));

test('SCRUM-928: an update with no display option keeps what the box has', () =>
  inFolder((dir) => {
    const config = `OTO_KIOSK_ROTATE=off\nOTO_KIOSK_URL=${STAGING_DISPLAY}\nOTO_DISPLAY_ROTATE=270\nOTO_DISPLAY_OUTPUT=HDMI-A-1\nOTO_DISPLAY_CAMERA=allow\n`;
    // The monitor switched off while the update ran: the kept output is used.
    const run = ok(preflight(dir, {}, config, []));
    assert.equal(run.stdout, 'rotate=270 output=HDMI-A-1 camera=allow origin=https://oto-pos-web-staging.onrender.com\n');
    // The cable moved to the other socket: the one connected now wins.
    const moved = ok(preflight(dir, {}, config, ['HDMI-A-2']));
    assert.equal(moved.stdout, 'rotate=270 output=HDMI-A-2 camera=allow origin=https://oto-pos-web-staging.onrender.com\n');
    // And off is off, whatever was kept.
    const off = ok(preflight(dir, { displayRotate: 'off', displayCamera: 'off' }, config));
    assert.equal(off.stdout, 'rotate=off output= camera=off origin=\n');
  }));

test('SCRUM-928: a box with no display option settles nothing, exactly as before', () =>
  inFolder((dir) => {
    assert.equal(ok(preflight(dir, {}, null)).stdout, 'rotate=off output= camera=off origin=\n');
    assert.equal(ok(preflight(dir, { kioskUrl: STAGING_DISPLAY, rotate: 'off' }, null)).stdout, 'rotate=off output= camera=off origin=\n');
    assert.equal(ok(preflight(dir, { withKiosk: 0 }, null)).stdout, 'rotate=off output= camera=off origin=\n');
  }));

test('SCRUM-928: the turn is refused on a box with no screen, with the page turning too, and on the booth', () =>
  inFolder((dir) => {
    assert.match(
      refusal(preflight(dir, { withKiosk: 0, displayRotate: '90' }, null)),
      /^--display-rotate turns the customer display's screen, and --no-kiosk says there is no screen: pass one of them$/,
    );
    assert.match(
      refusal(preflight(dir, { withKiosk: 0, displayCamera: 'allow' }, null)),
      /--no-kiosk says there is no screen/,
    );
    // --rotate cw given with it, and the first install's own default (cw) alike.
    assert.match(
      refusal(preflight(dir, { kioskUrl: STAGING_DISPLAY, rotate: 'cw', displayRotate: '90' }, null)),
      /the page must not turn as well \(the page's turn is cw\): add --rotate off$/,
    );
    assert.match(
      refusal(preflight(dir, { kioskUrl: STAGING_DISPLAY, displayRotate: '90' }, null)),
      /the page's turn is cw\): add --rotate off$/,
    );
    // An update whose box turns its page already.
    assert.match(
      refusal(preflight(dir, { displayRotate: '270' }, `OTO_KIOSK_ROTATE=ccw\nOTO_KIOSK_URL=${STAGING_DISPLAY}\n`)),
      /the page's turn is ccw\)/,
    );
    // The booth's own page turns itself.
    assert.match(
      refusal(preflight(dir, { rotate: 'off', displayRotate: '90' }, 'OTO_KIOSK_URL=\n')),
      /this one opens the box's own booth page, which turns itself with --rotate/,
    );
    assert.match(
      refusal(preflight(dir, { rotate: 'off', displayRotate: '90', kioskUrl: '' }, `OTO_KIOSK_URL=${STAGING_DISPLAY}\n`)),
      /opens the box's own booth page/,
      '--kiosk-url "" on an update counts',
    );
    assert.match(
      refusal(preflight(dir, { displayCamera: 'allow' }, 'OTO_KIOSK_URL=\n')),
      /^--display-camera allow lets the display's address use the camera, and this screen opens the box's own booth page/,
    );
  }));

test('SCRUM-928: with no screen seen, or two, the installer asks for the output by name', () =>
  inFolder((dir) => {
    const options = { kioskUrl: STAGING_DISPLAY, rotate: 'off', displayRotate: '90' };
    assert.match(refusal(preflight(dir, options, null, [])), /no screen is connected .* --display-output HDMI-A-1$/);
    assert.match(
      refusal(preflight(dir, options, null, ['HDMI-A-1', 'HDMI-A-2'])),
      /more than one screen is connected \(HDMI-A-1 HDMI-A-2\): name the customer display's with --display-output/,
    );
    assert.equal(
      ok(preflight(dir, { ...options, displayOutput: 'HDMI-A-2' }, null, ['HDMI-A-1', 'HDMI-A-2'])).stdout,
      'rotate=90 output=HDMI-A-2 camera=off origin=\n',
    );
  }));

// --- Writing it for the desktop user --------------------------------------------------

function applyTurn(dir: string, rotate: string, extra = ''): Run {
  return helper(
    dir,
    [
      `DISPLAY_ROTATE_NOW=${rotate}; DISPLAY_OUTPUT_NOW=HDMI-A-1; DISPLAY_NOTE=unset`,
      extra,
      'display_turn_apply "$S928/home" "" "$S928/inputs" "$S928/system.xml" "$S928/autostart $S928/home/.config/labwc/autostart" "$S928/udev"',
      'printf "%s\\n" "$DISPLAY_NOTE"',
    ].join('\n'),
  );
}

test('SCRUM-928: on the park\'s Pi the turn and the touch are written beside what was made by hand', () =>
  inFolder((dir) => {
    mkdirSync(join(dir, 'home', '.config', 'kanshi'), { recursive: true });
    mkdirSync(join(dir, 'home', '.config', 'labwc'), { recursive: true });
    mkdirSync(join(dir, 'udev'));
    writeFileSync(join(dir, 'home', '.config', 'kanshi', 'config'), HAND_MADE_KANSHI);
    writeFileSync(join(dir, 'home', '.config', 'labwc', 'rc.xml'), HAND_MADE_RC);
    writeFileSync(join(dir, 'system.xml'), SYSTEM_RC);
    writeFileSync(join(dir, 'inputs'), INPUTS);
    writeFileSync(join(dir, 'autostart'), '/usr/bin/lwrespawn /usr/bin/wf-panel-pi &\n/usr/bin/kanshi &\n');
    const run = ok(applyTurn(dir, '90'));
    assert.equal(run.stderr, '', 'no warning on a desktop that starts kanshi and has no hand-made calibration');
    assert.equal(
      readFileSync(join(dir, 'home', '.config', 'kanshi', 'config'), 'utf8'),
      KANSHI_BLOCK('HDMI-A-1', '90') + HAND_MADE_KANSHI,
    );
    assert.match(readFileSync(join(dir, 'home', '.config', 'labwc', 'rc.xml'), 'utf8'), /<touch deviceName="ILITEK ILITEK-TP" mapToOutput="HDMI-A-1" mouseEmulation="no" \/>\n<touch mapToOutput="HDMI-A-1" mouseEmulation="no" \/>\n<!-- <<< oto-box display/);
    assert.match(run.stdout.trimEnd(), /^90 on HDMI-A-1, from the next boot \(sudo reboot\): the box's profile at the top of .*kanshi\/config \(the profile\(s\) already in that file are kept below the box's and apply again with --display-rotate off\); touch mapped to HDMI-A-1 in .*rc\.xml \("ILITEK ILITEK-TP", and every other touch screen\)$/);

    // off: both files back as they were made by hand, and the summary says the hand-made profile applies.
    const off = ok(applyTurn(dir, 'off'));
    assert.equal(readFileSync(join(dir, 'home', '.config', 'kanshi', 'config'), 'utf8'), HAND_MADE_KANSHI);
    assert.equal(readFileSync(join(dir, 'home', '.config', 'labwc', 'rc.xml'), 'utf8'), HAND_MADE_RC);
    assert.match(off.stdout.trimEnd(), /^off: the box's turn taken out of .*; the box's touch lines taken out of .*\. From the next boot \(sudo reboot\) the desktop shows the screen as it is made, or as the profile still in .*kanshi\/config turns it$/);

    // off again, with nothing of the box's left: no file touched, nothing to say.
    const again = ok(applyTurn(dir, 'off'));
    assert.equal(again.stdout, '\n');
  }));

test('SCRUM-928: a desktop that does not start kanshi, or a hand-made touch calibration, is said out loud', () =>
  inFolder((dir) => {
    mkdirSync(join(dir, 'udev'));
    writeFileSync(join(dir, 'udev', '99-touch.rules'), 'ENV{LIBINPUT_CALIBRATION_MATRIX}="0 1 0 -1 0 1"\n');
    writeFileSync(join(dir, 'autostart'), '/usr/bin/wf-panel-pi &\n');
    const run = ok(applyTurn(dir, '270'));
    assert.match(run.stderr, /^WARN: nothing in the desktop's autostart .* starts kanshi/m);
    assert.match(run.stderr, /^WARN: a touch calibration made by hand is in .*99-touch\.rules: with the box's mapping the touch may now turn twice/m);
    assert.match(run.stdout.trimEnd(), /WARNING: this desktop's autostart does not start kanshi\. WARNING: a hand-made touch calibration is in .*99-touch\.rules$/);
    // No touch screen plugged in: the fallback line still maps whatever is plugged in later.
    assert.match(run.stdout, /touch mapped to HDMI-A-1 in .* for every touch screen \(none is plugged in now: plug the monitor's touch cable in\)/);
    // A kanshi file made by the box alone; an rc.xml with nothing to copy made from an empty one.
    assert.equal(readFileSync(join(dir, 'home', '.config', 'kanshi', 'config'), 'utf8'), KANSHI_BLOCK('HDMI-A-1', '270'));
    assert.match(readFileSync(join(dir, 'home', '.config', 'labwc', 'rc.xml'), 'utf8'), /^<\?xml version="1\.0"\?>\n<labwc_config>\n<!-- >>> oto-box display/);
    ok(applyTurn(dir, 'off'));
    assert.equal(existsSync(join(dir, 'home', '.config', 'kanshi', 'config')), false);
    assert.equal(existsSync(join(dir, 'home', '.config', 'labwc', 'rc.xml')), false);
  }));

test('SCRUM-896: the camera note says what was written, taken out, or nothing', () =>
  inFolder((dir) => {
    const run = (camera: string, origin = '') =>
      ok(
        helper(
          dir,
          `DISPLAY_CAMERA_NOW=${camera}; DISPLAY_ORIGIN_NOW='${origin}'; CAMERA_NOTE=unset\ndisplay_camera_apply "$S928/etc/chromium" "$S928/etc/chromium-browser"\nprintf '%s\\n' "$CAMERA_NOTE"`,
        ),
      ).stdout;
    assert.match(
      run('allow', 'https://oto-pos-web-staging.onrender.com'),
      /^allowed without a tap for https:\/\/oto-pos-web-staging\.onrender\.com only \(Chromium policy .*\/etc\/chromium\/policies\/managed\/oto-box-display-camera\.json\), from the next start of the screen\n$/,
    );
    assert.match(run('off'), /^off: the box's camera policy taken out/);
    assert.equal(run('off'), '\n', 'never set: nothing to say, nothing touched');
  }));

// --- The installer's own parts -----------------------------------------------------

/** The installer's option loop and its checks of each value's shape, with `args`. */
function options(args: string[]): Run {
  return inFolder((dir) => {
    const file = join(dir, 'options.sh');
    writeFileSync(
      file,
      [
        ONLY_STAND_INS,
        cut('set -euo pipefail', 'die() {'),
        `set -- ${args.map((arg) => `'${arg}'`).join(' ')}`,
        cut('while [ $# -gt 0 ]; do', 'done'),
        cut('case "$DISPLAY_ROTATE" in', 'esac'),
        cut('case "$DISPLAY_CAMERA" in', 'esac'),
        cut('if [ -n "$DISPLAY_OUTPUT" ]; then', 'fi'),
        'echo "rotate=$DISPLAY_ROTATE output=$DISPLAY_OUTPUT camera=$DISPLAY_CAMERA"',
      ].join('\n'),
    );
    return spawnSync(bash, [shellPath(file)], {
      encoding: 'utf8',
      env: { ...process.env, S928_BIN: shellPath(dir) },
    });
  });
}

test('SCRUM-928: the options are read, and a wrong value is refused in a plain line', () => {
  assert.equal(
    ok(options(['--display-rotate', '90', '--display-output', 'HDMI-A-1', '--display-camera', 'allow'])).stdout,
    'rotate=90 output=HDMI-A-1 camera=allow\n',
  );
  assert.equal(ok(options([])).stdout, 'rotate= output= camera=\n');
  const wrong = (args: string[]) => {
    const run = options(args);
    assert.notEqual(run.status, 0);
    return run.stderr;
  };
  assert.match(wrong(['--display-rotate', 'cw']), /--display-rotate wants 90, 180, 270 or off, got cw/);
  assert.match(wrong(['--display-camera', 'yes']), /--display-camera wants allow or off, got yes/);
  assert.match(wrong(['--display-output', 'HDMI A 1']), /--display-output wants an output's name such as HDMI-A-1, got HDMI A 1/);
  assert.match(wrong(['--display-output', 'x;reboot']), /--display-output wants an output's name/);
});

/** The installer's config step, on a config file of the test's own. */
function configStep(dir: string, vars: string): Run {
  const file = join(dir, 'config-step.sh');
  writeFileSync(
    file,
    [
      ONLY_STAND_INS,
      cut('set -euo pipefail', 'die() {'),
      'install() { :; }',
      vars,
      cut('config_set() {', 'chmod 0644 /etc/oto-box/config').replaceAll('/etc/oto-box/config', '"$S928_CONFIG"'),
    ].join('\n'),
  );
  return spawnSync(bash, [shellPath(file)], {
    encoding: 'utf8',
    env: { ...process.env, S928_BIN: shellPath(dir), S928_CONFIG: shellPath(join(dir, 'config')) },
  });
}

const configValue = (dir: string, key: string) =>
  readFileSync(join(dir, 'config'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

test('SCRUM-928: the config keeps the turn, the output and the camera through an update, and off is written', () =>
  inFolder((dir) => {
    ok(
      configStep(
        dir,
        `KIOSK_URL='${STAGING_DISPLAY}'; KIOSK_URL_GIVEN=1; ROTATE=off; KIOSK_SCALE=1; DISPLAY_ROTATE=90; DISPLAY_CAMERA=allow; DISPLAY_OUTPUT_NOW=HDMI-A-1`,
      ),
    );
    assert.deepEqual(configValue(dir, 'OTO_DISPLAY_ROTATE'), ['90']);
    assert.deepEqual(configValue(dir, 'OTO_DISPLAY_OUTPUT'), ['HDMI-A-1']);
    assert.deepEqual(configValue(dir, 'OTO_DISPLAY_CAMERA'), ['allow']);
    assert.deepEqual(configValue(dir, 'OTO_KIOSK_SCREEN'), ['on']);
    assert.deepEqual(configValue(dir, 'OTO_KIOSK_URL'), [STAGING_DISPLAY]);
    assert.deepEqual(configValue(dir, 'OTO_KIOSK_ROTATE'), ['off']);
    // An update that names none of it: every value kept, none written twice.
    const before = readFileSync(join(dir, 'config'), 'utf8');
    ok(configStep(dir, 'DISPLAY_OUTPUT_NOW=HDMI-A-1'));
    assert.equal(readFileSync(join(dir, 'config'), 'utf8'), before);
    // off, each on its own line, and the same file otherwise.
    ok(configStep(dir, 'DISPLAY_ROTATE=off; DISPLAY_CAMERA=off'));
    assert.deepEqual(configValue(dir, 'OTO_DISPLAY_ROTATE'), ['off']);
    assert.deepEqual(configValue(dir, 'OTO_DISPLAY_CAMERA'), ['off']);
    assert.deepEqual(configValue(dir, 'OTO_DISPLAY_OUTPUT'), ['HDMI-A-1']);
    // --no-kiosk: the config says there is no screen.
    ok(configStep(dir, 'WITH_KIOSK=0'));
    assert.deepEqual(configValue(dir, 'OTO_KIOSK_SCREEN'), ['off']);
  }));

test('SCRUM-962: the box command hands the screen settings to `oto-box status` when run through sudo', () => {
  for (const key of ['OTO_KIOSK_SCREEN', 'OTO_KIOSK_URL', 'OTO_DISPLAY_ROTATE', 'OTO_DISPLAY_OUTPUT', 'OTO_DISPLAY_CAMERA']) {
    assert.ok(installer.includes(`${key}="\\$${key}"`), key);
  }
});

// --- The summary --------------------------------------------------------------

/** The installer from "Starting" to its last line, with `vars` set by the steps before it. */
function summary(dir: string, vars: string, config: string): Run {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tailscale'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(bin, 'tailscale'), 0o755);
  writeFileSync(join(dir, 'config'), config);
  const file = join(dir, 'summary.sh');
  writeFileSync(
    file,
    [
      ONLY_STAND_INS,
      cut('set -euo pipefail', 'die() {'),
      'systemctl() { :; }',
      'sleep() { :; }',
      cut('ts_name() {', 'TS_NOTE="not configured"'),
      'RELEASE="0.1.0-20261113-test"; DHCP_OK=0; KIOSK_URL_NOW=""',
      'SSH_NOTE="ssh note"; PRINTER_NOTE="printer note"; SCANNER_NOTE="scanner note"; MIRROR_NOTE="mirror note"',
      vars,
      cut('say "Starting"', null).replaceAll('/etc/oto-box/config', '"$S928_CONFIG"'),
    ].join('\n'),
  );
  return spawnSync(bash, [shellPath(file)], {
    encoding: 'utf8',
    env: { ...process.env, S928_BIN: shellPath(bin), S928_CONFIG: shellPath(join(dir, 'config')) },
  });
}

const LAST_LINE =
  'The credential is /var/lib/oto-box/credential.json (owner-only). Never copy it to another machine.';
const line = (stdout: string, label: string) => new RegExp(`^${label}: (.*)$`, 'm').exec(stdout)?.[1];

test('SCRUM-962: the summary names a web address and says a web deploy reaches it; turn and camera beside it', () =>
  inFolder((dir) => {
    const run = ok(
      summary(
        dir,
        `KIOSK_URL_NOW='${STAGING_DISPLAY}'; BLANKING_NOTE=off; DISPLAY_NOTE='90 on HDMI-A-1, from the next boot (sudo reboot)'; CAMERA_NOTE='allowed without a tap for https://oto-pos-web-staging.onrender.com only'`,
        `OTO_BOX_API=https://api.example.test\nOTO_KIOSK_URL=${STAGING_DISPLAY}\nOTO_KIOSK_SCALE=1\nOTO_KIOSK_ROTATE=off\n`,
      ),
    );
    assert.equal(
      line(run.stdout, 'Screen'),
      `opens ${STAGING_DISPLAY} (a web address: a display change reaches this screen with a web deploy, no box release; while it does not answer, the screen shows the box's own waiting page and opens it by itself once it does), scale 1, page turn off. Screen blanking: off. The monitor's own sleep timer is set in its own menu.`,
    );
    assert.equal(line(run.stdout, 'Display turn'), '90 on HDMI-A-1, from the next boot (sudo reboot).');
    assert.equal(line(run.stdout, 'Camera'), 'allowed without a tap for https://oto-pos-web-staging.onrender.com only.');
    assert.equal(run.stdout.trimEnd().split('\n').at(-1), LAST_LINE);
  }));

test('SCRUM-962: the summary names the box\'s own copy of the display and the release folder it comes from', () =>
  inFolder((dir) => {
    const local = 'http://127.0.0.1:8780/display?keyboard=screen';
    const run = ok(
      summary(dir, `KIOSK_URL_NOW='${local}'; BLANKING_NOTE=off`, `OTO_BOX_API=https://api.example.test\nOTO_KIOSK_URL=${local}\nOTO_KIOSK_SCALE=1.25\nOTO_KIOSK_ROTATE=off\n`),
    );
    assert.match(
      line(run.stdout, 'Screen') ?? '',
      /^opens http:\/\/127\.0\.0\.1:8780\/display\?keyboard=screen \(the box's own copy of the display page, served from this release's page folder \/opt\/oto-box\/releases\/0\.1\.0-20261113-test\/display: a display change reaches this screen only with a new box release\), scale 1\.25, page turn off\./,
    );
    assert.equal(line(run.stdout, 'Display turn'), 'none: the desktop shows the screen as it is made, or as its own settings turn it (--display-rotate turns it).');
    assert.equal(line(run.stdout, 'Camera'), "the display's page asks before it uses the camera (--display-camera allow allows it for this address only).");
  }));

test('SCRUM-962: the booth names its own page; a box with no screen says so', () =>
  inFolder((dir) => {
    const booth = ok(summary(dir, '', 'OTO_BOX_API=https://api.example.test\nOTO_KIOSK_URL=\n'));
    assert.equal(
      line(booth.stdout, 'Screen'),
      "opens the box's own booth page, http://127.0.0.1:8780/ (served from this release's page folder /opt/oto-box/releases/0.1.0-20261113-test/booth: a change to it needs a new box release), page turn cw.",
    );
    assert.equal(line(booth.stdout, 'Display turn'), undefined, 'nothing about a display on the booth');
    assert.equal(line(booth.stdout, 'Camera'), undefined);
    const headless = ok(summary(dir, 'WITH_KIOSK=0', 'OTO_BOX_API=https://api.example.test\n'));
    assert.equal(line(headless.stdout, 'Screen'), 'none (--no-kiosk): this box draws nothing on a screen.');
    assert.equal(headless.stdout.trimEnd().split('\n').at(-1), LAST_LINE);
  }));

test('SCRUM-928: the release carries the helper, and the installer reads it before anything changes', () => {
  assert.ok(existsSync(helperPath));
  const preflightAt = installer.indexOf('display_preflight /etc/oto-box/config /sys/class/drm');
  assert.ok(preflightAt > 0);
  for (const change of ['apt-get update -qq', 'say "Release $RELEASE"', 'say "/etc/oto-box/config"']) {
    assert.ok(installer.indexOf(change) > preflightAt, `${change} comes after the refusals`);
  }
});
