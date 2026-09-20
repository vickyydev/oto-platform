/**
 * The fleet's vocabulary, in the words a person at the park uses.
 *
 * The database speaks `band_printer`, `selected_staff`, `qr_terminal`; a
 * manager standing at a counter says "band printer", "only named staff", "the
 * QR terminal". Every mapping is in one place so the two never drift, and
 * anything unrecognised falls back to the raw value tidied up rather than to a
 * blank — a value this console has not heard of is still a fact about the
 * station in front of somebody.
 */
import type { Tone } from '@/components/Status';
import type {
  BoxRole,
  BoxStatus,
  CredentialKind,
  DeviceKind,
  DeviceTransport,
  StationAccessScope,
  StationCapability,
  StationDeviceRole,
  StationKind,
} from '@/api/fleet';

function tidy(value: string): string {
  return value.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function word<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? tidy(value);
}

const BOX_ROLE_WORDS: Record<BoxRole, string> = {
  counter: 'Counter',
  gate: 'Gate',
  booth: 'Booth',
  kiosk: 'Kiosk',
  standby: 'Standby',
  virtual: 'Virtual',
};

export const boxRoleWord = (value: string): string => word(BOX_ROLE_WORDS, value);

const BOX_STATUS_WORDS: Record<BoxStatus, string> = {
  unclaimed: 'Waiting to be claimed',
  online: 'Online',
  offline: 'Offline',
  disabled: 'Out of service',
};

export const boxStatusWord = (value: string): string => word(BOX_STATUS_WORDS, value);

/**
 * `unclaimed` and `disabled` are grey rather than red. Neither is a fault:
 * one is a box nobody has plugged in yet, the other is a box somebody took out
 * of service on purpose, and painting either of them as broken would teach a
 * reader to ignore the colour that means a counter has actually gone dark.
 */
export function toneForBoxStatus(status: string): Tone {
  switch (status) {
    case 'online':
      return 'ok';
    case 'offline':
      return 'down';
    case 'unclaimed':
    case 'disabled':
      return 'idle';
    default:
      return 'idle';
  }
}

const DEVICE_KIND_WORDS: Record<DeviceKind, string> = {
  receipt_printer: 'Receipt printer',
  band_printer: 'Band printer',
  kitchen_printer: 'Kitchen printer',
  bar_printer: 'Bar printer',
  scanner: 'Scanner',
  terminal: 'Payment terminal',
  gate: 'Gate',
  gate_reader: 'Gate reader',
  cash_drawer: 'Cash drawer',
};

export const deviceKindWord = (value: string): string => word(DEVICE_KIND_WORDS, value);

const TRANSPORT_WORDS: Record<DeviceTransport, string> = {
  lan: 'LAN',
  usb: 'USB',
  serial: 'Serial',
  bluetooth: 'Bluetooth',
  simulated: 'Simulated',
};

export const transportWord = (value: string): string => word(TRANSPORT_WORDS, value);

const STATION_KIND_WORDS: Record<StationKind, string> = {
  till: 'Till',
  kiosk: 'Kiosk',
  gate: 'Gate',
  display: 'Customer display',
  booth: 'Booth',
};

export const stationKindWord = (value: string): string => word(STATION_KIND_WORDS, value);

const CAPABILITY_WORDS: Record<StationCapability, string> = {
  tickets: 'Tickets',
  fnb: 'F&B',
  dropoff: 'Drop-off',
  parties: 'Parties',
};

export const capabilityWord = (value: string): string => word(CAPABILITY_WORDS, value);

const DEVICE_ROLE_WORDS: Record<StationDeviceRole, string> = {
  receipt: 'Receipt printer',
  kids_band: "Kids' band printer",
  adult_band: 'Adult band printer',
  kitchen: 'Kitchen printer',
  bar: 'Bar printer',
  scanner: 'Scanner',
  card_terminal: 'Card terminal',
  qr_terminal: 'QR terminal',
  gate: 'Gate',
  cash_drawer: 'Cash drawer',
};

export const deviceRoleWord = (value: string): string => word(DEVICE_ROLE_WORDS, value);

const CREDENTIAL_KIND_WORDS: Record<CredentialKind, string> = {
  display: 'Customer display',
  kiosk: 'Kiosk',
  booth: 'Booth',
  box: 'Box',
};

export const credentialKindWord = (value: string): string => word(CREDENTIAL_KIND_WORDS, value);

