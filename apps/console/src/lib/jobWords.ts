import type { JobStatus } from '@/api/observability';
import { toneForOutcome, type Tone } from '@/components/Status';

/**
 * SCRUM-594 — HOW A JOB THAT IS OFF READS ON THE HEALTH PAGE.
 *
 * The Inbox retention purges are built and switched off: each refuses to run
 * while its `INBOX_*_RETENTION_DAYS` variable is unset, and says so in its
 * run's detail. Until the API carried that onto the jobs snapshot
 * (`lastOutcome: 'refused'`, `waitingOn: [...]`) the row read "ok", which is
 * the one word it must never say about a purge that has not purged. These are
 * the words the row draws from the snapshot instead:
 *
 *   the chip     "off" in the quiet tone when the whole run refused — not a
 *                warning and not a failure: the platform did what the
 *                configuration asked — else the runner's own word as before
 *   the line     "waiting on INBOX_…" naming each variable, under the row,
 *                whenever the last run reported any part of itself refused
 */
export interface JobOutcomeChip {
  label: string;
  tone: Tone;
}

/** The chip beside the job's name, or none when the job has never run. */
export function jobOutcomeChip(job: Pick<JobStatus, 'lastOutcome' | 'waitingOn'>): JobOutcomeChip | null {
  if (!job.lastOutcome) return null;
  if (job.lastOutcome === 'refused') return { label: 'off', tone: 'idle' };
  return { label: job.lastOutcome, tone: toneForOutcome(job.lastOutcome) };
}

/** The line under the row that names what the job is waiting on, or none. */
export function jobWaitingLine(job: Pick<JobStatus, 'waitingOn'>): string | null {
  const variables = job.waitingOn ?? [];
  if (variables.length === 0) return null;
  return `off — waiting on ${variables.join(', ')}`;
}
