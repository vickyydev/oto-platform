// Turning the platform's fleet records — boxes, devices, stations — into the
// shapes the prototype's screens already speak, and remembering the devices of
// the station this till is working so print routing can still name them.
//
// The two vocabularies differ in one word: the prototype says "bracelet", the
// platform says "band" (S2-01b renamed wristband → band throughout). The tables
// below are the only place the two names meet.
import type { ApiDevice, ApiStation, StationDeviceAssignment, StationDeviceRole } from '@/api/platform';
import type { Device, DeviceType, ScannerMode, StationCapability, StationProfile } from '@/types';

/** The device slots a station has, in the order the wizard asks about them. */
export type DeviceRole = 'receipt' | 'kids' | 'adult' | 'kitchen' | 'bar';

export const ROLE_TO_API: Record<DeviceRole, StationDeviceRole> = {
  receipt: 'receipt',
  kids: 'kids_band',
  adult: 'adult_band',
  kitchen: 'kitchen',
  bar: 'bar',
};

/**
 * A device kind with no entry here has no slot on the prototype's station
 * screens and is left out of its pickers: card and QR terminals are chosen as
 * payment routing, gates belong to the gate configuration, and a cash drawer
 * hangs off whichever receipt printer opens it.
 */
const KIND_TO_PROTOTYPE: Record<string, DeviceType | undefined> = {
  receipt_printer: 'receipt_printer',
  band_printer: 'bracelet_printer',
  kitchen_printer: 'kitchen_printer',
  bar_printer: 'bar_printer',
  scanner: 'scanner',
  gate: 'gate',
  gate_reader: 'gate',
};

const CAPABILITIES: StationCapability[] = ['tickets', 'fnb', 'dropoff', 'parties'];

/** The API's vocabulary can grow past the prototype's; anything else is dropped. */
export function toCapabilities(values: readonly string[] | undefined): StationCapability[] {
  return CAPABILITIES.filter((c) => values?.includes(c));
}

/**
 * How a device is wired, said plainly under its name. The prototype knows two
 * links — an Ethernet printer with an address, and a scanner paired to the iPad
 * in iOS Settings — but a device on a box can also be on the end of a USB or a
 * serial cable, and calling that "paired in iOS Settings" would be untrue. The
 * box is named as well, because the same printer model stands at several
 * counters and the box is what tells them apart.
 */
function transportNote(transport: string, address: string | null | undefined, boxName: string): string {
  switch (transport) {
    case 'lan':
      return address ? `${address} · ${boxName}` : boxName;
    case 'usb':
      return `USB on ${boxName}`;
    case 'serial':
      return `Serial on ${boxName}`;
    case 'bluetooth':
      return `Bluetooth to ${boxName}`;
    case 'simulated':
      return `Simulated on ${boxName}`;
    default:
      return boxName;
  }
}

function asPrototypeDevice(
  id: string,
  kind: string | null | undefined,
  label: string,
  transport: string | null | undefined,
  address: string | null | undefined,
  boxName: string,
): Device | null {
  const type = kind ? KIND_TO_PROTOTYPE[kind] : undefined;
  if (!type) return null;
  const link = transport === 'lan' ? 'network' : 'wired';
  return {
    id,
    type,
    label,
    connection: link === 'network' ? 'network' : 'bluetooth',
    address: address ?? undefined,
    link,
    transportNote: transportNote(transport ?? '', address, boxName),
  };
}

/** One of a box's devices in the shape DevicePicker draws. */
export function toPrototypeDevices(devices: ApiDevice[], boxName: string): Device[] {
  return devices
    .filter((d) => !d.archived)
    .map((d) => asPrototypeDevice(d.id, d.kind, d.label, d.transport, d.address, boxName))
    .filter((d): d is Device => d !== null);
}

/** The same, from the denormalised assignments a station carries. */
function assignedDevices(station: ApiStation, boxName: string): Device[] {
  return (station.devices ?? [])
    .map((a: StationDeviceAssignment) =>
      asPrototypeDevice(a.deviceId, a.kind, a.label ?? 'Device', a.transport, a.address, boxName),
    )
    .filter((d): d is Device => d !== null);
}

/**
 * The station record as the till's screens read it.
 *
 * `localScannerMode` is the one thing that cannot come from the station: a
 * Bluetooth scanner paired to this iPad, and the iPad's own camera, are facts
 * about the device in somebody's hands, not about the counter. A scanner
 * plugged into the box serves every screen on the station, so whenever one is
 * assigned it wins over both.
 */
export function toStationProfile(
  station: ApiStation,
  branchId: string,
  localScannerMode?: ScannerMode,
): StationProfile {
  const deviceFor = (role: StationDeviceRole): string | undefined =>
    (station.devices ?? []).find((d) => d.role === role)?.deviceId;
  const boxScanner = deviceFor('scanner');
  return {
    stationId: station.id,
    stationName: station.name,
    branchId,
    receiptPrinterId: deviceFor('receipt'),
    kidsBraceletPrinterId: deviceFor('kids_band'),
    adultBraceletPrinterId: deviceFor('adult_band'),
    kitchenPrinterId: deviceFor('kitchen'),
    barPrinterId: deviceFor('bar'),
    scannerId: boxScanner,
    scannerMode: boxScanner ? 'box' : localScannerMode ?? 'camera',
    capabilities: toCapabilities(station.capabilities as string[] | undefined),
  };
}

/**
 * The devices of the station this till is working, by id.
 *
 * Print routing resolves a device id to a label through `deviceById`, which
 * reads the prototype's in-memory catalogue. A station taken from the platform
 * carries real device ids that catalogue has never heard of, so the station
 * context files its devices here when it picks one and print routing looks here
 * first. A module-level map rather than context, because print routing is
 * called from plain functions and not from React.
 */
let stationDevices: Record<string, Device> = {};

export function rememberStation(station: ApiStation): void {
  const devices = assignedDevices(station, station.boxName ?? 'the box');
  stationDevices = Object.fromEntries(devices.map((d) => [d.id, d]));
}

export function forgetStationDevices(): void {
  stationDevices = {};
}

export function stationDevice(id: string): Device | undefined {
  return stationDevices[id];
}
