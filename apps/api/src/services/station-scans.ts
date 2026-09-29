import {
  redactScanForCustomer,
  type StationChannelMessage,
  type StationScanMessage,
  type StationSessionManager,
  type StationView,
} from '@oto/box-agent';
import type { Db } from '@oto/db';
import { stationScanTape, type StationScanPage } from '../lib/station-scan-tape';
import { inProcessBox } from './box';
import { registerProductBarcodeHandler } from './scanning-product';

/**
 * The scans a station hears, onto the screens watching it (S2-09b), and onto
 * the station's scan tape for the screens that poll instead (SCRUM-392).
 *
 * A screen watches a station through `GET /stations/:id/channel`, which
 * subscribes it to the session manager `services/station-session.ts` keeps for
 * that box. A box that this process also RUNS — the virtual box, under
 * `PROCESS_ROLES=edge` — has a manager of its own inside the agent, and its
 * scanner publishes there: the scanner on the box, and the Console's scanner
 * simulator, which reaches the box as a command and is read through the same
 * scanner. Two managers over the same rows, with two sets of subscribers, so a
 * scan the box read never reached a screen attached through the api.
 *
 * The relay below joins the two for scans and nothing else. Snapshots and
 * leases still come from the manager the screen attached to, which is the one
 * the intents are applied through; a scan is not part of the document and
 * carries no sequence, so hearing it from a second manager cannot put a screen
 * out of step. It is delivered once: a scan published on the agent's manager
 * never reaches the api's, and one published on the api's (the scan route when
 * this process does not run the box) never reaches the agent's.
 *
 * **The tape.** A screen that cannot hold the channel open — the shop screen
 * behind the static site's `/api/*` rewrite on staging, which never passes a
 * stream through — polls `GET /stations/:id/scans` instead, and reads
 * `lib/station-scan-tape.ts`. A poll is never attached, so the tape is fed
 * where scans are PUBLISHED rather than where they are delivered: every scan
 * either manager would send a subscriber goes onto it whether or not anybody
 * is subscribed — from the first channel or poll on one of the box's stations
 * in this process, which is when the in-process tap goes in (`joinInProcessBox`,
 * below). The two sources are the two places a scan is published in
 * this process — the in-process box's own manager (`tapeScansOf`, below) and
 * the api's scan route when this process does not run the box
 * (`publishStationScan`, called from `routes/scanning.ts`).
 *
 * A box on a Raspberry Pi is not reached by any of this — its scanner
 * publishes inside the Pi, and nothing yet carries a scan from a Pi to the
 * cloud's screens or to its tape.
 */

/** Managers whose `emitScan` already puts every scan on the tape. */
const taped = new WeakSet<StationSessionManager>();

/**
 * Every scan the in-process box publishes, onto its station's tape.
 *
 * The box's scanner publishes through `sessions.emitScan` (`agent.ts`), and a
 * manager fans a scan out to its subscribers and keeps nothing — so a scan the
 * box read while no screen was attached here was gone, and a screen that polls
 * is never attached. A subscription cannot hear every scan either: it hears
 * one station, and it would be a subscriber that is not a screen, counted as
 * one by the manager for the life of the process. So the manager's own
 * `emitScan` is wrapped, once per manager: the tape takes the scan, then the
 * manager fans it out exactly as before. Nothing else about the manager
 * changes.
 */
function tapeScansOf(sessions: StationSessionManager): void {
  if (taped.has(sessions)) return;
  taped.add(sessions);
  const emit = sessions.emitScan.bind(sessions);
  sessions.emitScan = (stationId: string, scan: StationScanMessage): void => {
    stationScanTape.record(stationId, scan);
    emit(stationId, scan);
  };
}

