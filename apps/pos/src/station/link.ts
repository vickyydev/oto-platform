/**
 * Whether this till is working with the internet or without it, and what the
 * difference costs the person standing at it.
 *
 * WHY A FILE OF ITS OWN rather than more of api/platform.ts: the shapes here
 * are the S2-05 CONTRACT, being built beside this screen, and keeping them
 * together means retargeting them is one edit. Same two rules the console's
 * pages are written to: a 404 means "this deployment does not have that route
 * yet", and every field the API has not grown is optional, so the till behaves
 * correctly today and the banner fills in as the routes land.
 *
 * WHY `/me/station/link` AND NOT `/boxes/:id/…`. The box routes take an
 * administrator's permission, and the person who needs this most is the one on
 * reception who has none. It is scoped to the session's own station, so it can
 * answer without a permission check and cannot say anything about a station
 * this till is not working. It is also the shape the BOX itself can answer
 * from its own store the day the till talks to the box rather than to the
 * cloud (S2-06) — the same call, a shorter wire.
 */
import { api } from '@/api/client';
import type { BoxStatus } from '@/api/platform';

/**
 * What the platform says about this station's box and its link.
 *
 * `offline` and `boxStatus` are two different facts and the banner treats them
 * that way. `offline` is `edge.box_state.offline`: somebody pressed "Go
 * offline" in the Console, or the box cut its own cloud client — a deliberate
 * state the cloud knows the reason for. `boxStatus` is the watchdog's verdict
 * from the heartbeat age, which is never the box's own claim: a box that has
 * crashed cannot tell anybody it is down, and that silence is the signal.
 */
export interface StationLink {
  stationId: string;
  boxId: string | null;
  boxName?: string | null;
  boxStatus?: BoxStatus | string | null;
  /** The box is working without the cloud, on purpose or because it lost it. */
  offline: boolean;
  offlineSince?: string | null;
  offlineReason?: string | null;
  /** Events queued on the box that the cloud has not accepted yet. */
  outboxDepth?: number | null;
  oldestUnackedSeconds?: number | null;
  lastSyncAt?: string | null;
  /**
   * The cloud's own verdict on whether the box has fallen behind, from
   * `SYNC_STALE_AFTER_S`. Preferred over anything worked out here — the
   * threshold is the watchdog's and the two must not disagree.
   */
  syncStale?: boolean;
  /**
   * When the box last applied a cache bundle. This is the age of the member
   * list, the prices and today's bookings while it is working alone, which is
   * the one number that decides whether a lookup can be trusted.
   */
  cacheAppliedAt?: string | null;
  cacheAgeSeconds?: number | null;
  journalEpoch?: number | null;
}

export const stationLinkApi = {
  read: () => api.get<StationLink>('/me/station/link'),
};

/**
 * How far behind the box may be before the till says so, when the cloud has
 * not sent its own verdict. Two minutes: long enough that an ordinary busy
 * minute at the counter does not put a banner on the screen, short enough that
 * a link which has actually stopped is visible before the queue notices.
 */
export const SYNC_BEHIND_AFTER_S = 120;

/**
 * The five things the till can be, worst first.
 *
 * `fine` and `unknown` both draw nothing, and they are kept apart on purpose:
 * one means the platform answered and there is nothing to say, the other means
 * nobody has answered yet. A banner that appears for half a second on every
 * page load would teach people to ignore it.
 */
export type LinkState = 'till_cut_off' | 'box_silent' | 'box_alone' | 'catching_up' | 'fine' | 'unknown';

export function linkState(input: {
  link: StationLink | null;
  /** False once this till's own calls have stopped being answered at all. */
  reachable: boolean;
}): LinkState {
  if (!input.reachable) return 'till_cut_off';
  const link = input.link;
  if (!link) return 'unknown';
  // Deliberate first. When a box is taken offline its heartbeats stop too, so
  // both facts are true at once — and "working from the box alone" is the one
  // that is useful to read, where "the box is not answering" would send
  // somebody to look at a machine that is doing exactly what it was told.
  if (link.offline) return 'box_alone';
  if (link.boxStatus === 'offline' || link.boxStatus === 'disabled') return 'box_silent';
  const queued = link.outboxDepth ?? 0;
  if (queued > 0) {
    const behind =
      link.syncStale ?? (link.oldestUnackedSeconds ?? 0) > SYNC_BEHIND_AFTER_S;
    if (behind) return 'catching_up';
  }
  return 'fine';
}
