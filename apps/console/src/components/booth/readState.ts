/**
 * What a reading on the Booths page is actually worth.
 *
 * This is `src/lib/deviceList.ts` generalised, for the same reason it exists
 * there: handed on as a bare value, a booth whose answer has not come back and
 * a booth whose answer failed both arrive as "nothing", which is the same value
 * a booth with no prizes produces. The panel then says "this wheel has no
 * prizes on it" — a claim about a machine in a shopping centre, made on the
 * strength of a request that never answered — and somebody drives to a mall to
 * look at a booth that is fine.
 *
 * So the difference travels with the value, and every panel on this page reads
 * `state` before it says anything. The four states and the transitions are
 * deliberately the same words `deviceList.ts` uses, because a reader who has
 * learned them on Devices should not have to learn them again here.
 *
 * It is generic where `deviceList.ts` is specific because this page holds four
 * separate readings for one booth — its draft configuration, its live status,
 * its version history, and the operator's layouts — each arriving on its own
 * request and each able to fail on its own.
 */
export interface Read<T> {
  /** The last value read. `fallback` until a read succeeds. */
  value: T;
  /**
   * What `value` above is:
   * - `unread` — nothing has come back yet; it is the fallback and means nothing
   * - `read` — what the API reported, as of `readAt`
   * - `stale` — an earlier read's answer; the most recent read failed
   * - `failed` — the read failed and no earlier read succeeded
   * - `absent` — the API answered 404: this deployment has no such route yet,
   *   which is neither a failure nor an empty list and must not be drawn as
   *   either (`RouteUnavailable`)
   */
  state: 'unread' | 'read' | 'stale' | 'failed' | 'absent';
  /** A read is in flight. True on the first read and on every refresh. */
  refreshing: boolean;
  /** Why the last read failed. Null unless `state` is `stale` or `failed`. */
  error: string | null;
  /** When `value` was read. Null unless `state` is `read` or `stale`. */
  readAt: number | null;
}

export function unread<T>(fallback: T): Read<T> {
  return { value: fallback, state: 'unread', refreshing: false, error: null, readAt: null };
}

/** A read has been sent. Whatever was already held stays held and stays true. */
export function reading<T>(held: Read<T>): Read<T> {
  return { ...held, refreshing: true };
}

export function readOk<T>(value: T): Read<T> {
  return { value, state: 'read', refreshing: false, error: null, readAt: Date.now() };
}

/**
 * A read failed.
 *
 * What was held is kept and marked stale, because an older true value beats a
 * confidently empty one — and `readAt` still says when it was true, so the
 * panel showing it can say so too. A reading nobody has taken has nothing to
 * keep and says that instead.
 */
export function readFailed<T>(held: Read<T>, error: string, fallback: T): Read<T> {
  return held.state === 'read' || held.state === 'stale'
    ? { ...held, state: 'stale', refreshing: false, error }
    : { value: fallback, state: 'failed', refreshing: false, error, readAt: null };
}

/**
 * The route is not on this deployment (404).
 *
 * Separate from `readFailed` because the two produce different screens: a
 * failure is "try again", an absent route is "the API half of this ticket has
 * not shipped here". Anything held from an earlier read is dropped — a route
 * that has gone away is not evidence for what it last said.
 */
export function readAbsent<T>(fallback: T): Read<T> {
  return { value: fallback, state: 'absent', refreshing: false, error: null, readAt: null };
}

/** The words for a failed read, from whatever the fetch threw. */
export function readFailureMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : 'The request failed.';
}
