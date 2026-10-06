import type { SettlementSummary } from '@oto/shared';
import { api } from './client';

export type { SettlementSummary };
const path = (branchId: string) => `/branches/${encodeURIComponent(branchId)}/settlements`;

export const settlementsApi = {
  read: (branchId: string, date: string) =>
    api.get<SettlementSummary>(`${path(branchId)}?${new URLSearchParams({ date })}`),
  run: (branchId: string, date: string, deviceId: string, idempotencyKey: string) =>
    api.post<{ batchId: string; commandId: string; state: 'pending' }>(
      `${path(branchId)}/terminal-runs`,
      { date, deviceId },
      { idempotencyKey },
    ),
  export: (branchId: string, date: string, tid: string) =>
    api.getBlob(`${path(branchId)}/export?${new URLSearchParams({ date, tid })}`),
};

export function settlementWord(state: string): string {
  return (
    (
      {
        pending: 'Waiting for terminal',
        matched: 'Matched',
        attention: 'Needs review',
        failed: 'Failed',
        unsupported: 'Not supported by this terminal',
        unmatched: 'No matching payment',
        amount_mismatch: 'Amount differs',
        ambiguous: 'More than one matching payment',
        reference_mismatch: 'References differ',
      } as Record<string, string>
    )[state] ?? state
  );
}
