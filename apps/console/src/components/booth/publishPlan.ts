/**
 * What pressing Publish would do, stated before anybody presses it.
 *
 * A publish is a live change to a machine standing in a public place. The
 * booths poll for a higher version about once a minute and apply it whole,
 * between spins, without anybody at the booth being asked — so the last moment
 * a person can change their mind is on this screen, and the only way they can
 * use it is if the screen tells them what they are committing to.
 *
 * **The refusals are the API's, and this file does not second-guess them.**
 * `GET /booths/:id/draft` returns `blockers`, computed by the same code that
 * will validate the publish inside the transaction that writes it — weights,
 * an empty wheel, a prize with no voucher, no design, eligibility with no
 * booth to run in. Re-deriving them here would produce a second list that
 * agrees today and drifts the first time either side gains a rule, and the
 * screen would be the one that is wrong. So this file summarises and
 * translates; `odds.ts` is what gives the live arithmetic while somebody
 * types, which is a different job.
 *
 * **What this cannot show, said rather than faked.** A field-by-field
 * comparison against the wheel the booths are running is not possible from
 * what the API returns: the draft carries the published version's number and
 * hash but not its document, so "the ฿200 voucher went from 14.5% to 20%"
 * cannot be computed here. `changed` — a boolean from the API, comparing the
 * two hashes — is what there is, and the summary below states what is about to
 * be published rather than pretending to a diff. Raised as a gap.
 */
import { formatTHB } from '@oto/shared';
import type { BoothDraft, PublishBlocker } from './boothApi';
import {
  expectedCostPerSpinSatang,
  expectedCostSatang,
  formatBp,
  formatGap,
  uncostedActive,
  weightVerdict,
  type WeightVerdict,
} from './odds';

/**
 * The words for a mode that has nowhere to run.
 *
 * `band` and `phone` are in the schema because the base specification asks for
 * one spin per wristband or per phone number. Neither can work at a shopping
 * centre: a visitor in a mall has no wristband, and the owner's instruction is
 * not to ask for a phone number on the television. They become usable the day
 * there is a booth inside the park. The API refuses them with its own message;
 * this is the form's, shown before anybody gets that far.
 */
export const ELIGIBILITY_REFUSAL = 'not available until the park booth exists';

export interface PublishPlan {
  /** The API's refusals, verbatim, in the order it listed them. */
  blockers: PublishBlocker[];
  /** Worth saying; not worth refusing over. Computed here, from the draft. */
  warnings: string[];
  /** False when the draft is byte-for-byte the published wheel. */
  changed: boolean;
  /** What this would become. Null where the API could not build a bundle. */
  nextVersion: number | null;
  /** One sentence a manager can stop on. */
  headline: string;
  /** What the wheel is about to become — the thing being committed to. */
  summary: {
    activePrizes: number;
    inactivePrizes: number;
    costPerSpin: string;
    costPerHundred: string;
  };
  verdict: WeightVerdict;
}

export function buildPublishPlan(draft: BoothDraft): PublishPlan {
  const verdict = weightVerdict(draft.prizes);
  const nextVersion = draft.published ? draft.published.version + 1 : 1;

  return {
    blockers: draft.blockers,
    warnings: publishWarnings(draft),
    changed: draft.changed,
    nextVersion,
    headline: headline(draft, verdict, nextVersion),
    summary: {
      activePrizes: verdict.activeCount,
      inactivePrizes: verdict.inactiveCount,
      costPerSpin: formatTHB(expectedCostPerSpinSatang(draft.prizes)),
      costPerHundred: formatTHB(expectedCostSatang(draft.prizes, 100)),
    },
    verdict,
  };
}

/**
 * Things a manager should hear before publishing that the API does not refuse.
 *
 * Kept few. A screen that warns about everything is a screen whose warnings
 * are scrolled past, and the two here are the ones that change a number the
 * owner will later be quoted.
 */
function publishWarnings(draft: BoothDraft): string[] {
  const warnings: string[] = [];

  const uncosted = uncostedActive(draft.prizes);
  if (uncosted > 0) {
    const names = draft.prizes
      .filter((p) => p.active && p.costSatang === 0)
      .map((p) => p.nameEn)
      .join(', ');
    warnings.push(
      `${uncosted} active prize${uncosted === 1 ? ' has' : 's have'} no cost recorded (${names}), so every money figure on this page understates what the wheel gives away.`,
    );
  }

  const uncapped = draft.prizes.filter((p) => p.active && p.dailyCap === null).length;
  if (uncapped === draft.prizes.filter((p) => p.active).length && uncapped > 0) {
    warnings.push(
      'No prize on this wheel has a daily cap, so a busy Saturday gives away whatever the odds produce. That is a decision, not a fault — it is only worth seeing once before it is published.',
    );
  }

  return warnings;
}

/**
 * The sentence at the top of the confirmation.
 *
 * It says what the wheel will BE rather than what changed, because what
 * changed is not computable from what the API returns — and a headline that
 * implied a comparison it had not made would be the exact failure this panel
 * exists to prevent.
 *
 * **It says PUBLISHED and never "running", for the same reason.** `draft`
 * carries the last version that was published; what a booth is actually
 * drawing from comes from the box's own heartbeat, on `GET /booths/:id/status`
 * and nowhere near this function. The two are often different — a box adopts
 * a wheel when it next pulls its cache, which on this build means when its
 * agent restarts — so a sentence here calling the published version "the one
 * the booth is running now" would be telling a manager something this module
 * cannot know and that is frequently untrue. The "Wheel version" fact on the
 * page is the reading that answers it.
 */
function headline(draft: BoothDraft, verdict: WeightVerdict, nextVersion: number): string {
  const odds = verdict.balanced
    ? `the odds add to 100% across ${verdict.activeCount} active prize${verdict.activeCount === 1 ? '' : 's'}`
    : `the odds add to ${formatBp(verdict.totalBp)} — ${formatGap(verdict.differenceBp)}`;

  if (!draft.published) {
    return `This booth has never run a wheel. Publishing gives it version 1, with ${verdict.activeCount} prize${verdict.activeCount === 1 ? '' : 's'} on it, and ${odds}.`;
  }
  if (!draft.changed) {
    return `Nothing differs from version ${draft.published.version}, the version last published. Publishing would mint an identical version ${nextVersion}, and ${odds}.`;
  }
  return `Version ${nextVersion} replaces version ${draft.published.version} as this booth's published wheel: ${verdict.activeCount} active prize${verdict.activeCount === 1 ? '' : 's'}${verdict.inactiveCount > 0 ? `, ${verdict.inactiveCount} switched off` : ''}, and ${odds}.`;
}
