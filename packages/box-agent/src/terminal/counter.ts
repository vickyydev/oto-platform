/**
 * The per-terminal, per-day reference counter (S2-10a).
 *
 * Both vendors want a reference of our own on every message and both say it
 * must be unique: GHL's `pos_ref_no` ("POS generates the number to reference
 * the transaction (Unique)", p.8) and Digio's tag `04` ("Unique reference
 * number from 3rd party. 6 digit"). It is the correlation key — the only way to
 * tell the terminal's answer to THIS tender from its answer to the one before.
 *
 * **It is not a table.** The ticket asks for `terminal_counter (device_id,
 * next_ref)` and `edge.box_counter` already is one: its primary key is
 * `(box_id, scope, counter_key, business_date)` and `BoxStore.bumpCounter` is a
 * single statement, so two tenders arriving together cannot both read the same
 * number (`store-sql.ts:1160`). With `scope = 'terminal_ref'` and
 * `counter_key` the device id, that key IS "unique per terminal per day" — and
 * the daily reset the uniqueness test wants comes free, with no migration and
 * no change to the store (decision O-3).
 *
 * **Why the reference is minted on the BOX and not in the cloud.** A tender
 * taken while the link is down still needs one, and two tills that both asked
 * the cloud would be one round trip away from a guest waiting. The counter is
 * on the box's own disk, so it survives a restart, which is the property that
 * matters: a reference reused after a power cut is a transaction the terminal
 * would refuse or, worse, match to the wrong sale.
 */

import { TERMINAL_REF_COUNTER_SCOPE } from '@oto/shared';

import type { BoxStore } from '../store';
import { TerminalError, type TerminalProtocol } from './contract';

/**
 * How many tenders one terminal can take in one trading day.
 *
 * Four digits, because the two dialects have very different room — twelve
 * characters against six — and one sequence width for both is the only way the
 * two references are the same counter. Ten thousand card tenders on one
 * terminal in one day is several times the park's busiest imaginable day, and
 * the answer at the limit is a refusal rather than a wrap: a reference reused
 * inside a day is exactly what both vendors forbid.
 */
export const TERMINAL_REF_MAX_SEQ = 9999;

/**
 * Two digits of the device, so two terminals never mint the same string.
 *
 * Neither vendor needs this — their uniqueness is per terminal, and the
 * counter already gives that — but a reference that identifies its terminal is
 * worth having the first time somebody reconciles two slips by hand, and it
 * costs two of the six digits Digio leaves us. Derived from the device id so it
 * needs no configuration and survives a re-seed; with a hundred tags, two
 * terminals sharing one is possible and harmless, and the cloud's
 * `unique(device_id, business_date, terminal_ref)` is unaffected either way.
 */
export function deviceTag(deviceId: string): string {
  // FNV-1a, 32-bit. A hash rather than a slice of the uuid because two
  // consecutive uuidv7 ids differ in their last characters by one bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i += 1) {
    hash ^= deviceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash % 100).padStart(2, '0');
}

export interface MintRefInput {
  deviceId: string;
  protocol: TerminalProtocol;
  /** The branch's trading day, `YYYY-MM-DD` — not the calendar date, not UTC. */
  businessDate: string;
}

export interface TerminalRefCounter {
  /**
   * The next reference for this terminal today.
   *
   * Sales, VOIDS and Digio inquiries all draw on it: both vendors require a
   * fresh reference for a void rather than the original sale's (GHL pp.16-17,
   * Digio §5.5.1), and a void that reused one would break the uniqueness the
   * sale's reference depends on. A GHL QUERY is the exception and mints
   * nothing — it is keyed on the ORIGINAL sale's reference ("Same as Original
   * Sale", p.13), so asking for a new one would ask about a transaction that
   * never existed.
   */
  next(input: MintRefInput): Promise<string>;
}

/**
 * Shape a sequence number into the reference each dialect has room for.
 *
 *   ghl_linkpos  `YYMMDD` + device(2) + seq(4)  = 12 characters, all digits
 *   digio_tlv                device(2) + seq(4) = 6 digits
 *
 * Twelve is the intersection of the GHL document's own three answers (String
 * 20 on SALE, 12 on QUERY, 32 on VOID), and the date is in it because there is
 * room: a reference that carries its own day is one a person can read off a
 * terminal's slip and match to a trading day without a lookup. Digio has six
 * digits and no room for anything but the terminal and the count.
 */
export function formatRef(protocol: TerminalProtocol, input: MintRefInput, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > TERMINAL_REF_MAX_SEQ) {
    throw new TerminalError(
      'TERMINAL_BAD_REQUEST',
      `this terminal has taken ${TERMINAL_REF_MAX_SEQ} tenders today, which is as many references as one day has`,
    );
  }
  const tag = deviceTag(input.deviceId);
  const count = String(seq).padStart(4, '0');
  if (protocol === 'digio_tlv') return `${tag}${count}`;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.businessDate);
  if (!date) {
    throw new TerminalError(
      'TERMINAL_BAD_REQUEST',
      `"${input.businessDate}" is not a business date, so no reference can be minted`,
    );
  }
  return `${date[1]?.slice(2)}${date[2]}${date[3]}${tag}${count}`;
}

export interface RefCounterDeps {
  /** Null on a box with no store — see the refusal below. */
  store: BoxStore | null;
  boxId: () => string | null;
  now?: () => Date;
}

export function createTerminalRefCounter(deps: RefCounterDeps): TerminalRefCounter {
  return {
    async next(input) {
      const boxId = deps.boxId();
      if (!deps.store || !boxId) {
        /**
         * A refusal, not an in-memory fallback.
         *
         * An in-memory counter would start again at one every time the box
         * restarted, and a terminal that sees today's reference twice either
         * refuses the tender or — worse on the inquiry path — answers about the
         * wrong transaction. A box that cannot remember must not take card
         * money, and saying so by name is what gets it fixed.
         */
        throw new TerminalError(
          'TERMINAL_NOT_CONFIGURED',
          'this box has no store, so it cannot mint a terminal reference that survives a restart',
        );
      }
      let seq: number;
      try {
        seq = await deps.store.bumpCounter(
          boxId,
          {
            scope: TERMINAL_REF_COUNTER_SCOPE,
            key: input.deviceId,
            businessDate: input.businessDate,
          },
          1,
          deps.now?.().toISOString(),
        );
      } catch (err) {
        throw new TerminalError(
          'TERMINAL_NOT_CONFIGURED',
          'this box’s store cannot hold counters, so it cannot mint a terminal reference',
          { cause: err },
        );
      }
      return formatRef(input.protocol, input, seq);
    },
  };
}
