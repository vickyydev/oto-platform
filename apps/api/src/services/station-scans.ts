import type { StationChannelMessage, StationSessionManager, StationView } from '@oto/box-agent';
import type { Db } from '@oto/db';
import { inProcessBox } from './box';
import { registerProductBarcodeHandler } from './scanning-product';

/**
 * The scans a box running IN THIS PROCESS reads, onto a screen attached here
 * (S2-09b).
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
 * This joins the two for scans and nothing else. Snapshots and leases still
 * come from the manager the screen attached to, which is the one the intents
 * are applied through; a scan is not part of the document and carries no
 * sequence, so hearing it from a second manager cannot put a screen out of
 * step. It is delivered once: a scan published on the agent's manager never
 * reaches the api's, and one published on the api's (the scan route when this
 * process does not run the box) never reaches the agent's.
 *
 * A box on a Raspberry Pi is not reached by this — its scanner publishes inside
 * the Pi, and nothing yet carries a scan from a Pi to the cloud's screens.
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
  if (!input.boxId) return null;
  const agent = inProcessBox(input.boxId);
  const sessions = agent?.sessions() ?? null;
  if (!agent || !sessions || sessions === input.attachedTo) return null;
  // The catalogue's barcode handler on the box's own scanner, so what the
  // screen is about to hear resolves products. Idempotent, and `startVirtualBox`
  // has normally done it already; a box whose scanner only came up after that
  // (a registration that had to wait) gets it here.
  const scanner = agent.scanner();
  if (scanner) registerProductBarcodeHandler(scanner, db);
  return sessions.subscribe(input.stationId, input.view, (message) => {
    if (message.kind === 'scan') input.send(message);
  });
}
