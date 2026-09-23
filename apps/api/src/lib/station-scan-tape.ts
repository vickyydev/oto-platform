import type { StationScanMessage } from '@oto/box-agent';

/**
 * The last scans each station heard, numbered, for a screen that cannot hold
 * the station channel open (SCRUM-392).
 *
 * A scan reaches a screen live, as an `event: scan` on
 * `GET /stations/:id/channel`, and is then gone: the session manager fans it
 * out to whoever is attached and keeps nothing (`emitScan` in
 * packages/box-agent/src/station-session.ts). For a stream that is right — a
 * scan a screen missed is a moment it missed, not a state it has fallen behind
 * on. It is no use to a screen that cannot keep a stream open at all, and on
 * staging the shop screen cannot: the POS is a static site, and its `/api/*`
 * rewrite on Render never passes a streaming answer through — no status, no
 * headers, no bytes for minutes, while the same URL on the api's own origin
 * answers at once. So that screen polls `GET /stations/:id/scans`, and this is
 * what the poll reads: every scan published to a station in this process from
 * the first channel or poll on it (the in-process box's tap goes in on that
 * first contact — `services/station-scans.ts`) — whether or not anybody was
 * attached when it was — each with a running number, the last hundred kept.
 *
 * **Per process, like the channel.** A scan is published in the process that
 * holds the box's session manager and lands on THIS process's tape, exactly as
 * the channel's subscribers are this process's and no other's
 * (`lib/station-channel.ts`, `services/station-session.ts`). There is one api
 * instance today, so there is one tape. A second instance needs the same
 * shared bus the channel will need; until then a poll answered by the other
 * instance reads a tape that never heard the scan.
 *
 * **The numbers.** Per station, up by one per scan, from a starting point
 * taken from the clock when this process started (`START`) rather than from
 * zero — see there for why.
 */

/** How many scans a station's tape keeps, and so the most one poll is sent. */
export const STATION_SCAN_TAPE_SIZE = 100;

/**
 * Where this process's numbers start: the clock, in milliseconds, when the
 * process started.
 *
 * A screen keeps its cursor across an api restart, and a deploy is a restart.
 * Were every process to count from zero, the first scans after one would be
 * numbered at or below the cursor the screen already holds and would be passed
 * over as seen. Counting from the start time puts every number this process
 * hands out above every number an earlier one did — the earlier process would
 * have had to take more than one scan per millisecond of its life to catch up.
 */
const START = Date.now();

interface Tape {
  /** The number of the newest scan; `START` until the station has one. */
  last: number;
  /** Oldest first, never more than `STATION_SCAN_TAPE_SIZE`. */
  entries: Array<{ n: number; scan: StationScanMessage }>;
}

const perStation = new Map<string, Tape>();

/** What a poll is answered with — the route's response, before the view is applied. */
export interface StationScanPage {
  /** What to send as `after` on the next call. */
  next: number;
  /** The scans numbered after `after`, oldest first. */
  scans: StationScanMessage[];
}

export const stationScanTape = {
  /** One scan, as it was published to the station's screens. Returns its number. */
  record(stationId: string, scan: StationScanMessage): number {
    let tape = perStation.get(stationId);
    if (!tape) {
      tape = { last: START, entries: [] };
      perStation.set(stationId, tape);
    }
    tape.last += 1;
    tape.entries.push({ n: tape.last, scan });
    if (tape.entries.length > STATION_SCAN_TAPE_SIZE) {
      tape.entries.splice(0, tape.entries.length - STATION_SCAN_TAPE_SIZE);
    }
    return tape.last;
  },

  /**
   * The scans numbered after `after`, and the number to ask from next time.
   *
   * With no `after` there is nothing to answer but the number: a screen that
   * has just opened takes it and is sent nothing, because scans are live and
   * a scan from before the screen was there must not land on its cart — the
   * stream replays nothing either; the snapshot is the document, and a scan is
   * not part of it.
   *
   * A cursor AHEAD of the tape is one this tape never issued — a clock that
   * went backwards across a restart, or a caller's own mistake — and it is
   * answered the same way, with the number and no scans, rather than with
   * everything on the tape: a line added twice is a customer charged twice,
   * where a scan missed is one the person at the counter scans again.
   */
  read(stationId: string, after?: number): StationScanPage {
    const tape = perStation.get(stationId);
    const last = tape?.last ?? START;
    if (!tape || after === undefined || after > last) return { next: last, scans: [] };
    return {
      next: last,
      scans: tape.entries.filter((entry) => entry.n > after).map((entry) => entry.scan),
    };
  },

  /** For a test that must not inherit another test's scans. */
  _reset(): void {
    perStation.clear();
  },
};
