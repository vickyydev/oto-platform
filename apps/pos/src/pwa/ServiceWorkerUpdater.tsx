import { useEffect, useSyncExternalStore } from 'react';
import { useOperator } from '@/auth/OperatorContext';
import { useSaleOpen } from '@/pwa/openSale';
import {
  applyServiceWorkerUpdate,
  getServiceWorkerState,
  registerServiceWorker,
  subscribeServiceWorker,
} from '@/pwa/register';

/**
 * How long the lock screen must sit untouched before a new build is applied.
 *
 * The take-over reloads the page. Doing that under somebody's fingers — half a
 * password typed, a sign-in submitted and waiting — would look exactly like a
 * refused password, which is the one thing a lock screen must never do by
 * accident. Twelve seconds is longer than any pause inside typing a password
 * and shorter than any real gap between visitors.
 */
const LOCK_SCREEN_IDLE_MS = 12_000;

/** The gestures that mean somebody is at the screen right now. */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'touchstart'] as const;

/**
 * Applies a waiting build, at the only moment it is safe to.
 *
 * Renders nothing. It is mounted inside the operator provider because the
 * condition it waits for is a fact about the session, and it holds no UI of
 * its own on purpose: CLAUDE.md §7 rule 1 says the design does not change, and
 * an update that announces itself would be a new element on the lock screen
 * for something nobody has to decide anything about.
 *
 * ── THE GATE ──────────────────────────────────────────────────────────────
 *
 * Three conditions, and they rule out different things.
 *
 * `atLockScreen` is the strong one: it is the only state in which the shell is
 * holding nothing — no cart, no member on screen, no half-finished child
 * confirmation — because `AuthGate` renders the lock screen INSTEAD of the
 * router, so every selling surface is unmounted behind it.
 *
 * `saleOpen` asks the selling surfaces themselves (`src/pwa/openSale.ts`).
 * Because of what the previous paragraph says, it is already false whenever
 * the first condition is true: a locked till has no mounted till page to
 * report a cart. It is evaluated rather than assumed because the two
 * conditions are about different things — which screen is showing, and what
 * the till is holding — and they only coincide while the lock screen replaces
 * the router rather than covering it.
 *
 * `idle` is the one that does real work every time: a lock screen with
 * somebody standing at it, typing, is not a safe moment even though it holds
 * no sale.
 */
export function ServiceWorkerUpdater() {
  const { operator, locked, sessionResolved } = useOperator();
  const saleOpen = useSaleOpen();
  const sw = useSyncExternalStore(
    subscribeServiceWorker,
    getServiceWorkerState,
    getServiceWorkerState,
  );

  useEffect(() => {
    registerServiceWorker();
  }, []);

  // `sessionResolved` matters: until the resume has answered, the shell shows
  // a spinner rather than the lock screen, and reloading through that would
  // look like the spinner hanging.
  const atLockScreen = sessionResolved && (!operator || locked);

  useEffect(() => {
    if (!sw.updateReady || !atLockScreen || saleOpen) return;

    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => applyServiceWorkerUpdate(), LOCK_SCREEN_IDLE_MS);
    };
    arm();
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, arm, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, arm));
    };
  }, [sw.updateReady, atLockScreen, saleOpen]);

  return null;
}
