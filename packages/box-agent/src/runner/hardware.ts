import { readFile } from 'node:fs/promises';

/**
 * What a Raspberry Pi can say about itself (SCRUM-419, closing audit L19 and
 * L34), read from the files Linux keeps for it. Only the Pi's runner wires
 * these in; the virtual box in the api process reports null for both, because
 * the machine it runs on is not a booth.
 *
 * Every reader answers null when it cannot tell — a missing file, an
 * unreadable one, a value that does not parse — and never throws: a heartbeat
 * that carries "unknown" is worth more than one that was not sent.
 */

/** The Pi's SoC sensor. Millidegrees Celsius, one integer, on every Raspberry Pi OS. */
export const THERMAL_ZONE_PATH = '/sys/class/thermal/thermal_zone0/temp';
/** The kernel's list of input devices, with the handlers each one feeds. */
export const INPUT_DEVICES_PATH = '/proc/bus/input/devices';

/**
 * The thermal zone's reading in °C, to one decimal place.
 *
 * Anything outside what a working Pi can report (below −40 °C or above
 * 125 °C, the SoC's rated range) is not a temperature but a broken read, and
 * is reported as null rather than as an alarming number.
 */
export function parseThermalZone(text: string): number | null {
  const milli = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(milli)) return null;
  const celsius = Math.round(milli / 100) / 10;
  return celsius < -40 || celsius > 125 ? null : celsius;
}

/**
 * Whether any input device feeds a mouse handler — which is how Linux lists
 * a mouse, a touchpad and most touchscreens alike.
 *
 * The list is blocks of `X: …` lines separated by blank lines; the handlers
 * line reads e.g. `H: Handlers=mouse0 event3`. A keyboard alone, or the TV's
 * HDMI-CEC remote, has no `mouseN` handler.
 */
export function parseInputDevices(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => line.startsWith('H: Handlers=') && /\bmouse\d+\b/.test(line));
}

export function piHardware(paths: { thermal?: string; inputs?: string } = {}): {
  tempC: () => Promise<number | null>;
  pointerPresent: () => Promise<boolean | null>;
} {
  const thermal = paths.thermal ?? THERMAL_ZONE_PATH;
  const inputs = paths.inputs ?? INPUT_DEVICES_PATH;
  return {
    async tempC() {
      try {
        return parseThermalZone(await readFile(thermal, 'utf8'));
      } catch {
        return null;
      }
    },
    async pointerPresent() {
      try {
        return parseInputDevices(await readFile(inputs, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}
