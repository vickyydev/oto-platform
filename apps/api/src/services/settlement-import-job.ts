import type { Db } from '@oto/db';
import { AppError } from '../lib/errors';
import { recordRun } from './ops';
import { import2c2pFixture } from './settlement';
import { withTx, type OpContext } from './tx';

/** A requested, one-shot fixture job. Real provider files and SFTP are outside S2-15a. */
export const SETTLEMENT_FIXTURE_IMPORT_JOB = 'job:settlement.2c2p_fixture_import';

export async function runSettlementFixtureImportJob(db: Db, ctx: OpContext, input: {
  operatorId: string;
  branchId: string;
  date: string;
  fileName: string;
  csv: string;
  accountId: string;
  requestId?: string;
}) {
  const startedAt = new Date();
  try {
    return await withTx(db, ctx, 'settlement.run', async (tx) => {
      // The import, its audit entry and the job result commit together. If the
      // process exits before commit, a retry safely runs the same file again.
      const result = await import2c2pFixture(tx, input);
      await recordRun(tx, {
        kind: 'job', name: SETTLEMENT_FIXTURE_IMPORT_JOB,
        outcome: result.replayed ? 'skipped' : 'ok', startedAt,
        requestId: input.requestId, operatorId: input.operatorId,
        branchId: input.branchId, actionId: result.batchId,
        detail: { source: '2c2p_fixture', businessDate: input.date,
          batchId: result.batchId, state: result.state, replayed: result.replayed,
          matched: result.matched, unmatched: result.unmatched, mismatched: result.mismatched },
      });
      return result;
    });
  } catch (err) {
    // A failed run must outlive the rolled-back import. Never record the CSV,
    // filename, references or the original error message in operational logs.
    try {
      await recordRun(db, {
        kind: 'job', name: SETTLEMENT_FIXTURE_IMPORT_JOB,
        outcome: 'failed', startedAt, requestId: input.requestId,
        operatorId: input.operatorId, branchId: input.branchId,
        error: new AppError(500, err instanceof AppError ? err.code : 'IMPORT_FAILED',
          'Settlement fixture import failed'),
        detail: { source: '2c2p_fixture', businessDate: input.date },
      });
    } catch (recordErr) {
      ctx.log?.error({ err: recordErr, job: SETTLEMENT_FIXTURE_IMPORT_JOB },
        'fixture import failure could not be recorded');
    }
    throw err;
  }
}
