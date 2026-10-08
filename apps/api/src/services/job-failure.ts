import { AppError } from '../lib/errors';

/**
 * A job that failed having done part of its work (S2-17b round 3).
 *
 * The runner records a job's `detail` only on success; a job that throws gets
 * a failure row with its error and nothing else (`services/jobs.ts`). That is
 * right for a sweep that either worked or did not. It is wrong for a job that
 * runs several park groups' batches and has to say which of them failed and
 * which finished — the finished ones are a fact the next tick reads (a night
 * done once is not run again). So a job throws this instead, and the runner
 * writes `detail` on the failed run beside the error.
 *
 * The code is the Failures page's grouping key and the message is what it
 * shows, as with any AppError.
 */
export class JobFailedError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly detail: Record<string, unknown>,
  ) {
    super(502, code, message);
    this.name = 'JobFailedError';
  }
}
