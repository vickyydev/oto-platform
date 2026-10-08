import type { StaffBenefitRow } from '@/api/benefits';

/**
 * Where a staff member's record is kept — a UI addition (S2-17b round 2,
 * PLAN section 5 "The swap"). The staff list is `core.employee`, read only:
 * `otoapp` is a person copied from the OTO App, which stays the employee
 * master, so their name and contact details are changed there; `platform` is
 * a record written on the platform itself (the dev seed's four). The API has
 * always answered `source`; this says it on the row, in the panel's own chip
 * style, beside the benefit role.
 */
export const STAFF_SOURCE_LABELS: Record<StaffBenefitRow['source'], string> = {
  otoapp: 'OTO App',
  platform: 'Platform',
};

export const STAFF_SOURCE_TITLES: Record<StaffBenefitRow['source'], string> = {
  otoapp: 'Copied from the OTO App, which keeps this person’s record: change their details there.',
  platform: 'A record kept on the platform itself.',
};

export function StaffSourceChip({ source }: { source: StaffBenefitRow['source'] }) {
  return (
    <span
      className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-foreground/60"
      title={STAFF_SOURCE_TITLES[source]}
      data-staff-source={source}
    >
      {STAFF_SOURCE_LABELS[source]}
    </span>
  );
}
