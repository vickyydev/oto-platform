import { ApiError } from '@/api/client';
import type { StationRow } from '@/api/fleet';

/**
 * SCRUM-898 — A STATION FORM NEVER OPENS ON SETTINGS OLDER THAN THE LAST SAVE.
 *
 * Seen on staging: a till saved in Devices > Stations and reopened before the
 * list's re-read came back showed config v1, its drop-off band printer "Not
 * set", while the card behind it said v2 — and saving that form would have
 * written v1 back. Three rules close it, each pure so it can be pinned:
 *
 *   - the saved answer goes into the list at once (`withSavedStation`), so
 *     the card a person presses next is the station as it now stands;
 *   - a read of the list never puts a row back to an older config version
 *     (`newerStations`), whatever order the answers arrive in;
 *   - an open form takes a newer reading of its station only while nobody
 *     has touched it (`refillsFrom`). A touched form keeps what was typed,
 *     says which version it was filled from on save, and the api refuses it
 *     409 `STATION_CHANGED` when that is not the version the station holds
 *     (`stationSaveRefusal` words that refusal).
 */

/** The configuration version a row carries, or null from an api older than the field. */
const versionOf = (row: StationRow | null | undefined): number | null =>
  typeof row?.configVersion === 'number' ? row.configVersion : null;

/**
 * The list with a saved station in it: in place of the row it replaces, or
 * added when it is new. An archived one leaves the list at once, as the
 * re-read that follows leaves it out (the list is read without archived
 * stations).
 *
 * A save's answer carries no till screen (the api fills `screen` on reads
 * only), so the screen the list last read is kept until the next read brings
 * one; everything else is the answer's.
 */
export function withSavedStation(stations: readonly StationRow[], saved: StationRow): StationRow[] {
  if (saved.archived) return stations.filter((row) => row.id !== saved.id);
  const at = stations.findIndex((row) => row.id === saved.id);
  if (at < 0) return [...stations, saved];
  const held = stations[at]!;
  const next = [...stations];
  next[at] = { ...held, ...saved, screen: saved.screen ?? held.screen ?? null };
  return next;
}

/**
 * A read of the list, laid over the rows already held: the read decides which
 * stations there are, and a row it carries at an OLDER config version than the
 * one held — a read that left before a save and landed after it — keeps the
 * held row. Version numbers only ever go up, so an older one is never news.
 */
export function newerStations(held: readonly StationRow[], read: readonly StationRow[]): StationRow[] {
  const byId = new Map(held.map((row) => [row.id, row]));
  return read.map((row) => {
    const mine = byId.get(row.id);
    const had = versionOf(mine);
    const got = versionOf(row);
    return mine && had !== null && got !== null && got < had ? mine : row;
  });
}

/**
 * Whether an open form refills from `incoming`, the station as the list now
 * holds it. Only an untouched form does — what somebody has typed is never
 * replaced under them — and only from the same station at the same or a
 * newer version, never from an older one.
 */
export function refillsFrom(
  filled: StationRow | null,
  incoming: StationRow | null,
  edited: boolean,
): boolean {
  if (edited || !filled || !incoming || incoming === filled) return false;
  if (incoming.id !== filled.id) return false;
  const had = versionOf(filled);
  const got = versionOf(incoming);
  return had === null || got === null || got >= had;
}

/** The version a save says its form was filled from; none when the row never carried one. */
export function expectedVersion(filled: StationRow | null): number | null {
  const version = versionOf(filled);
  return version !== null && Number.isInteger(version) && version >= 1 ? version : null;
}

/**
 * SCRUM-952 — the platform's sentence for a save from an older version, word
 * for word as the api refuses it (`STATION_CHANGED` in
 * `apps/api/src/services/fleet.ts`) and as the till shows it. The drawer
 * said "This till was changed…", named after the station's kind, while the
 * till and the platform said "This station was changed…": one refusal, two
 * wordings. The next step is the same on every side: close it and open it again.
 */
export const STATION_CHANGED_WORDS = 'This station was changed since you opened it. Close it and open it again.';

/**
 * What the drawer says when the api refuses a save from an older version.
 * The same sentence whatever kind of station it is (SCRUM-952); the kind is
 * still taken so every caller reads as before.
 */
export function stationChangedWords(_kind?: string): string {
  return STATION_CHANGED_WORDS;
}

/** Whether a failed save was refused as made from an older version. */
export const isStationChanged = (err: unknown): boolean =>
  err instanceof ApiError && err.code === 'STATION_CHANGED';

/** The sentence a failed save leaves at the top of the drawer. */
export function stationSaveRefusal(err: unknown, kind: string, fallback: string): string {
  if (isStationChanged(err)) return stationChangedWords(kind);
  return err instanceof Error ? err.message : fallback;
}
