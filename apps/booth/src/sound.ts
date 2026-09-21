/**
 * The wheel's two sounds — when a booth has been given any.
 *
 * The outgoing game shipped five mp3s and a 400-line web-audio graph. None of
 * that is lifted: the files are licence-encumbered and stay in `imports/`
 * (D23), and what replaces them is a slot. The layout manifest names the
 * sounds a wheel wants (`tick`, `win`) and where each is expected to come
 * from; until somebody fills a slot the fallback is `silent`, and every call
 * here does nothing at all.
 *
 * So a booth is silent today, on purpose, and gains its sounds when its assets
 * are uploaded rather than when this file is edited. There is no mute control
 * on the screen for the same reason — a toggle that switches nothing off is a
 * control that teaches staff the screen is broken. The day a slot is filled is
 * the day the booth needs one.
 */

import { assetUrl, type AssetManifest } from './booth/design';

type SoundName = 'tick' | 'win';

const urls: Record<SoundName, string | null> = { tick: null, win: null };

/**
 * Point the player at whatever the applied bundle's manifest offers. Called
 * on every config apply, so a booth that is given assets picks them up on the
 * next publish rather than on a restart.
 */
export function configureSounds(manifest: AssetManifest): void {
  urls.tick = assetUrl(manifest, 'tick');
  urls.win = assetUrl(manifest, 'win');
}

/**
 * Play one, if there is one.
 *
 * A fresh `Audio` per call rather than one element replayed: the tick fires
 * once per slice divider and the last one is often still sounding when the
 * next is due, which on a shared element truncates it into a stutter. The
 * elements are unreferenced the moment they finish and the browser collects
 * them.
 *
 * Every failure is swallowed. Sound is decoration on a machine whose job is to
 * hand a child a voucher, and autoplay policy, a missing file and a device
 * with no output are all ordinary states of a booth.
 */
export function playSfx(name: SoundName): void {
  const url = urls[name];
  if (!url) return;
  try {
    const audio = new Audio(url);
    audio.volume = name === 'tick' ? 0.35 : 0.7;
    void audio.play().catch(() => {});
  } catch {
    /* a booth is never taken down by its own sound effects */
  }
}
