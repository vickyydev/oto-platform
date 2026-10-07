import { useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { PARTY_CHARGE_HELD, type PartyChargeConfirmation } from '@/api/parties';

/**
 * S2-20 E4 — A PARTY CHARGE'S ORDER IS HELD FROM ITS PRESS TO ITS ANSWER (the
 * iPad's F&B and ticket modals, the phone's F&B screen), as the payment's
 * collect step freezes the amount it sends.
 *
 * The moment the charge is pressed the order on screen is the order that was
 * sent, and it stays so until the platform says yes or no: while the request
 * is on its way, and after an answer that never came, which are one hold.
 * Every press that would change or leave the order — a tap, a line edit, a
 * clear, a discount, Back, close — is refused out loud ("Order held"), so
 * nothing tapped meanwhile is taken in and nothing is dropped unsaid, and the
 * screen cannot be left while the answer is still to land on it.
 *
 *   - charged: the hold ends, and the screen closes;
 *   - a definite no, or a first press stopped before anything was sent: the
 *     order is staff's again, to change or drop;
 *   - nothing answered: still held, and the press sends the same order again —
 *     the same request under the same ids — until a definite answer comes.
 *
 * Kept in a ref as well as in state, so a press made before the screen has
 * drawn the hold is refused all the same.
 */
type ChargeHold = 'open' | 'sending' | 'unanswered';

export interface PartyChargeHold {
  /** From the press until a definite answer: the order is as it was sent. */
  held: boolean;
  /** On its way: the charge press waits for the answer. */
  sending: boolean;
  /** Sent and nothing answered: the charge press sends the same order again. */
  unanswered: boolean;
  /** A press that would change or leave the order: true, and said, while it is held. */
  refused: () => boolean;
  /**
   * Send the order; null when a charge is already on its way. `build` prices
   * the order ONCE, at the first press of a hold: an unanswered hold re-sends
   * exactly what it sent, however the screen would price it now — the rate
   * mode can move under an open modal (the header's indicator polls, the
   * cached mode lapses, the day rolls), and a repriced press would be a new
   * press under new ids: a second charge.
   */
  charge: <P>(
    build: () => P,
    send: (payload: P) => PartyChargeConfirmation | Promise<PartyChargeConfirmation>,
  ) => Promise<PartyChargeConfirmation | null>;
  /** The screen is reset: no order, no hold. */
  release: () => void;
}

export function usePartyChargeHold(): PartyChargeHold {
  const [hold, setHold] = useState<ChargeHold>('open');
  const current = useRef<ChargeHold>('open');
  const to = (next: ChargeHold) => {
    current.current = next;
    setHold(next);
  };

  const refused = () => {
    if (current.current === 'open') return false;
    toast(PARTY_CHARGE_HELD);
    return true;
  };

  /** What an unanswered hold sent, re-sent verbatim by the next press. */
  const sent = useRef<unknown>(null);

  const charge = async <P,>(
    build: () => P,
    send: (payload: P) => PartyChargeConfirmation | Promise<PartyChargeConfirmation>,
  ) => {
    if (current.current === 'sending') return null;
    // The payload belongs to the hold's FIRST press: held and unanswered, the
    // same order goes out again under the same ids, never a repriced one.
    const payload =
      current.current === 'unanswered' && sent.current !== null ? (sent.current as P) : build();
    sent.current = payload;
    to('sending');
    let result: PartyChargeConfirmation | null = null;
    try {
      result = await send(payload);
    } finally {
      // No result at all is no answer: the order stays held as it was sent.
      const unanswered = result === null || (!result.charged && result.held);
      to(unanswered ? 'unanswered' : 'open');
      if (!unanswered) sent.current = null;
    }
    return result;
  };

  return {
    held: hold !== 'open',
    sending: hold === 'sending',
    unanswered: hold === 'unanswered',
    refused,
    charge,
    release: () => {
      sent.current = null;
      to('open');
    },
  };
}
