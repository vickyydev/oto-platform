/**
 * What the sample adds on top of the park's own rows.
 *
 * The rows themselves are in `data.generated.ts` and come out of the park's
 * production export — `extract.ts` cuts them, and its header is where the
 * sampling rule and the list of what was deliberately left behind live.
 *
 * This file holds the three things that are the *sample's* and not the park's:
 * the address the real local parts are hung on, the banner that says so on the
 * announcements board, and the rule that puts a task or two in the signed-in
 * administrator's own list.
 *
 * Nothing here invents a person. The previous version of this file did — it
 * carried twenty-six made-up staff — and is gone. A deployment that ran that
 * version still has those rows: the seed never deletes, so they stay until
 * somebody removes them. They are the ones whose email ends in this domain and
 * whose phone number starts `+6695500`.
 */

export {
  ANNOUNCEMENTS,
  BRANCHES,
  DEPARTMENTS,
  OPERATOR,
  PEOPLE,
  ROLES,
  SAMPLE_COUNTS,
  SAMPLE_EMAIL_DOMAIN,
  TASKS,
  TENANT,
  TIME_EVENTS,
} from './data.generated';

export type {
  SampleAnnouncement,
  SampleBranch,
  SampleDepartment,
  SamplePerson,
  SampleRole,
  SampleTask,
  SampleTimeEvent,
} from './data.generated';

import { SAMPLE_EMAIL_DOMAIN, type SamplePerson } from './data.generated';

/**
 * The staff member's real mailbox name on a domain that cannot exist.
 *
 * `.test` is reserved by RFC 2606, so the address is deliverable nowhere. That
 * matters more than it sounds: the export's addresses are 61 personal Gmail
 * accounts, and an app that learns to send mail on a staging deployment would
 * otherwise reach sixty-one real people. The local part is kept because it is
 * no more identifying than the name printed beside it, and because it is what
 * makes the list read as a staff list rather than a fixture.
 *
 * It is also the seed's natural key. All sixty-nine local parts in the export
 * are distinct, so a re-run finds the person it wrote last time.
 */
export const emailFor = (p: Pick<SamplePerson, 'emailLocal'>): string =>
  `${p.emailLocal}@${SAMPLE_EMAIL_DOMAIN}`;

/**
 * Said on the board rather than in a README, because the person who opens this
 * deployment reads the board and not the repository.
 */
export const SAMPLE_BANNER = {
  title: 'This branch is carrying sampled data',
  body:
    'The staff, the clock-ins and the task board here are a sample of the real ones, ' +
    'taken for testing. Edit anything you like — it saves, and running the sample ' +
    'loader again will not undo your edit. Email addresses are not the real ones: ' +
    `every one of them ends in ${SAMPLE_EMAIL_DOMAIN}, a domain that cannot receive mail. ` +
    'Nobody here can sign in; these are staff records, not accounts.',
  priority: 'info' as const,
  days: 365,
};

/**
 * How many of the live tasks are put in the administrator's own list.
 *
 * The Today panel is a personal workspace, not a branch board:
 * `tasks/today` in `server/core/compat/tasksCompat.ts` keeps only what is
 * assigned to the signed-in person or to their department, and drops
 * role-only, branch-only and unassigned work by design. An administrator
 * signing in from the launcher has no employee record, so with the export's
 * own assignments — which are employee-level or nothing — Today reads
 * "No pending tasks" however many tasks were loaded, and that looks like a
 * fault when it is not one.
 *
 * This is the one field the seed sets that the export does not have, and it is
 * set on the two oldest live tasks so the choice is stable across runs.
 */
export const TASKS_OWNED_BY_ADMIN = 2;
