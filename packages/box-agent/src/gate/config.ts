/**
 * What one gate station is, read from the box's config bundle (S2-12 round 2).
 *
 * A gate station (`station.kind = 'gate'`) carries two kinds of device row:
 *
 *   - the CONTROLLER — `kind: 'gate'`, `transport: 'serial'`, its `address`
 *     the serial path (`/dev/serial/by-id/…`, the form `terminal/serial-channel`
 *     resolves at every open). Its `settings` document holds what the
 *     installer decides at the lane: the machine id (HX-X1 L-30), the baud
 *     (L-31), which side is the way in (OD-A3), what opens the lane (OD-A2),
 *     the relay wiring, and the values the board is expected to hold;
 *   - the READERS — `kind: 'gate_reader'`, `serialNumber` the gate serial the
 *     reader sends in every call (Gate Interface Spec §1-2).
 *
 * Read defensively and never refused whole: a field this box does not know
 * is ignored, a field it cannot read falls back to the documented default and
 * the fallback is reported as a problem. A gate whose config is half-wrong
 * still shows up on Health saying so, rather than not running at all.
 */

import { z } from 'zod';

import type { BoxConfigDevice, BoxConfigStation } from '../protocol';
import {
  GE_X2_BAUD_RATES,
  GE_X2_DEFAULT_BAUD,
  GE_X2_DEFAULT_MACHINE_ID,
  WATCHED_SETTING_KEYS,
  type GateSide,
  type WatchedSetting,
} from './ge-x2';

export const GATE_STATION_KIND = 'gate';
export const GATE_CONTROLLER_KIND = 'gate';
export const GATE_READER_KIND = 'gate_reader';

/** OD-A2 — what closes the lane's open contact. The relay on the box is the default. */
export const GATE_OPENER_MODES = ['box_relay', 'serial', 'reader_relay'] as const;
export type GateOpenerMode = (typeof GATE_OPENER_MODES)[number];

export type GateDirection = 'entry' | 'exit';

/** The relay HAT on the gate box (PROJECT_CONTEXT §7, PC §7.5): one line per side. */
export interface RelayWiring {
  /** `gpiochip0` on a Raspberry Pi. */
  chip: string;
  /** GPIO line offsets wired to L-OP and R-OP. */
  leftLine: number;
  rightLine: number;
  /** Most relay HATs energise on a low line. */
  activeLow: boolean;
  /** The dry contact's length; the supplier said about one second (answer 1). */
  pulseMs: number;
}

export interface GateStationConfig {
  stationId: string;
  stationName: string;
  controller: {
    deviceId: string | null;
    /** The serial path, or null when no controller row exists yet. */
    path: string | null;
    machineId: number;
    baud: number;
  };
  /** OD-A3: the side a guest walking IN goes through. Default left. */
  entrySide: GateSide;
  opener: GateOpenerMode;
  relay: RelayWiring | null;
  /** The board values the station expects, where the installer stated them. */
  expected: Partial<Record<WatchedSetting, number>>;
  /**
   * The reader rows. A lane's two readers share the gate serial and tell
   * themselves apart by `reader` "0" / "1" (Gate Interface Spec §1); a row
   * whose `settings.direction` names one is that reader, a row without covers
   * both.
   */
  readers: Array<{
    deviceId: string;
    serial: string;
    label: string;
    direction: GateDirection | null;
  }>;
  /** What could not be read, in words for Health. Empty when all is well. */
  problems: string[];
}

const RelaySchema = z.object({
  chip: z.string().min(1).max(64).default('gpiochip0'),
  leftLine: z.number().int().min(0).max(1023),
  rightLine: z.number().int().min(0).max(1023),
  activeLow: z.boolean().default(true),
  pulseMs: z.number().int().min(100).max(5000).default(1000),
});

const ExpectedSchema = z
  .object(
    Object.fromEntries(
      WATCHED_SETTING_KEYS.map((k) => [k, z.number().int().min(0).max(999).optional()]),
    ) as Record<WatchedSetting, z.ZodOptional<z.ZodNumber>>,
  )
  .partial();

