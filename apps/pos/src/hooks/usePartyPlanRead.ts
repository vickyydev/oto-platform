import { useEffect, useRef, useState } from 'react';
import { readPartyPlanOnPlatform, type PartyPlanRead } from '@/api/parties';
import { PARTY_PLAN_REFRESH_MS } from '@/lib/partyKitchen';
import type { PartyBooking } from '@/types';

/**
 * SCRUM-906 — THE PARTY'S PLAN, KEPT CURRENT WHILE ITS PAGE IS OPEN. Read when
 * the page opens, and again when the till comes back to the front (the window
 * regains focus, or the page becomes visible) and every minute while it is
 * open, so a change made in the BEO reaches the page without leaving it. A
 * read that fails keeps what was last read; another party starts afresh.
 * `paused` holds the reading still (a settlement or an edit in progress), and
 * `nonce` asks for one read now.
 */
export function usePartyPlanRead(
  party: Pick<PartyBooking, 'id' | 'branchId'>,
  opts: { paused?: boolean; nonce?: number } = {},
): PartyPlanRead | null {
  return usePartyPlanReadState(party, opts) ?? null;
}

/**
 * SCRUM-936 — THE SAME READ, SAYING WHETHER IT HAS ANSWERED: undefined until
 * this party's first read answers, null when it answered with nothing
 * (offline, not linked), else the plan, kept as `usePartyPlanRead` keeps it.
 * The party page reads the plan once with it: its kitchen sections take the
 * plan, and its bill waits for the first answer before it prices the party
 * (`usePlannedSettleQuote`), so it never reads "could not be read" while the
 * plan is still on its way.
 */
export function usePartyPlanReadState(
  party: Pick<PartyBooking, 'id' | 'branchId'>,
  opts: { paused?: boolean; nonce?: number } = {},
): PartyPlanRead | null | undefined {
  const [read, setRead] = useState<PartyPlanRead | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const paused = useRef(false);
  paused.current = !!opts.paused;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    const again = () => {
      if (!paused.current) setTick((n) => n + 1);
    };
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') again();
    };
    const win = typeof window !== 'undefined' ? window : null;
    win?.addEventListener('focus', again);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(again, PARTY_PLAN_REFRESH_MS);
    // A Node timer would hold a test's process open; a browser's is a number.
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => {
      win?.removeEventListener('focus', again);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let live = true;
    const key = `${party.branchId}:${party.id}`;
    if (shown.current !== key) {
      shown.current = key;
      setRead(undefined);
    }
    void readPartyPlanOnPlatform({ id: party.id, branchId: party.branchId }).then((next) => {
      if (!live) return;
      // A read that came back with nothing (offline, not linked) keeps the last one of this party.
      setRead((previous) => next ?? previous ?? null);
    });
    return () => {
      live = false;
    };
  }, [party.id, party.branchId, opts.nonce, tick]);

  return read;
}
