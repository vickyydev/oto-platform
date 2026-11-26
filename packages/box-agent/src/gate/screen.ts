/**
 * WHAT THE GATE'S SCREEN SAYS (SCRUM-68) — the reader shows only the reply's
 * `message`, so a scan's answer is built here from parts:
 *
 *   lead     the greeting or the refusal (`GATE_MESSAGES`, English / Thai)
 *   kind     "Adult", shown only beside the ticket it qualifies
 *   ticket   the ticket line's label ("2 Hours Play")
 *   time     "until 17:30 · 1 h 20 min left", or "time ended 17:30"
 *   credit   "Credit ฿350", only when a wallet exists for the band
 *
 * A part the box does not know is left out, never guessed: with nothing known
 * the message is exactly the lead, as before SCRUM-68.
 *
 * How much fits on the reader is not known yet: on 23 November a refusal
 * showed inside an error box and no approval has been seen. One constant
 * caps the length, and parts are cut in one fixed order — the credit last —
 * so the owner can shorten it after the first real scan.
 */

import { formatTHB, wallClockMinutesInTz } from '@oto/shared';

import type { BandKind } from './decision';

/** The longest message the box sends the reader. */
export const GATE_SCREEN_MAX_CHARS = 120;

export type GateScreenPart = 'kind' | 'ticket' | 'time' | 'credit';

/** The order parts are cut in when the message is too long: the credit goes last. */
export const GATE_SCREEN_CUT_ORDER: readonly GateScreenPart[] = ['kind', 'ticket', 'time', 'credit'];

const SEP = ' · ';

// TRANSLATE: the words below are new English, no Thai yet (SCRUM-68).
const KIND_WORD: Record<BandKind, string> = { adult: 'Adult', kid: 'Kid' };

export interface GateScreenFacts {
  kind?: BandKind;
  ticketLabel?: string;
  validUntil?: number;
  creditSatang?: number;
  /** The box's corrected clock. */
  now: number;
  /** The branch's zone, for the clock time; absent, only the time left is shown. */
  timezone?: string;
}

function clock(instant: number, timezone: string): string | null {
  try {
    const minutes = wallClockMinutesInTz(new Date(instant), timezone);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

/** "1 h 20 min", "45 min", "2 h". */
function span(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The time part, or null when the band's end is not known. */
export function gateTimePart(
  validUntil: number | undefined,
  now: number,
  timezone: string | undefined,
): string | null {
  if (validUntil === undefined || !Number.isFinite(validUntil)) return null;
  const at = timezone ? clock(validUntil, timezone) : null;
  if (now > validUntil) return at ? `time ended ${at}` : 'time ended';
  const left = `${span(Math.ceil((validUntil - now) / 60_000))} left`;
  return at ? `until ${at}${SEP}${left}` : left;
}

/**
 * The message: the lead, then the parts that are known, cut to
 * `GATE_SCREEN_MAX_CHARS` in `GATE_SCREEN_CUT_ORDER`. `show` names the parts
 * this answer may carry at all (a refusal carries no credit, for instance).
 */
export function gateScreenMessage(
  lead: string,
  facts: GateScreenFacts,
  show: readonly GateScreenPart[],
): string {
  const parts: Array<[GateScreenPart, string]> = [];
  const label = facts.ticketLabel?.trim();
  if (label && show.includes('ticket')) {
    if (facts.kind && show.includes('kind')) parts.push(['kind', KIND_WORD[facts.kind]]);
    parts.push(['ticket', label]);
  }
  const time = show.includes('time') ? gateTimePart(facts.validUntil, facts.now, facts.timezone) : null;
  if (time) parts.push(['time', time]);
  if (show.includes('credit') && facts.creditSatang !== undefined && facts.creditSatang >= 0) {
    parts.push(['credit', `Credit ${formatTHB(facts.creditSatang)}`]);
  }
  const join = (list: Array<[GateScreenPart, string]>) => [lead, ...list.map(([, t]) => t)].join(SEP);
  let kept = parts;
  for (const cut of GATE_SCREEN_CUT_ORDER) {
    if (join(kept).length <= GATE_SCREEN_MAX_CHARS) break;
    kept = kept.filter(([p]) => p !== cut);
  }
  const message = join(kept);
  return message.length <= GATE_SCREEN_MAX_CHARS
    ? message
    : `${message.slice(0, GATE_SCREEN_MAX_CHARS - 1)}…`;
}
