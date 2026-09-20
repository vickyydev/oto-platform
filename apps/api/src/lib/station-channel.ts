/**
 * Who is currently watching a station (S2-05).
 *
 * A till and a customer display are two devices and the thing between them is
 * the station session document, pushed as a full snapshot over the station
 * channel. That channel is a stream of server-sent events — the argument for
 * that over a WebSocket is in `routes/stations.ts` — and a stream has one
 * property no request-shaped health check can see: it is either attached or it
 * is not, and when it is not, the display in front of a visitor is showing the
 * last thing it was told rather than what is happening. Every request the api
 * answers can still be answered perfectly while that is true. Nothing in
 * `ops_run`, nothing in `audit_log` and nothing in the heartbeat says so.
 *
 * So `/ready` reports it, and this is what it reads: a counter in this process,
 * because a connection is a property of the process holding it and of no other.
 * That also means the number is per-INSTANCE and says so — on a deployment
 * running two api containers, each one reports its own, and the sum is the
 * readiness aggregator's job rather than a lie told by either.
 *
 * `GET /stations/:id/channel` is what opens and closes it, once per screen
 * attached, in the one place a stream can end — see `openChannel` in
 * `routes/stations.ts`. A connection opened and never closed would leave a
 * station reading as busy for the life of the process, which is worse than not
 * reporting at all, so both halves live in that single function rather than
 * being spread across four event handlers.
 */

const perStation = new Map<string, number>();

/** How many stations are reported individually before the list is capped. */
const MAX_LISTED = 50;

export const stationChannels = {
  /** A client attached to a station's channel — a till, a display, an observer. */
  open(stationId: string): void {
    perStation.set(stationId, (perStation.get(stationId) ?? 0) + 1);
  },

  /**
   * One went away. The key is dropped at zero rather than left at 0, so a
   * station nobody has watched today is absent from the report instead of
   * being a row of noise on it.
   */
  close(stationId: string): void {
    const next = (perStation.get(stationId) ?? 0) - 1;
    if (next > 0) perStation.set(stationId, next);
    else perStation.delete(stationId);
  },

  /** Stations with at least one client, and how many each has. */
  counts(): Record<string, number> {
    const entries = [...perStation.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LISTED);
    return Object.fromEntries(entries);
  },

  total(): number {
    let sum = 0;
    for (const n of perStation.values()) sum += n;
    return sum;
  },

  stations(): number {
    return perStation.size;
  },

  /** For a test that must not inherit another test's connections. */
  _reset(): void {
    perStation.clear();
  },
};
