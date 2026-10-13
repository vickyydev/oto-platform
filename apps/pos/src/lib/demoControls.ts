import { useEffect, useState } from 'react';
import { opsApi } from '@/api/platform';

/**
 * SCRUM-515 — WHETHER THIS TILL SHOWS ITS DEMO CONTROLS.
 *
 * The demo wristbands are stand-ins with no member behind them, so an order
 * started on one carries nobody the kitchen ticket can warn about. They stay
 * where people play: a development build, and a deployment that says it is a
 * playground (`OPS_TEST_CONTROLS`, the same switch the demo reset stands
 * behind — the api refuses to boot a production deployment with it on). The
 * till asks the api once; anything but a plain yes — an api without the
 * answer, a refusal, no connection — hides them, so a real park never shows
 * them by mistake. A failed ask is not remembered: the next screen asks again.
 */
let answer: boolean | null = null;
let pending: Promise<boolean> | null = null;

export function demoControlsShown(): Promise<boolean> {
  if (import.meta.env.DEV) return Promise.resolve(true);
  if (answer !== null) return Promise.resolve(answer);
  pending ??= opsApi.demoResetStatus().then(
    (status) => {
      answer = status.playground === true;
      pending = null;
      return answer;
    },
    () => {
      pending = null;
      return false;
    },
  );
  return pending;
}

/** For tests: forget the deployment's answer. */
export function resetDemoControls(): void {
  answer = null;
  pending = null;
}

export function useDemoControls(): boolean {
  const [shown, setShown] = useState(() => import.meta.env.DEV || answer === true);
  useEffect(() => {
    let live = true;
    void demoControlsShown().then((next) => {
      if (live) setShown(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return shown;
}
