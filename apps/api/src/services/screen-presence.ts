import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alert, branch, deviceCredential, operator, station, type Db } from '@oto/db';
import type { ScreenPresence, TillScreen } from '@oto/shared';
import { AppError } from '../lib/errors';
import { boxSettings, withinOpeningHours } from './box';
import type { FleetCondition, OpeningHoursState } from './ops';
import type { StationRow } from './station-session';

/**
 * SCRUM-771 — THE SCREENS' PRESENCE: a paired customer display, and the till's
 * own screen (the iPad).
 *
 * A box reports itself, its printers, scanner and card terminal every minute,
 * and the watchdog calls it offline after `BOX_OFFLINE_AFTER_S` of silence,
 * raising `box.offline` while the park is open. Neither screen had any of
 * that. This file gives them the same clock and the same threshold:
 *
 *   - A DISPLAY is already heard on every protected call it makes — its poll
 *     every second, or its stream's re-check every five — which stamps
 *     `device_credential.last_seen_at` (`authenticateDisplay`). So nothing new
 *     is sent: its state is derived from that, and the watchdog raises
 *     `display.offline` for a paired display gone quiet while its park is
 *     open, and clears it when the display calls again. Through the same
 *     `raiseAlert` and alert routing the box rules use, so it is muted, routed
 *     and listed exactly as they are.
 *   - A TILL'S SCREEN sends a heartbeat of its own (`POST /me/station/heartbeat`)
 *     every 60 seconds while the till is open, locked or not, which stamps
 *     `station.last_seen_at`. Its existing calls cannot stand in for one: the
 *     link poll runs only on a fleet deployment and the scan poll only where a
 *     stream cannot open, and both stop at the lock screen. The heartbeat also
 *     carries when the screen last heard a scanner, which is the cradle's only
 *     presence. PRESENCE ONLY, no alert: the box rules alert about boxes and
 *     their devices, never about a till station, so a quiet iPad is shown and
 *     not raised.
 */

/** The boxes' threshold, read the way the box rules read it. */
export function screenOfflineAfterS(): number {
  return boxSettings().offlineAfterS;
}

function ageSeconds(at: Date | null | undefined, now: number): number | null {
  return at ? Math.max(0, Math.round((now - at.getTime()) / 1000)) : null;
}

/**
 * Online, or quiet for longer than the threshold. Never heard from at all is
 * offline: a screen that has not called cannot be said to be there.
 */
export function screenPresence(
  lastSeenAt: Date | null | undefined,
  now: number,
  offlineAfterS: number,
): ScreenPresence {
  const age = ageSeconds(lastSeenAt, now);
  return {
    state: age !== null && age <= offlineAfterS ? 'online' : 'offline',
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    lastSeenAgeSeconds: age,
    offlineAfterSeconds: offlineAfterS,
  };
}

/**
 * A paired display's presence, or null where the question has no answer: any
 * other kind of credential, one not paired yet, or one revoked.
 */
export function displayPresence(
  row: { kind: string; pairedAt: Date | null; revokedAt: Date | null; lastSeenAt: Date | null },
  now: number,
  offlineAfterS: number,
): ScreenPresence | null {
  if (row.kind !== 'display' || !row.pairedAt || row.revokedAt) return null;
  return screenPresence(row.lastSeenAt, now, offlineAfterS);
}

/**
 * A till's screen and its scanner, or null for any other kind of station: a
 * gate, a booth and a kiosk are run by their box or their own credential, and
 * no staff screen heartbeats for them.
 */
export function tillScreen(
  row: { kind: string; lastSeenAt: Date | null; lastScanAt: Date | null },
  now: number,
  offlineAfterS: number,
): TillScreen | null {
  if (row.kind !== 'till') return null;
  return {
    ...screenPresence(row.lastSeenAt, now, offlineAfterS),
    scannerLastUsedAt: row.lastScanAt?.toISOString() ?? null,
    scannerLastUsedAgeSeconds: ageSeconds(row.lastScanAt, now),
  };
}

