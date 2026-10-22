import { type BenefitProfile } from "../../../model/types";
import type { BenefitsHelpers } from '../../../lib/benefits';
import type { DiscountTargetHelpers } from '../../../lib/discountTarget';

/** Original domain rules, bound to this host's explicit data ports. */
export function createBenefitSummaryHelpers(deps: { benefits: BenefitsHelpers; discountTarget: DiscountTargetHelpers }) {
const { isEmptyBenefitProfile } = deps.benefits;
const { formatDiscountTargetLabel } = deps.discountTarget;


/**
 * Human summary of a resolved BenefitProfile, for compact list rows — the
 * prototype's `summarizeProfile` (StaffBenefitsPanel.tsx), moved here so the
 * override dialog's history can say the same words.
 */
function summarizeProfile(profile: BenefitProfile): string {
  if (isEmptyBenefitProfile(profile)) return 'No benefit configured';
  if (profile.comp) return 'Full comp';
  const parts: string[] = [];
  for (const fi of profile.freeItems ?? []) {
    parts.push(`${fi.quotaPerPeriod}x ${fi.label} / ${fi.period === 'daily' ? 'day' : 'mo'}`);
  }
  if (profile.credit) {
    parts.push(
      `฿${profile.credit.amountTHB} credit (${formatDiscountTargetLabel(profile.credit.target)}) / ${
        profile.credit.period === 'daily' ? 'day' : 'mo'
      }`,
    );
  }
  if (profile.standingDiscount) {
    parts.push(
      `${profile.standingDiscount.percent}% off ${formatDiscountTargetLabel(profile.standingDiscount.target)}`,
    );
  }
  return parts.join(' · ');
}
return { summarizeProfile };
}
export type BenefitSummaryHelpers = ReturnType<typeof createBenefitSummaryHelpers>;
