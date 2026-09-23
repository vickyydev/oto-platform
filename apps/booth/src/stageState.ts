/**
 * The logical stage, and the two decisions taken about it at boot.
 *
 * Lifted from the outgoing wheel's `stageState.ts` and `config.ts` (D21). The
 * game is drawn ONCE, portrait, at a fixed logical width, and
 * `components/OrientationFrame.tsx` is what makes that one drawing fit a phone,
 * a vertical monitor, or a television hung sideways. The frame owns the
 * decision; this module is where the decision is published, so a component deep
 * inside the transformed tree can read the active rotation and the logical
 * stage size without measuring the DOM — measurement proved unreliable on the
 * television, which is the whole reason the module exists.
 *
 * A plain mutable object rather than React context, because code OUTSIDE the
 * transformed tree reads it too.
 *
 * Not lifted: the outgoing file's rolling input log. It existed to feed the old
 * game's on-screen banner; this booth already records key events in `App` and
 * shows them in the staff diagnostics overlay, and two logs of the same thing
 * is one log that drifts.
 */

import { hashTokens } from './flags';

export type RotateMode = 'cw' | 'ccw' | 'off';

/**
 * The logical width the game is drawn at, in CSS pixels.
 *
 * Every size in kiosk.css is a plain pixel value measured against this width —
 * there is not a single viewport unit or media query in that stylesheet — so
 * changing this number does not reflow the layout, it rescales it. 480 is the
 * width the outgoing game was drawn at and the width `.k-body`'s `max-width`
 * still carries.
 */
export const STAGE_WIDTH = 480;

/**
 * Which way to turn the stage on a sideways screen.
 *
 * The televisions are mounted portrait but still output landscape, so the page
 * has to turn its own content. `cw` puts the top of the portrait layout on the
 * right-hand edge of the landscape signal, which is upright on the booth
 * televisions as they are hung today. A booth hung the other way is one `#ccw`
 * away — see OrientationFrame — and does not need a new build.
 */
export const ROTATE_LANDSCAPE: RotateMode = 'cw';

/**
 * Bumped by hand when a published build must start from a clean baseline.
 *
 * Every override below is saved on the device under a key carrying this tag, so
 * a rotation someone typed on the television while diagnosing a hanging bracket
 * cannot haunt the next version. The outgoing game learned this the hard way.
 */
export const BUILD_TAG = 'v1';

// ---- Television performance mode ("lite") -------------------------------
/**
 * Whether to drop the ambient animation.
 *
 * The attract — drifting blobs, the floating title, the blinking rim lights,
 * the breathing glow — is what stops a still screen in a shopping centre from
 * reading as broken. It is also a pile of always-running compositor layers, and
 * on an Android television stick they cost the spin its frame rate. In lite
 * mode kiosk.css drops them, and every frame goes to what a child is actually
 * watching: the wheel turning and the card arriving.
 *
 *   auto:   on for Android and smart-television user agents, off on a PC
 *   #lite   force on (saved on the device for this build)
 *   #full   force off (saved) — to compare on the same television
 *   #clear  forget the saved choice
 *
 * Decided once, at boot, and cached: a mode that changed mid-shift would swap
 * the celebration out from under a spin.
 */
const LITE_KEY = 'oto-booth:lite-override:' + BUILD_TAG;
let perfLiteCache: boolean | null = null;

export function isPerfLite(): boolean {
  if (perfLiteCache !== null) return perfLiteCache;

  const tokens = hashTokens(typeof window === 'undefined' ? '' : window.location.hash);
  const has = (name: string) => tokens.includes(name);

  let chosen: boolean | null = null;
  try {
    if (has('clear')) window.localStorage.removeItem(LITE_KEY);
    if (has('lite')) {
      chosen = true;
      window.localStorage.setItem(LITE_KEY, 'on');
    } else if (has('full')) {
      chosen = false;
      window.localStorage.setItem(LITE_KEY, 'off');
    } else {
      const saved = window.localStorage.getItem(LITE_KEY);
      if (saved === 'on') chosen = true;
      else if (saved === 'off') chosen = false;
    }
  } catch {
    // A television browser with storage disabled still honours the hash for
    // this load; it just cannot remember it.
    if (has('lite')) chosen = true;
    else if (has('full')) chosen = false;
  }

  if (chosen === null) {
    try {
      chosen = /android|tizen|smart-?tv|web0s|webos|crkey|firetv/i.test(navigator.userAgent || '');
    } catch {
      chosen = false;
    }
  }

  perfLiteCache = chosen;
  return chosen;
}

export const stageState = {
  /** The mode in force, after the hash and the saved override. */
  rotateMode: 'off' as RotateMode,
  /** Whether the stage is actually turned — `rotateMode` and a sideways viewport. */
  rotated: false,
  /** Logical (pre-scale) stage size, republished by the frame on every render. */
  designW: STAGE_WIDTH,
  designH: 853,
};