// --- The till's heartbeat -----------------------------------------------------

/**
 * Stamp the station this session is standing at as seen now, and its scanner
 * as last used when the screen says.
 *
 * One statement, outside `updated_at` and outside `withTx`: presence is not a
 * change to the station, so it writes no audit row and moves no version, and a
 * heartbeat every minute from every till would otherwise be a minute-by-minute
 * edit history. The scan time only ever moves forwards (`greatest`), so a
 * second screen at the same station, or a heartbeat that arrives late, cannot
 * set it back; and it is never later than now, whatever the screen sent.
 */
export async function recordTillHeartbeat(
  db: Db,
  row: StationRow,
  input: { lastScanSecondsAgo: number | null },
  now = new Date(),
): Promise<{ stationId: string; lastSeenAt: string; scannerLastUsedAt: string | null }> {
  const scanAt =
    input.lastScanSecondsAgo === null ? null : new Date(now.getTime() - input.lastScanSecondsAgo * 1000);
  const result = await db.execute<{ last_seen_at: Date | string; last_scan_at: Date | string | null }>(sql`
    update ${station}
       set last_seen_at = ${now.toISOString()}::timestamptz,
           last_scan_at = greatest(last_scan_at, ${scanAt?.toISOString() ?? null}::timestamptz)
     where id = ${row.id} and operator_id = ${row.operatorId} and archived_at is null
     returning last_seen_at, last_scan_at`);
  const [written] = result.rows;
  if (!written) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
  const iso = (value: Date | string | null): string | null =>
    value === null ? null : new Date(value).toISOString();
  return { stationId: row.id, lastSeenAt: iso(written.last_seen_at)!, scannerLastUsedAt: iso(written.last_scan_at) };
}

// --- The display rule --------------------------------------------------------

/** One live paired display, with what the rule needs to name it and its park. */
export interface DisplayPresenceRow {
  credentialId: string;
  label: string | null;
  operatorId: string;
  branchId: string;
  branchName: string;
  timezone: string;
  openingHours: unknown;
  stationId: string;
  stationName: string;
  lastSeenAt: Date | null;
}

