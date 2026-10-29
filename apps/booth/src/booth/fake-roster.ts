/**
 * Today's roster as the fake booth's slip prints it (SCRUM-694): a made-up
 * "Demo staff", or nobody with `#no-roster` — which is how the unattributed
 * slip is photographed without a real booth.
 *
 * Import-free on purpose, so the node test runner can read it without a
 * bundler (the fake itself cannot load there).
 */
export function fakeDutyLabel(noRoster: boolean): string | null {
  return noRoster ? null : 'Demo staff';
}
