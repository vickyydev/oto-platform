import type { Logger } from 'pino';

/**
 * Error-reporting hook (CLAUDE.md §3, Observability): pointable at Sentry via
 * SENTRY_DSN, a structured-log no-op when unset. The SDK wiring lands when a
 * DSN is first configured — the seam exists now so call sites never change.
 */
export interface ErrorReporter {
  report(error: unknown, context?: Record<string, unknown>): void;
}

export function buildErrorReporter(sentryDsn: string | undefined, log: Logger): ErrorReporter {
  if (!sentryDsn) {
    return {
      report(error, context) {
        log.error({ err: error, ...context }, 'unhandled error (error reporting disabled)');
      },
    };
  }
  // SENTRY_DSN set: forward through the log for now and tag it for the
  // aggregator; @sentry/node initialisation slots in here.
  return {
    report(error, context) {
      log.error({ err: error, sentry: true, ...context }, 'unhandled error');
    },
  };
}