/**
 * The in-process box's own manager, ready to be heard through the api — or
 * null when there is nothing to join: the box is not running in this process
 * (or has not registered yet), or its manager is the one the api already
 * holds.
 *
 * Ready means two things, and both doors a screen watches a station through —
 * the channel and the poll — come through here, so both hold before a screen
 * takes its first cursor:
 *
 *   - the catalogue's barcode handler is on the box's scanner, so what the
 *     screen is about to hear resolves products. Idempotent, and
 *     `startVirtualBox` has normally done it already; a box whose scanner only
 *     came up after that (a registration that had to wait) gets it here;
 *   - every scan the box publishes from now on goes onto the tape. A scan the
 *     box read before any screen asked about it in this process is not there,
 *     and is not owed to anybody: a screen that opens takes the tape's number
 *     and replays nothing.
 */
function joinInProcessBox(
  db: Db,
  boxId: string | null,
  attachedTo: StationSessionManager,
): StationSessionManager | null {
  if (!boxId) return null;
  const agent = inProcessBox(boxId);
  const sessions = agent?.sessions() ?? null;
  if (!agent || !sessions || sessions === attachedTo) return null;
  const scanner = agent.scanner();
  if (scanner) registerProductBarcodeHandler(scanner, db);
  tapeScansOf(sessions);
  return sessions;
}

/**
 * The scans a box running IN THIS PROCESS reads, onto a screen attached here
 * through the channel.
 *
 * Returns the unsubscribe, or null when there is nothing to join.
 */
export function relayInProcessBoxScans(
  db: Db,
  input: {
    boxId: string | null;
    stationId: string;
    view: StationView;
    /** The manager the screen is already attached to, so it is never joined twice. */
    attachedTo: StationSessionManager;
    send: (message: StationChannelMessage) => void;
  },
): (() => void) | null {
  const sessions = joinInProcessBox(db, input.boxId, input.attachedTo);
  if (!sessions) return null;
  return sessions.subscribe(input.stationId, input.view, (message) => {
    if (message.kind === 'scan') input.send(message);
  });
}

/**
 * A scan published through the api's own scanning door, onto the api's manager
 * for the station's box: onto the tape first, then out to the screens attached
 * here exactly as before.
 *
 * `routes/scanning.ts` publishes here from the router it builds when this
 * process does not run the box — the path every scan at a station whose box is
 * elsewhere takes into the session manager — and this is the only place the
 * api publishes a scan to that manager, so it is the one place a screen that
 * polls needs it written down.
 */
export function publishStationScan(
  manager: StationSessionManager,
  stationId: string,
  scan: StationScanMessage,
): void {
  stationScanTape.record(stationId, scan);
  manager.emitScan(stationId, scan);
}

/**
 * What a poll of `GET /stations/:id/scans` is answered with.
 *
 * The in-process box is joined first, for the same two reasons the channel
 * joins it (`joinInProcessBox`); then the tape is read, and every scan on it is
 * given the view the caller asked for.
 */
export function readStationScans(
  db: Db,
  input: {
    boxId: string | null;
    stationId: string;
    view: StationView;
    after?: number;
    /** The api's manager for the station's box, so the box is never joined twice. */
    attachedTo: StationSessionManager;
  },
): StationScanPage {
  joinInProcessBox(db, input.boxId, input.attachedTo);
  const page = stationScanTape.read(input.stationId, input.after);
  return { next: page.next, scans: page.scans.map((scan) => scanForView(scan, input.view)) };
}

/**
 * A scan from the tape, as the channel would have sent it to a screen with this
 * view.
 *
 * The channel's rule is `emitScan`'s: the customer display gets `detail` — the
 * handler's own answer, and the one part of a scan that can name a person —
 * through the box's key-stripping, and everything else as it is; a staff screen
 * gets the scan untouched. Both paths use the package's scan redaction helper;
 * a scan detail is not a cart presentation and must not be validated as one.
 */
function scanForView(scan: StationScanMessage, view: StationView): StationScanMessage {
  if (view !== 'customer') return scan;
  return redactScanForCustomer(scan);
}
