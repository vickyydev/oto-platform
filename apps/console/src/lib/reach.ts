/**
 * How far an answer from the operations API reached (SCRUM-299).
 *
 * Every list under `/ops` is narrowed to the branches the caller holds
 * `admin:health:read` at, and until now none of them said so — which made "my
 * park has nothing wrong" and "this page is not showing me my park" the same
 * empty screen. The API now says which parks an answer covered, and this is
 * how the pages read it.
 *
 * Read defensively rather than declared on the API client's types, because the
 * Console is deployed beside the API and not with it: for the minutes the two
 * are a deploy apart, an answer arrives without the field. Absent means "not
 * known here", which is deliberately NOT the same as "no parks" — it draws no
 * line and hides nothing.
 */
export interface Reach {
  scope: 'operator' | 'branch';
  /** Empty for an operator-wide reach: it is every park, including the ones
   *  that open later, which no list of names can say. */
  branches: Array<{ id: string; name: string }>;
}

/** The reach carried on an `/ops` answer, or null when it carries none. */
export function readReach(value: unknown): Reach | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { reach?: unknown }).reach;
  if (!raw || typeof raw !== 'object') return null;
  const { scope, branches } = raw as { scope?: unknown; branches?: unknown };
  if (scope !== 'operator' && scope !== 'branch') return null;
  const named = Array.isArray(branches)
    ? branches.flatMap((entry) => {
        const row = entry as { id?: unknown; name?: unknown };
        return typeof row?.id === 'string' && typeof row?.name === 'string'
          ? [{ id: row.id, name: row.name }]
          : [];
      })
    : [];
  return { scope, branches: named };
}

/**
 * Is this the whole estate's answer?
 *
 * An unknown reach counts as the whole estate, which is the older API's own
 * behaviour: a page that blanked itself on a deploy skew would be a worse
 * failure than the one this fixes.
 */
export function isEstateWide(reach: Reach | null): boolean {
  return reach === null || reach.scope === 'operator';
}

/**
 * The line a page draws under its heading, or null where there is nothing
 * worth saying — an operator-wide reader is reading everything, and an unknown
 * reach is not a fact.
 */
export function reachLabel(reach: Reach | null): string | null {
  // Spelled out rather than `isEstateWide`, which cannot narrow away the null.
  if (!reach || reach.scope === 'operator') return null;
  if (reach.branches.length === 0) {
    return 'You are not assigned to a park, so there is nothing here to show. Ask an administrator for access to yours.';
  }
  return `Showing ${reach.branches.map((b) => b.name).join(', ')}.`;
}
