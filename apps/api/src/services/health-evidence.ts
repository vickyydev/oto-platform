import { pgErrorOf } from '../lib/scrub';

/**
 * SCRUM-645 / planner ruling Q26 — A READ THAT FAILED IS NOT AN EMPTY ANSWER.
 *
 * The Health and Integrations reads gather their evidence from several
 * tables: the job register, the fleet, the open alerts, the operational
 * record. Each of those reads used to run through `probe`, which answers a
 * fallback when the read throws or is slow — and the fallback was an EMPTY
 * list. An empty alert list is exactly what a healthy estate looks like, so a
 * database role refused the alert table, or an alert read that timed out,
 * produced a confident `ok` over a critical alert nobody could see (the
 * confirmed finding in `test/health-read-availability-review.test.ts`).
 *
 * This keeps the deadline `probe` gives — a read must still never take the
 * page down — and keeps the fact that the read did not happen. The caller
 * receives either the value or an availability verdict, and carries the
 * verdict into its answer:
 *
 *   - `ok`      the read answered;
 *   - `denied`  the database refused it (SQLSTATE 42501, insufficient
 *               privilege) — a grant, not an outage;
 *   - `failed`  it threw for any other reason, or did not answer in time;
 *   - `unknown` the read was not attempted, so nothing can be said either way.
 *
 * Nothing about the error itself leaves here: the verdict and a fixed phrase,
 * never a message, a table name from a driver string or a parameter.
 */
export type ReadAvailability = 'ok' | 'failed' | 'denied' | 'unknown';

export type EvidenceRead<T> =
  | { ok: true; value: T }
  | { ok: false; availability: 'failed' | 'denied'; detail: string };

/** The same deadline `probe` gives: shorter than the pool's own wait. */
const READ_TIMEOUT_MS = 2_000;

const DENIED = 'the database refused this read';
const FAILED = 'the read failed';
const TIMED_OUT = 'the read did not answer in time';

class ReadTimedOut extends Error {}

/** Run one evidence read under a deadline, and say what became of it. */
export async function readEvidence<T>(work: () => Promise<T>, ms = READ_TIMEOUT_MS): Promise<EvidenceRead<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadTimedOut()), ms);
        timer.unref();
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof ReadTimedOut) return { ok: false, availability: 'failed', detail: TIMED_OUT };
    if (pgErrorOf(err)?.code === '42501') return { ok: false, availability: 'denied', detail: DENIED };
    return { ok: false, availability: 'failed', detail: FAILED };
  } finally {
    clearTimeout(timer);
  }
}

/** Where a piece of Health evidence came from, named for the page. */
export type HealthEvidenceSource = 'jobs' | 'fleet' | 'alerts' | 'watchdog' | 'occupancy';

export interface HealthEvidence {
  source: HealthEvidenceSource;
  label: string;
  availability: ReadAvailability;
  /** Null when the read answered; otherwise the fixed phrase above. */
  detail: string | null;
}

const LABELS: Record<HealthEvidenceSource, string> = {
  jobs: 'The job register',
  fleet: 'The boxes and their devices',
  alerts: 'The open alerts',
  watchdog: "The watchdog's last run",
  occupancy: 'The live occupancy count',
};

/** The verdict of one read, in the shape the snapshot carries. */
export function evidenceOf(source: HealthEvidenceSource, read: EvidenceRead<unknown>): HealthEvidence {
  return read.ok
    ? { source, label: LABELS[source], availability: 'ok', detail: null }
    : { source, label: LABELS[source], availability: read.availability, detail: read.detail };
}

/** Whether any consulted evidence could not be read — the one thing that forbids an all-clear. */
export function evidenceIncomplete(evidence: readonly HealthEvidence[]): boolean {
  return evidence.some((entry) => entry.availability !== 'ok');
}
