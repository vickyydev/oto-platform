/**
 * The marker the staff app and Radar add when they send a person here after
 * their own sign-out (SCRUM-538): `?from=signout`. A query, never a fragment —
 * fragments carry the hand-off.
 */
export function hasSignOutMarker(search: string): boolean {
  return new URLSearchParams(search).get('from') === 'signout';
}

/** The address without the marker, other parameters and the fragment kept. */
export function withoutSignOutMarker(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('from');
  return url.pathname + url.search + url.hash;
}
