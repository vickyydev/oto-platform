import type { ActivityLog, ActivityType } from "@shared/schema";
import { canViewHrSalary, containsHrPayFields, redactHrPay, type HrSalarySubject } from "@shared/hr-salary-permission";

/**
 * Pay in the activity log (SCRUM-1058).
 *
 * The rule the app already has for pay (SCRUM-559, `canViewHrSalary`): pay
 * figures are shown only to the roles that may see salaries. The activity log
 * follows it. Its list checked only the sign-in and the branch, so an entry of
 * a salary change, whose words and metadata carry the figures, reached anybody
 * with that branch in reach.
 *
 *  - Entries about pay (`PAY_ACTIVITY_TYPES`: a salary change, and a single
 *    shift switched between the old contract and a casual day rate) are left
 *    out for a reader below the salary roles: not listed, not counted, not
 *    found by a filter, a search or an employee's own history.
 *  - Any other entry whose metadata carries a pay field (the app's own list of
 *    pay keys, e.g. a contract generated with a salary change among its
 *    employee changes) is kept, with those fields taken out of the metadata,
 *    as every other HR answer withholds them (`redactHrPay`).
 *  - Nothing stored is deleted or changed: a salary role reads the log whole.
 */
export const PAY_ACTIVITY_TYPES: readonly ActivityType[] = ["salary_change", "single_shift_pay_changed"];

/** The entry types this reader is not given: none for a salary role. */
export function activityTypesWithheldFrom(subject: HrSalarySubject): readonly ActivityType[] {
  return canViewHrSalary(subject) ? [] : PAY_ACTIVITY_TYPES;
}

/** The entries as this reader may read them: pay fields taken out of the metadata below the salary roles. */
export function activityForReader(logs: ActivityLog[], subject: HrSalarySubject): ActivityLog[] {
  if (canViewHrSalary(subject)) return logs;
  return logs.map((log) => {
    if (!log.metadataJson) return log;
    let metadata: unknown;
    try {
      metadata = JSON.parse(log.metadataJson);
    } catch {
      return log;
    }
    return containsHrPayFields(metadata) ? { ...log, metadataJson: JSON.stringify(redactHrPay(metadata)) } : log;
  });
}
