/**
 * What the television draws from a published wheel, as pure functions
 * (SCRUM-223) — no React, no DOM, so a test can run them on Node alone.
 *
 * **Only switched-on prizes are slices.** The Console says a prize switched
 * off is "not drawn and not shown", and the box has always honoured the first
 * half: the draw skips an inactive prize. The television did not honour the
 * second — it drew every prize in the bundle as a slice, so the Mystery Box
 * the park keeps off the wheel sat on it, never winnable, in plain view. The
 * bundle still carries every prize (the draw and the reports read it whole);
 * the wheel shows the ones that can be won.
 *
 * **Which is why a slice is not an index into the bundle any more.** The box
 * answers a press with `prizeIndex` — a position in the bundle's `prizes` —
 * and `prizeId`. With inactive prizes left off the wheel the two orders
 * differ, so the slice to stop on is found by the prize itself.
 */

import type { BoothConfigBundle, BoothConfigPrize } from '@oto/shared';

export interface VisiblePrize {
  prize: BoothConfigPrize;
  /** Where it sits in the bundle's `prizes`, which is what the box's `prizeIndex` counts. */
  bundleIndex: number;
}

/** The slices, in the bundle's own order, switched-off prizes left out. */
export function visiblePrizes(bundle: Pick<BoothConfigBundle, 'prizes'> | null | undefined): VisiblePrize[] {
  if (!bundle) return [];
  const out: VisiblePrize[] = [];
  bundle.prizes.forEach((prize, bundleIndex) => {
    if (prize.active) out.push({ prize, bundleIndex });
  });
  return out;
}

/**
 * The slice the wheel stops on for what the box drew, or null when the prize
 * is not on this wheel (the page then shows the card without the spin — the
 * prize is real either way).
 *
 * The position is trusted only when the prize under it is the one named;
 * otherwise the id decides, because the id is the identity and the position a
 * slot.
 */
export function sliceIndexFor(
  visible: readonly VisiblePrize[],
  drawn: { prizeIndex: number; prizeId: string },
): number | null {
  const exact = visible.findIndex(
    (v) => v.bundleIndex === drawn.prizeIndex && v.prize.id === drawn.prizeId,
  );
  if (exact >= 0) return exact;
  const byId = visible.findIndex((v) => v.prize.id === drawn.prizeId);
  return byId >= 0 ? byId : null;
}

/**
 * A voucher code as people read it off a screen: groups of two, four, four,
 * and whatever is left — `B1 RT7K MQ4X`, and `B1 RT7K MQ4X Z` once the code
 * carries a check character. Never a fixed length: the canonical string is
 * what the QR carries, and this is presentation only.
 */
export function groupBoothCode(code: string): string {
  const clean = code.replace(/\s+/g, '');
  const groups = [clean.slice(0, 2), clean.slice(2, 6), clean.slice(6, 10), clean.slice(10)];
  return groups.filter((g) => g !== '').join(' ');
}
