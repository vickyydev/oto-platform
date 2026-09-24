/**
 * Point the booth's receipt printer at the bench (SCRUM-223).
 *
 * The printer a voucher goes to is the device with the `receipt` role on the
 * booth station, as the Console set it up — its address and its transport come
 * down in the config bundle, and nothing on the box invents a printer. For a
 * bench test that is sometimes not enough: the Console row may still say
 * "simulated", or name an address the printer no longer has, or the head may
 * be 512 dots where nobody has recorded it. So `config.json` in the box's home
 * can override three things on that one device — host, port, dots per line —
 * and this is where it is applied.
 *
 * What it never does is make a printer up. A booth station with no receipt
 * printer in the Console stays without one, and the runner says so in its log,
 * because a printer that exists only on one Pi is a printer nobody else can
 * see, move or retire.
 */

import type { BoxConfigBundle, BoxConfigDevice } from '../protocol';
import type { PrinterOverride } from './home';

/**
 * The bundle with every booth station's receipt printer overridden, and the
 * names of booth stations that had none to override. The bundle passed in is
 * never modified: the copy on disk stays what the cloud sent.
 */
export function applyPrinterOverride(
  bundle: BoxConfigBundle,
  override: PrinterOverride | null | undefined,
): { bundle: BoxConfigBundle; withoutPrinter: string[] } {
  if (!override) return { bundle, withoutPrinter: [] };
  const withoutPrinter: string[] = [];
  const stations = bundle.stations.map((station) => {
    if (station.kind !== 'booth') return station;
    const index = station.devices.findIndex((device) => device.role === 'receipt');
    if (index < 0) {
      withoutPrinter.push(station.name);
      return station;
    }
    const devices = station.devices.map((device, i) =>
      i === index ? overrideDevice(device, override) : device,
    );
    return { ...station, devices };
  });
  return { bundle: { ...bundle, stations }, withoutPrinter };
}

function overrideDevice(device: BoxConfigDevice, override: PrinterOverride): BoxConfigDevice {
  const settings =
    typeof device.settings === 'object' && device.settings !== null
      ? (device.settings as Record<string, unknown>)
      : {};
  const escpos =
    typeof settings.escpos === 'object' && settings.escpos !== null
      ? (settings.escpos as Record<string, unknown>)
      : {};
  return {
    ...device,
    // A real socket, whatever the Console row says: the override exists to
    // print on the machine on this desk.
    transport: 'lan',
    address: `${override.host}:${override.port}`,
    settings: { ...settings, escpos: { ...escpos, dotsPerLine: override.widthDots } },
  };
}
