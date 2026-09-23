import type { DeviceRow } from '@/api/fleet';

/**
 * One box's device list, and what that list is actually worth.
 *
 * Devices are asked for per box, so each box's answer arrives — or fails — on
 * its own. Handed on as a bare array, a box whose answer has not come back and
 * a box whose answer failed both arrive as `[]`, which is the same value a box
 * with nothing plugged into it produces. The panels then say "No simulated
 * printer on this box", which is a claim about the park's equipment made on
 * the strength of a request that never answered, and somebody walks to a
 * counter to look at a box that is fine.
 *
 * So the difference travels with the list, and the five places that state
 * something about a box's equipment from it — the device list, the Simulator
 * panel, the Printing panel, step 1 of the station wizard, where a person
 * is about to assign work to equipment they are being shown, and the Test
 * print printer picker in the box drawer's Controls (SCRUM-358) — read
 * `state` before they say it.
 *
 * If a sixth surface is added, it belongs on this list. An enumeration that
 * has fallen behind the code is how a guarantee stops being one.
 */
export interface BoxDeviceList {
  /** The devices last read for this box. Empty until a read succeeds. */
  devices: DeviceRow[];
  /**
   * What `devices` above is:
   * - `unread` — nothing has come back for this box yet; it is empty and means nothing
   * - `read` — what the box reported, as of `readAt`
   * - `stale` — an earlier read's answer; the most recent read failed
   * - `failed` — the read failed and no earlier read succeeded, so there is nothing to show
   */
  state: 'unread' | 'read' | 'stale' | 'failed';
  /** A read is in flight. True on the first read and on every refresh. */
  refreshing: boolean;
  /** Why the last read failed. Null unless `state` is `stale` or `failed`. */
  error: string | null;
  /** When `devices` was read. Null unless `state` is `read` or `stale`. */
  readAt: number | null;
}

/** A box nobody has asked about yet. */
export const UNREAD_DEVICES: BoxDeviceList = {
  devices: [],
  state: 'unread',
  refreshing: false,
  error: null,
  readAt: null,
};

/** A read has been sent. Whatever was already held stays held and stays true. */
export function readingDevices(held: BoxDeviceList | undefined): BoxDeviceList {
  return { ...(held ?? UNREAD_DEVICES), refreshing: true };
}

/** A read came back. */
export function devicesRead(devices: DeviceRow[]): BoxDeviceList {
  return { devices, state: 'read', refreshing: false, error: null, readAt: Date.now() };
}

/**
 * A read failed.
 *
 * What was held is kept and marked stale, because an older true list beats a
 * confidently empty one — and `readAt` still says when it was true, so the
 * panel showing it can say so too. A box that has never been read has nothing
 * to keep, and says that instead of showing an empty list.
 */
export function devicesFailed(held: BoxDeviceList | undefined, error: string): BoxDeviceList {
  const previous = held ?? UNREAD_DEVICES;
  return previous.state === 'read' || previous.state === 'stale'
    ? { ...previous, state: 'stale', refreshing: false, error }
    : { devices: [], state: 'failed', refreshing: false, error, readAt: null };
}

/** The words for a failed read, from whatever the fetch threw. */
export function readFailureMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : 'The request failed.';
}