/** Fields read from the controller row's `settings.gate` (or `settings` itself). */
const ControllerSettingsSchema = z.object({
  machineId: z.number().int().min(1).max(255).optional(),
  baud: z.number().int().optional(),
  entrySide: z.enum(['left', 'right']).optional(),
  opener: z.enum(GATE_OPENER_MODES).optional(),
  relay: RelaySchema.optional(),
  expected: ExpectedSchema.optional(),
});

/** One field at a time, so one bad field does not cost the others. */
function readControllerSettings(
  raw: unknown,
  problems: string[],
): z.infer<typeof ControllerSettingsSchema> {
  const bag =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).gate ?? raw)
      : {};
  if (!bag || typeof bag !== 'object') return {};
  const out: Record<string, unknown> = {};
  const shape = ControllerSettingsSchema.shape;
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    const value = (bag as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = shape[key].safeParse(value);
    if (parsed.success) out[key] = parsed.data;
    else problems.push(`gate setting "${key}" is not usable and was ignored`);
  }
  return out as z.infer<typeof ControllerSettingsSchema>;
}

export function isGateStation(station: Pick<BoxConfigStation, 'kind'>): boolean {
  return station.kind === GATE_STATION_KIND;
}

/** Every gate station in a bundle's station list. */
export function gateStationsOf(
  stations: readonly BoxConfigStation[] | undefined,
): BoxConfigStation[] {
  return (stations ?? []).filter(isGateStation);
}

export function readGateStation(station: BoxConfigStation): GateStationConfig {
  const problems: string[] = [];
  const controllers = station.devices.filter((d) => d.kind === GATE_CONTROLLER_KIND);
  const controller: BoxConfigDevice | undefined = controllers[0];
  if (!controller) problems.push('no gate controller device is assigned to this station');
  if (controllers.length > 1)
    problems.push('more than one gate controller is assigned; the first is used');
  const settings = readControllerSettings(controller?.settings, problems);

  let baud = settings.baud ?? GE_X2_DEFAULT_BAUD;
  if (!(GE_X2_BAUD_RATES as readonly number[]).includes(baud)) {
    problems.push(`baud ${baud} is not one HX-X1 L-31 offers; ${GE_X2_DEFAULT_BAUD} is used`);
    baud = GE_X2_DEFAULT_BAUD;
  }
  const opener = settings.opener ?? 'box_relay';
  if (opener === 'box_relay' && !settings.relay) {
    problems.push('the opener is the box relay but no relay wiring is configured');
  }
  const path = controller?.address?.trim() || null;
  if (controller && !path) problems.push('the gate controller has no serial path');

  const readers: GateStationConfig['readers'] = [];
  for (const d of station.devices) {
    if (d.kind !== GATE_READER_KIND) continue;
    const serial = d.serialNumber?.trim();
    if (!serial) {
      problems.push(
        `reader "${d.label}" has no gate serial number, so its calls cannot be matched`,
      );
      continue;
    }
    const s = d.settings as
      { direction?: unknown; gate?: { direction?: unknown } } | null | undefined;
    const raw = s?.gate?.direction ?? s?.direction;
    const direction = raw === 'entry' || raw === 'exit' ? raw : null;
    readers.push({ deviceId: d.id, serial, label: d.label, direction });
  }

  return {
    stationId: station.id,
    stationName: station.name,
    controller: {
      deviceId: controller?.id ?? null,
      path,
      machineId: settings.machineId ?? GE_X2_DEFAULT_MACHINE_ID,
      baud,
    },
    entrySide: settings.entrySide ?? 'left',
    opener,
    relay: settings.relay ?? null,
    expected: settings.expected ?? {},
    readers,
    problems,
  };
}

/** Which side of the lane a direction uses, given the station's entry side (OD-A3). */
export function sideFor(direction: GateDirection, entrySide: GateSide): GateSide {
  if (direction === 'entry') return entrySide;
  return entrySide === 'left' ? 'right' : 'left';
}

/** The inverse: which direction a feedback on a side stands for. */
export function directionFor(side: GateSide, entrySide: GateSide): GateDirection {
  return side === entrySide ? 'entry' : 'exit';
}
