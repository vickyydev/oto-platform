import type { BenefitProfile } from '@/types';
import { isEmptyBenefitProfile } from '@/lib/benefits';
import { formatDiscountTargetLabel } from '@/lib/discountTarget';

/**
 * Human summary of a resolved BenefitProfile, for compact list rows — the
 * prototype's `summarizeProfile` (StaffBenefitsPanel.tsx), moved here so the
 * override dialog's history can say the same words.
 */
export function summarizeProfile(profile: BenefitProfile): string {
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
