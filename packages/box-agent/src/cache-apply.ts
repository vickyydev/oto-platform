/**
 * Which scopes of a cache pull may land on this box, and in which order
 * (S2-06).
 *
 * Its own module, away from `agent.ts`, for a reason that is not tidiness:
 * this package's tests run on Node's own runner with type stripping, which
 * cannot load `agent.ts` at all — it reaches the printing code, and a
 * TypeScript parameter property is not strippable. A security rule that can
 * only be exercised through a cloud, a store and a transport is a rule with no
 * cheap test, and this one deserves one.
 */

/** Why a scope in a cache pull did not end up on the box. */
export type CacheFaultReason =
  /** The cloud cut the scope off at the limit; a half list is not applied. */
  | 'truncated'
  /** The staff list arrived without the deny-list that governs it. */
  | 'missing_deny_list'
  /** The store refused the write. */
  | 'write_failed'
  /** The bundle could not be read at all. */
  | 'unreadable';

export interface CacheApplyPlan {
  /** The scopes to write, in the order they must be written. */
  apply: string[];
  skipped: Array<{ scope: string; reason: CacheFaultReason }>;
}

/**
 * **A box may never hold a staff list without the deny-list that governs it.**
 *
 * Offline unlock reads both — the staff list says who may work at the counter,
 * the deny-list says whose access has since been withdrawn — and a box holding
 * only the first admitted a dismissed employee's shift token for as long as it
 * lived, with nothing anywhere saying the check had been skipped.
 *
 * Two rules, and both fail towards "keep the last complete copy":
 *
 *  - a truncated scope is not applied, because half a list quietly refuses the
 *    people who fell off the end of it;
 *  - `staff` is not applied unless `deny_list` is being applied in the same
 *    pull, and the deny-list is written FIRST — so a write that fails part way
 *    through leaves a box whose revocations are at least as fresh as its staff
 *    list, never the other way round.
 */
export function planCacheApply(
  present: readonly string[],
  truncated: readonly string[],
): CacheApplyPlan {
  const cut = new Set(truncated);
  const skipped: CacheApplyPlan['skipped'] = [];
  const usable: string[] = [];
  for (const scope of present) {
    if (cut.has(scope)) skipped.push({ scope, reason: 'truncated' });
    else usable.push(scope);
  }
  const hasDeny = usable.includes('deny_list');
  const apply: string[] = [];
  // The deny-list first, then everything else in the order the cloud sent it.
  if (hasDeny) apply.push('deny_list');
  for (const scope of usable) {
    if (scope === 'deny_list') continue;
    if (scope === 'staff' && !hasDeny) {
      skipped.push({ scope, reason: 'missing_deny_list' });
      continue;
    }
    apply.push(scope);
  }
  return { apply, skipped };
}
