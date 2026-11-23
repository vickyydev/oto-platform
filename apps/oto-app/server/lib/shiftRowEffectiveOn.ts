import { and, gte, isNull, lte, or } from 'drizzle-orm';
import { scheduleAssignments, scheduleShiftRows } from '../../shared/schema';

/** A retired row keeps its assignments for history. Its end date is inclusive. */
export function shiftRowEffectiveOn(date: string | typeof scheduleAssignments.shiftDate) {
  return and(
    or(isNull(scheduleShiftRows.activeFromDate), lte(scheduleShiftRows.activeFromDate, date)),
    or(isNull(scheduleShiftRows.activeUntilDate), gte(scheduleShiftRows.activeUntilDate, date)),
  );
}
