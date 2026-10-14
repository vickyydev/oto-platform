import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseInputDevices, parseThermalZone, piHardware } from '../src/runner/hardware';

/**
 * SCRUM-419 (closing audit L19, L34) — what a Raspberry Pi says about itself
 * on the heartbeat: its CPU temperature and whether a pointer is plugged in.
 * Read from the files Linux keeps; anything unreadable is "cannot tell", never
 * a number and never a thrown heartbeat. Proven here against copies of those
 * files; the reading on a real Pi rides the next bench session.
 */

test('the thermal zone is millidegrees, reported to one decimal, and a broken read is null', () => {
  assert.equal(parseThermalZone('48312\n'), 48.3);
  assert.equal(parseThermalZone('81000'), 81);
  assert.equal(parseThermalZone(''), null);
  assert.equal(parseThermalZone('garbage'), null);
  assert.equal(parseThermalZone('999999'), null, 'a 999 °C Pi is a broken read, not a fire');
});

const KEYBOARD_ONLY = `I: Bus=0003 Vendor=046d Product=c31c Version=0110
N: Name="Logitech USB Keyboard"
H: Handlers=sysrq kbd leds event0
B: EV=120013

I: Bus=0000 Vendor=0000 Product=0000 Version=0000
N: Name="vc4-hdmi-0"
H: Handlers=kbd event1
`;

const WITH_TOUCHPAD = `${KEYBOARD_ONLY}
I: Bus=0003 Vendor=046d Product=4024 Version=0111
N: Name="Logitech K400 Touchpad"
H: Handlers=mouse0 event2
`;

test('a pointer is a device feeding a mouse handler; a keyboard and the TV remote are not', () => {
  assert.equal(parseInputDevices(KEYBOARD_ONLY), false);
  assert.equal(parseInputDevices(WITH_TOUCHPAD), true);
  assert.equal(parseInputDevices(''), false);
});

test('the readers answer from the files, and null where there is no file to read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-hw-'));
  const thermal = join(dir, 'temp');
  const inputs = join(dir, 'devices');
  writeFileSync(thermal, '52125\n');
  writeFileSync(inputs, WITH_TOUCHPAD);
  const hw = piHardware({ thermal, inputs });
  assert.equal(await hw.tempC(), 52.1);
  assert.equal(await hw.pointerPresent(), true);

  const absent = piHardware({ thermal: join(dir, 'nope'), inputs: join(dir, 'nope') });
  assert.equal(await absent.tempC(), null);
  assert.equal(await absent.pointerPresent(), null);
});
