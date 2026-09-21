/**
 * What the sample adds on top of the park's own rows.
 *
 * The rows themselves are in `data.generated.ts` and come out of the park's
 * production export — `extract.ts` cuts them, and its header is where the
 * sampling rule and the short list of what is deliberately left behind live.
 *
 * This file holds the two things that are the *sample's* and not the park's:
 * the banner that says the branch is carrying sampled data, and the rule that
 * puts a task or two in the signed-in administrator's own list.
 *
 * Nothing here invents a person. An earlier version of this file did — it
 * carried twenty-six made-up staff — and is gone. A deployment that ran that
 * version still has those rows: the seed never deletes, so they stay until
 * somebody removes them. They are the ones whose phone number starts
 * `+6695500` and whose address ends in {@link LEGACY_SAMPLE_EMAIL_DOMAIN}.
 */

export {
  ANNOUNCEMENTS,
  BRANCHES,
  DEPARTMENTS,
  LEGACY_SAMPLE_EMAIL_DOMAIN,
  OPERATOR,
  PEOPLE,
  ROLES,
  SAMPLE_COUNTS,
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

/**
 * Said on the board rather than in a README, because the person who opens this
 * deployment reads the board and not the repository.
 */
export const SAMPLE_BANNER = {
  title: 'This branch is carrying sampled data',
  body:
    'The staff, the clock-ins and the task board here are a sample of the real ones, ' +
    'taken for testing. Edit anything you like — it saves, and running the sample ' +
    'loader again will not undo your edit. Nobody here can sign in: these are staff ' +
    'records, not accounts, and no password, PIN or kiosk registration was copied. ' +
    'The clock-ins are real and stop on the day the export was taken, so a screen ' +
    'showing today will be empty until somebody clocks in — move the date back to ' +
    'see them.',
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
