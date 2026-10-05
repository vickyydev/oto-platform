import type { SettlementSummary, SettlementBatchState } from '@oto/shared';
import { api } from './client';

export type { SettlementSummary };
export interface SettlementImportResult {
  batchId: string;
  replayed: boolean;
  state: SettlementBatchState;
  matched: number;
  unmatched: number;
  mismatched: number;
}
export const MAX_SETTLEMENT_FILE_BYTES = 2_000_000;
const path = (branchId: string) => `/branches/${encodeURIComponent(branchId)}/settlements`;
export const settlementApi = {
  read: (branchId: string, date: string) =>
    api.get<SettlementSummary>(`${path(branchId)}?${new URLSearchParams({ date })}`),
  import: (branchId: string, date: string, fileName: string, csv: string, idempotencyKey: string) =>
    api.post<SettlementImportResult>(
      `${path(branchId)}/2c2p-import`,
      { date, fileName, csv },
      { idempotencyKey },
    ),
};
