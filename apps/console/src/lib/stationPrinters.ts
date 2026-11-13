import type { DeviceRow, StationRow } from '@/api/fleet';
import { deviceRoleWord } from '@/lib/fleetWords';

/** The same test the agent and the box drawer apply: a kind that ends in `printer`. */
const isPrinter = (kind: string): boolean => kind.endsWith('printer');

/** One printer a station uses, and the job it does there. */
export interface StationPrinter {
  deviceId: string;
  /** The `station_device` role — `receipt`, `kids_band`, `kitchen`. */
  role: string;
  label: string;
}

/**
 * The printers one station can print on, newest read of the box's devices
 * deciding what is still there.
 *
 * WHY THE LIST IS THE STATION'S AND NOT THE BOX'S. A queued test print is
 * routed ON THE BOX by the job a printer does at a station — `routeTo` in
 * `packages/box-agent/src/printing/queue.ts` matches `role` against that
 * station's assignments and never looks at a device id — so a printer this
 * station does not use cannot be asked for: naming it would queue a command
 * whose paper comes out of the station's receipt printer instead, which is
 * exactly the kind of quiet wrong answer this control is being fixed for. The
 * role therefore travels in the payload beside the device id.
 *
 * The device row is looked up rather than trusted from the assignment, because
 * an archived device keeps its assignment until somebody re-points the station
 * and must not be offered as somewhere to print.
 */
export function stationPrinters(station: StationRow | undefined, boxDevices: DeviceRow[]): StationPrinter[] {
  const live = new Map(boxDevices.filter((d) => !d.archived).map((d) => [d.id, d] as const));
  const printers: StationPrinter[] = [];
  for (const assignment of station?.devices ?? []) {
    const device = live.get(assignment.deviceId);
    if (!device || !isPrinter(device.kind)) continue;
    printers.push({ deviceId: device.id, role: assignment.role, label: device.label });
  }
  return printers;
}

/**
 * SCRUM-971 — ONE CHOICE PER JOB, NAMED BY THE JOB.
 *
 * One printer can do several jobs at one station — the band printer prints
 * the kids', the adults' and the drop-off bracelets — and the picker listed it
 * once per job under the same name, and every one of them picked its first
 * job, because a choice was the device id. A choice is now the printer AND
 * its job, and a printer that does more than one job here is named with the
 * job, in the Console's words for the roles ("ZZ TEST 952 band printer ·
 * Kids' band printer"); a printer with one job reads as it did.
 */
export const printerChoiceValue = (printer: StationPrinter): string => `${printer.deviceId}:${printer.role}`;

export function printerChoices(printers: StationPrinter[]): { value: string; label: string }[] {
  const jobs = new Map<string, number>();
  for (const p of printers) jobs.set(p.deviceId, (jobs.get(p.deviceId) ?? 0) + 1);
  return printers.map((p) => ({
    value: printerChoiceValue(p),
    label: (jobs.get(p.deviceId) ?? 0) > 1 ? `${p.label} · ${deviceRoleWord(p.role)}` : p.label,
  }));
}

/**
 * The printer and job a test print goes to: the one chosen, while that
 * printer still does that job here; otherwise the station's receipt printer,
 * because it is the one whose paper path a person is standing in front of —
 * the same choice `ROLE_FOR_KIND.test_page` makes on the box; otherwise the
 * first printer the station has.
 */
export function chosenStationPrinter(printers: StationPrinter[], chosen: string | null): StationPrinter | null {
  return (
    printers.find((p) => printerChoiceValue(p) === chosen) ??
    printers.find((p) => p.role === 'receipt') ??
    printers[0] ??
    null
  );
}
