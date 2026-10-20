import { describe, expect, it } from 'vitest';
import { jobOutcomeChip, jobWaitingLine } from '@/lib/jobWords';

/**
 * SCRUM-594 — the Health page's job row for a job that is built but OFF.
 *
 * The Inbox retention job refuses each purge while its retention variable is
 * unset, and the snapshot now says so (`lastOutcome: 'refused'`,
 * `waitingOn`). The row must show that as "off — waiting on <variable>": a
 * quiet state, not "ok", not a warning, not a failure.
 */
const RETENTION_VARIABLES = [
  'INBOX_CONVERSATION_RETENTION_DAYS',
  'INBOX_MEDIA_RETENTION_DAYS',
  'INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS',
];

describe('jobOutcomeChip', () => {
  it('reads a refused run as "off" in the quiet tone — never ok, never a warning', () => {
    expect(jobOutcomeChip({ lastOutcome: 'refused', waitingOn: RETENTION_VARIABLES })).toEqual({
      label: 'off',
      tone: 'idle',
    });
  });

  it('keeps the runner’s own word and tone for every other outcome', () => {
    expect(jobOutcomeChip({ lastOutcome: 'ok', waitingOn: [] })).toEqual({ label: 'ok', tone: 'ok' });
    expect(jobOutcomeChip({ lastOutcome: 'failed', waitingOn: [] })).toEqual({ label: 'failed', tone: 'down' });
    // A run in which some parts ran and one is off keeps "ok" on the chip; the line names the rest.
    expect(jobOutcomeChip({ lastOutcome: 'ok', waitingOn: ['INBOX_MEDIA_RETENTION_DAYS'] })).toEqual({
      label: 'ok',
      tone: 'ok',
    });
  });

  it('draws no chip for a job that has never run', () => {
    expect(jobOutcomeChip({ lastOutcome: null, waitingOn: [] })).toBeNull();
    expect(jobOutcomeChip({ lastOutcome: undefined })).toBeNull();
  });
});

describe('jobWaitingLine', () => {
  it('names every variable the last run is waiting on', () => {
    expect(jobWaitingLine({ waitingOn: RETENTION_VARIABLES })).toBe(
      'off — waiting on INBOX_CONVERSATION_RETENTION_DAYS, INBOX_MEDIA_RETENTION_DAYS, INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS',
    );
    expect(jobWaitingLine({ waitingOn: ['INBOX_MEDIA_RETENTION_DAYS'] })).toBe('off — waiting on INBOX_MEDIA_RETENTION_DAYS');
  });

  it('draws no line when nothing is waiting, and none for an older API that does not report it', () => {
    expect(jobWaitingLine({ waitingOn: [] })).toBeNull();
    expect(jobWaitingLine({})).toBeNull();
  });
});
