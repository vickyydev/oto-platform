import { EventAttendee } from '@/types';

// Where an attendee sits on the active date's roster.
export type RosterBucket = 'in' | 'out' | 'outstanding' | 'notToday';

// The user-facing roster filter (search-compatible, applied on top of buckets).
export type RosterFilter = 'all' | 'in' | 'outstanding';

export const ROSTER_FILTERS: { value: RosterFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in', label: 'Checked in' },
  { value: 'outstanding', label: 'Outstanding' },
];

/**
 * Bucket a single attendee for the active check-in date.
 * Camps scope to today's session: a child not registered for `checkInDate`
 * lands in `notToday` and is excluded from the roster totals.
 */
export function bucketAttendee(
  attendee: EventAttendee,
  checkInDate: string,
  isCamp: boolean,
): RosterBucket {
  const rec = attendee.checkinByDate?.[checkInDate];
  if (rec?.checkedOutAt) return 'out';
  if (rec?.checkedInAt) return 'in';
  if (
    isCamp &&
    attendee.attendanceDays != null &&
    attendee.attendanceDays.length > 0 &&
    !attendee.attendanceDays.includes(checkInDate)
  ) {
    return 'notToday';
  }
  return 'outstanding';
}

export interface RosterGroups {
  inList: EventAttendee[];
  outList: EventAttendee[];
  outstandingList: EventAttendee[];
  notTodayList: EventAttendee[];
}

/**
 * Split attendees into their roster buckets for the active date.
 * Pass the already search-filtered list for rendering; pass the full list for stats.
 */
export function groupAttendees(
  attendees: EventAttendee[],
  checkInDate: string,
  isCamp: boolean,
): RosterGroups {
  const inList: EventAttendee[] = [];
  const outList: EventAttendee[] = [];
  const outstandingList: EventAttendee[] = [];
  const notTodayList: EventAttendee[] = [];
  for (const a of attendees) {
    const b = bucketAttendee(a, checkInDate, isCamp);
    if (b === 'in') inList.push(a);
    else if (b === 'out') outList.push(a);
    else if (b === 'notToday') notTodayList.push(a);
    else outstandingList.push(a);
  }
  return { inList, outList, outstandingList, notTodayList };
}

export interface RosterStats {
  arrived: number; // checked in + checked out (all who showed up)
  expected: number; // arrived + still outstanding (today's session only)
  currentlyIn: number; // still on premises
  outstanding: number; // not yet checked in
  all: number; // every bucket incl. not-in-today
}

/**
 * Headline progress over the FULL roster (independent of search/filter), so the
 * count stays stable while staff search. Camps reflect today's session only.
 */
export function computeRosterStats(
  attendees: EventAttendee[],
  checkInDate: string,
  isCamp: boolean,
): RosterStats {
  const { inList, outList, outstandingList, notTodayList } = groupAttendees(
    attendees,
    checkInDate,
    isCamp,
  );
  const inN = inList.length;
  const outN = outList.length;
  const outstandingN = outstandingList.length;
  return {
    arrived: inN + outN,
    expected: inN + outN + outstandingN,
    currentlyIn: inN,
    outstanding: outstandingN,
    all: inN + outN + outstandingN + notTodayList.length,
  };
}
