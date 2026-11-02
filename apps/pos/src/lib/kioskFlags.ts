/**
 * WHAT THE ADDRESS SAYS ABOUT THE MACHINE THIS PAGE RUNS ON (SCRUM-711).
 *
 * The counter box opens the customer display on its touch monitor with an
 * address of its own (`OTO_KIOSK_URL` in `/etc/oto-box/config`, e.g.
 * `/display?keyboard=screen`). That monitor has no keyboard, and `?keyboard=screen`
 * is how the page learns it has to bring its own. An iPad or a laptop on the
 * plain `/display` has one already, and is told nothing.
 *
 * Read once, as the page loads: the flag belongs to the machine, so nothing the
 * page later does to its address can change it.
 */
export interface KioskFlags {
  /** No hardware keyboard here: text fields bring the on-screen one. */
  screenKeyboard: boolean;
}

export function parseKioskFlags(search: string): KioskFlags {
  return { screenKeyboard: new URLSearchParams(search).get('keyboard') === 'screen' };
}

export const kioskFlags: KioskFlags = parseKioskFlags(
  typeof window === 'undefined' ? '' : (window.location?.search ?? ''),
);