const COMMAND_WORDS: Record<string, string> = {
  test_print: 'Test print',
  config_apply: 'Apply config',
  clear_cache: 'Clear cache',
  collect_logs: 'Collect logs',
  restart: 'Restart agent',
  go_offline: 'Go offline',
  go_online: 'Go online',
  reset_store: 'Reset store',
};

export const commandWord = (value: string): string => COMMAND_WORDS[value] ?? tidy(value);

/**
 * A command's state as a tone. `running` is amber rather than green: a command
 * the box took and has not reported on is not yet a success, and the gap
 * between the two is exactly what somebody watching a test print wants to see.
 */
export function toneForCommandState(state: string): Tone {
  switch (state) {
    case 'succeeded':
      return 'ok';
    case 'failed':
      return 'down';
    case 'running':
    case 'expired':
      return 'warn';
    default:
      return 'idle';
  }
}

export function toneForReachability(value: string | null | undefined): Tone {
  switch (value) {
    case 'reachable':
      return 'ok';
    case 'unreachable':
      return 'down';
    default:
      return 'idle';
  }
}

/** Paper, on a printer. `low` is amber because a band printer that runs out mid-queue stops a gate. */
export function toneForPaper(value: string | null | undefined): Tone {
  switch (value) {
    case 'ok':
      return 'ok';
    case 'low':
      return 'warn';
    case 'out':
      return 'down';
    default:
      return 'idle';
  }
}

/**
 * Which kinds of device can take each job.
 *
 * A kitchen ticket and a bar ticket both come off an 80 mm receipt printer at
 * the park (device inventory §2, rows 5 and 7), so those two roles accept a
 * plain receipt printer as well as a dedicated one. Everything else is exact:
 * a band comes off a band printer or it does not come off at all.
 */
const ROLE_ACCEPTS: Record<StationDeviceRole, DeviceKind[]> = {
  receipt: ['receipt_printer'],
  kids_band: ['band_printer'],
  adult_band: ['band_printer'],
  kitchen: ['kitchen_printer', 'receipt_printer'],
  bar: ['bar_printer', 'receipt_printer'],
  scanner: ['scanner'],
  card_terminal: ['terminal'],
  qr_terminal: ['terminal'],
  gate: ['gate', 'gate_reader'],
  cash_drawer: ['cash_drawer'],
};

export function roleAccepts(role: StationDeviceRole, kind: string): boolean {
  return (ROLE_ACCEPTS[role] as string[]).includes(kind);
}

/**
 * Which jobs a station of this kind has to fill, in the order the wizard asks
 * about them. A customer display drives nothing itself — it is a screen paired
 * to a till — so it has no device roles at all.
 */
const KIND_ROLES: Record<StationKind, StationDeviceRole[]> = {
  till: [
    'receipt',
    'kids_band',
    'adult_band',
    'scanner',
    'card_terminal',
    'qr_terminal',
    'cash_drawer',
    'kitchen',
    'bar',
  ],
  kiosk: ['receipt', 'kids_band', 'adult_band', 'scanner'],
  gate: ['gate', 'scanner'],
  booth: ['receipt', 'scanner'],
  display: [],
};

export function rolesForStationKind(kind: string): StationDeviceRole[] {
  return KIND_ROLES[kind as StationKind] ?? KIND_ROLES.till;
}

/** The kinds of screen that pair to a station. A box pairs by claim code instead. */
export const PAIRABLE_KINDS: CredentialKind[] = ['display', 'kiosk', 'booth'];

/**
 * Who sees this station — said as a consequence rather than as a setting,
 * because the setting is the part people get wrong.
 *
 * Access scope drives VISIBILITY, not merely permission. A station restricted
 * to named staff is absent from everybody else's picker: it does not sit there
 * refusing them, and nobody is left standing at a counter wondering why. The
 * refusal on a direct pick by id still exists behind this, because a list that
 * hides something is not a permission check — but no member of staff should
 * ever meet it.
 */
export function accessSentence(
  station: { accessScope?: StationAccessScope | string; staffCount?: number | null },
  branchLabel: string,
): string {
  if (station.accessScope !== 'selected_staff') {
    return `Open to all staff — it is in the picker of everybody signed in at ${branchLabel}, and they take it by pressing it.`;
  }
  const count = station.staffCount ?? 0;
  if (count === 0) {
    return 'Restricted, with nobody on its list — so nobody can see it. That is what a station being prepared looks like; add somebody and it appears in their picker.';
  }
  return `Restricted to ${count} named ${count === 1 ? 'person' : 'people'}. Everybody else at ${branchLabel} does not see it in their picker at all — not greyed out, simply not there.`;
}
