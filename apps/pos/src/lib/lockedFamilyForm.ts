import { useEffect, useRef, useSyncExternalStore } from 'react';
import { bridgeApi } from '@/api/bridge';

/**
 * SCRUM-942 (FIRST PART) — THE LOCK SCREEN SAYS WHEN A FAMILY IS FILLING THE
 * FORM ON THE DISPLAY.
 *
 * A till nobody touches for two minutes locks (`auth/timings.ts`
 * INACTIVITY_TIMEOUT_MS), also while a family is filling the drop-off or
 * nanny form on its paired display, and a Done the family presses meanwhile
 * waits for the unlock. The owner has not yet chosen between keeping the till
 * awake while the family types and the lock screen saying so; this is only the
 * second: while the till is locked and its family form is open on the display,
 * the lock screen says so in one line, and once the family has pressed Done,
 * that they have and that an unlock carries on. When the till locks is not
 * changed here.
 *
 * Where the other choice would go, if the owner takes it: the till hears the
 * family's typing as `fill` answers in `pages/Till.tsx` (the consent branch of
 * the `useTicketDisplay` answer handler); the inactivity countdown is re-armed
 * by the window events in `auth/OperatorContext.tsx` (`ACTIVITY_EVENTS`, the
 * effect that calls `armTimers`). A `fill` taken there could re-arm it, for
 * example by dispatching an event that effect also listens for. The handler
 * takes no answer while the till is locked, so only a till still unlocked would
 * be kept awake.
 *
 * How the locked till knows: the till stays mounted under the lock (its sale is
 * kept), so it knows whether the form was open on the display when it locked.
 * A locked session may do no business, but it may read its station's status
 * (`GET /box/v1/station/:id/status`, which carries no personal data): that read
 * says where the form stands (`familyForm`), so the line follows the family's
 * Done. A box from before that field says nothing, and the line from the
 * moment of the lock stands.
 */
export type LockedFamilyForm = 'filling' | 'done' | null;

/** How often a locked till asks its station where the family's form stands. */
export const LOCKED_FORM_POLL_MS = 3_000;

let current: LockedFamilyForm = null;
const listeners = new Set<() => void>();

export const lockedFamilyForm = {
  get: (): LockedFamilyForm => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  set(next: LockedFamilyForm): void {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  },
};

/** The lock screen's side: what to say, if anything. */
export function useLockedFamilyForm(): LockedFamilyForm {
  return useSyncExternalStore(lockedFamilyForm.subscribe, lockedFamilyForm.get, lockedFamilyForm.get);
}

/** The lock screen's one line for it, in the till's own English. */
export function lockedFamilyFormLine(state: LockedFamilyForm): string | null {
  if (state === 'filling') return 'A family is filling in the drop-off form on the display.';
  if (state === 'done') return 'The family has pressed Done: unlock to carry on.';
  return null;
}

/**
 * The till's side, called while it stays mounted under the lock: `formOpen` is
 * whether its family form is open on the paired display (as it was when the
 * till locked: a locked till takes no answers, so it does not move).
 *
 * SCRUM-964 — `ended`: the lock is a session that ended (the sign-in form),
 * not a staff lock. The family is still at the display, but the till's own
 * picture of it goes stale as the ended session's calls are refused, so what
 * it knew at the end stands — the form open on the display, as the till last
 * saw it signed in — until somebody signs in (the till then shows the form
 * itself) or the sale is dropped (its screen goes, and the line with it).
 */
export function useLockedFamilyFormWatch({ locked, formOpen, stationId, ended = false }: {
  locked: boolean;
  formOpen: boolean;
  stationId: string | null;
  ended?: boolean;
}): void {
  /** Whether the form was open on the display as the till last knew it signed in. */
  const lastOpen = useRef(false);
  useEffect(() => {
    if (!locked) lastOpen.current = formOpen;
    else if (formOpen) lastOpen.current = true;
    const open = formOpen || (locked && ended && lastOpen.current);
    if (!locked || !open) {
      lockedFamilyForm.set(null);
      return;
    }
    lockedFamilyForm.set('filling');
    if (!stationId) return () => { lockedFamilyForm.set(null); };
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const status = await bridgeApi.status(stationId);
        if (stopped) return;
        if (status.familyForm === 'done' || status.familyForm === 'filling') lockedFamilyForm.set(status.familyForm);
        else if (status.familyForm === null) lockedFamilyForm.set(null);
        // Absent: a box from before the field; the line from the lock stands.
      } catch {
        // Not answered this time: the line stands, and the next read decides.
      } finally {
        if (!stopped) timer = setTimeout(() => { void read(); }, LOCKED_FORM_POLL_MS);
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
      lockedFamilyForm.set(null);
    };
  }, [locked, formOpen, stationId, ended]);
}