/** How long, in words somebody reads — the box rules' own wording. */
function elapsedWords(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3_600)} hours`;
}

const DISPLAY_OFFLINE = 'display.offline';

/** How a display is named in an alert: its own name, and the till it shows. */
export function displaySubject(row: { label: string | null; stationName: string }): string {
  return `${row.label ?? 'Customer display'} (customer display at ${row.stationName})`;
}

/**
 * The rule about one paired display, decided — pure, so the page and the
 * watchdog cannot disagree about it.
 *
 * It is the box's offline rule pointed at a screen. Quiet for longer than the
 * boxes' threshold is offline, whatever the hour, and that is what the Devices
 * page shows. Whether it is worth telling anybody is the park's hours: a
 * display switched off with the park shut is not a fault, and raising one at
 * three in the morning is how alerts stop being read. Hours nobody has set
 * raise nothing, as for a box. `warning`, not the box's `critical`: the till
 * still sells, but the customer cannot see the order or answer it.
 */
export function evaluateDisplay(row: DisplayPresenceRow, offlineAfterS: number, now: number): FleetCondition {
  const subject = displaySubject(row);
  const presence = screenPresence(row.lastSeenAt, now, offlineAfterS);
  const silent = presence.state === 'offline';
  const openingHours: OpeningHoursState =
    row.openingHours == null
      ? 'not_set'
      : withinOpeningHours(row.openingHours, row.timezone, new Date(now))
        ? 'open'
        : 'closed';
  const age = presence.lastSeenAgeSeconds;
  return {
    key: `${DISPLAY_OFFLINE}:${row.credentialId}`,
    category: DISPLAY_OFFLINE,
    severity: 'warning',
    subject,
    operatorId: row.operatorId,
    branchId: row.branchId,
    active: silent && openingHours === 'open',
    summary:
      age === null
        ? `${subject} at ${row.branchName} has not called since it was paired, and the park is open`
        : `${subject} at ${row.branchName} has not called for ${elapsedWords(age)} while the park is open — the customer at that till cannot see the order`,
    detail: {
      credentialId: row.credentialId,
      stationId: row.stationId,
      station: row.stationName,
      branch: row.branchName,
      lastSeenAt: presence.lastSeenAt,
      quietSeconds: age,
      offlineAfterSeconds: offlineAfterS,
    },
    clear: !silent
      ? { category: 'display.online', reason: 'recovered', summary: `${subject} at ${row.branchName} is calling again` }
      : openingHours === 'not_set'
        ? {
            category: DISPLAY_OFFLINE,
            reason: 'opening hours are not set',
            summary: `${subject} is silent, and nobody has said when ${row.branchName} is open`,
          }
        : {
            category: DISPLAY_OFFLINE,
            reason: `${row.branchName} is closed`,
            summary: `${subject} is silent, and ${row.branchName} is closed`,
          },
  };
}

/**
 * Every live paired display, evaluated, for the watchdog — and the alerts
 * still open for a display that is no longer one.
 *
 * Live is: a display credential, paired, holding a secret, not revoked, at a
 * station, park and operator none of which is archived. A display revoked, or
 * whose station or park was archived, while its alert stood open is no longer
 * expected to call; nothing here would evaluate it again, so its alert is
 * closed as such rather than left open for ever. Platform-wide, like the box
 * sweep: a condition is true whoever happens to be looking.
 */
export async function displayConditions(
  db: Db,
  now = Date.now(),
): Promise<{ displays: number; conditions: FleetCondition[] }> {
  const offlineAfterS = screenOfflineAfterS();
  const rows: DisplayPresenceRow[] = await db
    .select({
      credentialId: deviceCredential.id,
      label: deviceCredential.label,
      operatorId: station.operatorId,
      branchId: station.branchId,
      branchName: branch.name,
      timezone: branch.timezone,
      openingHours: branch.openingHours,
      stationId: station.id,
      stationName: station.name,
      lastSeenAt: deviceCredential.lastSeenAt,
    })
    .from(deviceCredential)
    .innerJoin(station, and(
      eq(station.id, deviceCredential.stationId),
      eq(station.operatorId, deviceCredential.operatorId),
      eq(station.branchId, deviceCredential.branchId),
    ))
    .innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId)))
    .innerJoin(operator, eq(operator.id, station.operatorId))
    .where(and(
      eq(deviceCredential.kind, 'display'),
      isNull(deviceCredential.revokedAt),
      isNotNull(deviceCredential.pairedAt),
      isNotNull(deviceCredential.secretHash),
      isNull(station.archivedAt),
      isNull(branch.archivedAt),
      isNull(operator.archivedAt),
    ));

  const conditions = rows.map((row) => evaluateDisplay(row, offlineAfterS, now));
  const live = new Set(conditions.map((c) => c.key));
  const standing = await db
    .select({ key: alert.key, subject: alert.subject, operatorId: alert.operatorId, branchId: alert.branchId })
    .from(alert)
    .where(and(eq(alert.category, DISPLAY_OFFLINE), isNull(alert.resolvedAt)));
  for (const open of standing) {
    if (live.has(open.key)) continue;
    conditions.push({
      key: open.key,
      category: DISPLAY_OFFLINE,
      severity: 'warning',
      subject: open.subject,
      operatorId: open.operatorId ?? '',
      branchId: open.branchId ?? '',
      active: false,
      summary: open.subject,
      detail: {},
      clear: {
        category: DISPLAY_OFFLINE,
        reason: 'no longer paired',
        summary: `${open.subject} is no longer paired here, so it is not expected to call`,
      },
    });
  }
  return { displays: rows.length, conditions };
}
