import { useEffect, useSyncExternalStore } from 'react';
import { useDisplayIdle } from '@/pwa/displayIdle';
import {
  applyServiceWorkerUpdate,
  getServiceWorkerState,
  registerServiceWorker,
  subscribeServiceWorker,
} from '@/pwa/register';

/**
 * How long the display must sit idle and untouched before a waiting build is
 * applied. Longer than the till's lock screen (12 seconds): a family walking
 * up to the counter while the till is still on its welcome screen has time to
 * touch it, and a touch starts the wait again.
 */
export const DISPLAY_IDLE_MS = 30_000;

/** The gestures that mean somebody is at the screen right now. */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'touchstart'] as const;

/**
 * SCRUM-975 — THE COUNTER DISPLAY PAGE TAKES A NEW WEB BUILD BY ITSELF.
 *
 * `/display` mounted no updater, so a counter screen that opens the web
 * address ran the build it was opened on until somebody restarted it. It now
 * checks for a new build as the till does (`pwa/register.ts`: the same
 * service worker, asked every fifteen minutes, whenever the page becomes
 * visible and whenever the network returns), and applies one only when the
 * display is idle (`pwa/displayIdle.ts`: paired, heard from, nothing on its
 * way, the till's welcome screen on it) and nobody has touched it for
 * `DISPLAY_IDLE_MS`. Never in the middle of a form: the moment a family is on
 * a screen the display stops being idle and the wait is called off.
 *
 * Renders nothing. Mounted by `App.tsx` beside the display page only: the
 * box's own copy of the display (`box-display/`, served by the counter's box)
 * has no service worker and follows the box's release.
 */
export function DisplayUpdater() {
  const idle = useDisplayIdle();
  const sw = useSyncExternalStore(subscribeServiceWorker, getServiceWorkerState, getServiceWorkerState);

  useEffect(() => {
    registerServiceWorker();
  }, []);

  useEffect(() => {
    if (!sw.updateReady || !idle) return;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => applyServiceWorkerUpdate(), DISPLAY_IDLE_MS);
    };
    arm();
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, arm, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, arm));
    };
  }, [sw.updateReady, idle]);

  return null;
}
