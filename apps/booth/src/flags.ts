/**
 * The boot hash.
 *
 * A booth television has no keyboard, no address bar worth typing in and
 * nobody standing at it with a laptop, so the way anything is switched on for
 * a photograph is by appending to the URL once and reloading — which is how
 * the outgoing game did it too. `#debug` is the only flag that means anything
 * on a real booth; the rest drive the built-in fake so that the screens QA has
 * to capture (never synced, paper out, offline) can be captured without a box
 * and without unplugging a printer.
 *
 * **The fake-only flags are inert against a real booth.** They are read here,
 * but nothing outside src/booth/fake.ts looks at them, and the fake is not
 * loaded when the page is talking to a real booth service. They are not a way
 * to make a live booth claim its printer is broken.
 */

export interface BoothFlags {
  /**
   * Open the staff diagnostics overlay (D16). Nobody signs in at a booth
   * (SCRUM-694), so it opens directly; it shows states and counts, never an
   * account id.
   */
  debug: boolean;
  /** Force the fake transport even in a production build. */
  fake: boolean;
  /** Force the HTTP transport even in development. */
  live: boolean;
  /** Fake only: behave like a booth that has never completed a sync. */
  unsynced: boolean;
  /** Fake only: behave like a booth whose box cannot reach the cloud. */
  offline: boolean;
  /** Fake only: printer state to answer presses with. */
  printer: 'printed' | 'queued' | 'failed' | 'no_printer' | null;
  /**
   * Fake only: answer a press the way a booth whose wheel was republished
   * between this page's load and the draw would.
   *
   * `index` returns the right prize under the wrong slot; `prize` returns a
   * prize this page's bundle does not contain at all. It exists because those
   * two branches are the ones the whole `prizeId`-beside-`prizeIndex` contract
   * was written for, and a defence nobody can make fire is a defence nobody
   * knows works.
   */
  drift: 'index' | 'prize' | null;
  /**
   * Fake only: run the wheel as a booth whose manager set "spins per day" to
   * this number (SCRUM-257). `#spin-cap=2` gives two spins and refuses the
   * third, which is how the refusal screen is photographed without waiting for
   * a real booth to have a busy afternoon.
   *
   * Null is what a booth with no cap runs on, and it is the default. A value
   * that is not a positive whole number is ignored rather than clamped: the
   * published bundle's own schema refuses those, and a fake that accepted one
   * would be modelling a booth that cannot exist.
   */
  spinCap: number | null;
  /**
   * Fake only: nobody on today's roster (SCRUM-694), so the slip prints
   * "unattributed" — `#no-roster`, for photographing that state.
   */
  noRoster: boolean;
  /**
   * The hash carried a launcher hand-off (`#handoff=…`) from a launcher tab
   * opened before SCRUM-694. The page never exchanges it any more; it removes
   * it from the address and opens the demonstration wheel that tab expected.
   * One release only.
   */
  staleHandoff: boolean;
}

const EMPTY: BoothFlags = {
  debug: false,
  fake: false,
  live: false,
  unsynced: false,
  offline: false,
  printer: null,
  drift: null,
  spinCap: null,
  noRoster: false,
  staleHandoff: false,
};

/**
 * Parsed once, at module load.
 *
 * The outgoing game re-read `location.hash` on every question and used
 * substring matching, which made `#not-debug` turn the overlay on. This splits
 * on separators and compares whole tokens, and freezes the answer: a flag is a
 * boot decision, and a hash that changes while the page is running (the debug
 * overlay clears its own) must not silently re-configure the transport
 * underneath a spin.
 */
export const flags: BoothFlags = parseHash(
  typeof window === 'undefined' ? '' : window.location.hash,
);

/**
 * The hash, split into whole tokens.
 *
 * Exported because the stage overrides (`#cw`, `#off`, `#lite`, ...) are read
 * by the orientation frame rather than here — they configure a screen, not a
 * booth — and two tokenisers would be two answers to "does `#not-debug` count
 * as debug". This one says no.
 */
export function hashTokens(hash: string): string[] {
  return hash
    .replace(/^#/, '')
    .split(/[,;&\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '');
}

/** The hash with a launcher hand-off removed and every other token kept. */
export function withoutHandoff(hash: string): string {
  const kept = hash
    .replace(/^#/, '')
    .split(/[,;&\s]+/)
    .filter((part) => part !== '' && !part.toLowerCase().startsWith('handoff='));
  return kept.length > 0 ? `#${kept.join(',')}` : '';
}

export function parseHash(hash: string): BoothFlags {
  const tokens = hashTokens(hash);

  const has = (name: string) => tokens.includes(name);
  const value = (name: string): string | null => {
    const prefix = `${name}=`;
    const found = tokens.find((token) => token.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };

  const printer = value('printer');
  const drift = value('drift');
  const spinCap = Number(value('spin-cap'));
  return {
    ...EMPTY,
    drift: drift === 'index' || drift === 'prize' ? drift : null,
    spinCap: Number.isInteger(spinCap) && spinCap > 0 ? spinCap : null,
    debug: has('debug'),
    fake: has('fake'),
    live: has('live'),
    unsynced: has('unsynced'),
    offline: has('offline'),
    noRoster: has('no-roster'),
    staleHandoff: tokens.some((token) => token.startsWith('handoff=')),
    printer:
      printer === 'printed' ||
      printer === 'queued' ||
      printer === 'failed' ||
      printer === 'no_printer'
        ? printer
        : has('paper-out')
          ? 'queued' // the state a paper-out booth is actually in: queued, not lost
          : null,
  };
}
