import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOAT, type EndOfDayRecord, type EodReceipt, type EodStrandedRow } from '@oto/shared';
import { api } from '@/api/client';
import { closeBodyOf, reprintEndOfDayReceipt, resolveStrandedRow } from '@/api/endOfDay';
import { EodReceiptCard } from '@/components/eod/EodReceiptCard';
import { ProvisionalBanner } from '@/components/eod/ProvisionalBanner';
import { StrandedList } from '@/components/eod/StrandedList';
import { settlementsApi, type SettlementSummary } from '@/api/settlements';
import { SettlementResults } from '@/components/eod/SettlementPanel';

/**
 * S2-15a round 2 — the UI additions on the End of Day tab: the provisional
 * banner, who is still counted inside with a resolve per row and the manager's
 * override, and a closed day's receipt with Reprint; and what the till sends.
 */

Object.assign(globalThis, { React });

afterEach(() => {
  vi.restoreAllMocks();
});

const BRANCH = '0192f000-0000-7000-8000-00000000b001';
const MANAGER = '0192f000-0000-7000-8000-00000000a004';
const STATION = '0192f000-0000-7000-8000-00000000c001';

describe('End of Day settlement evidence', () => {
  it('keeps unmatched, differing and unsupported evidence visibly separate from success', () => {
    const data: SettlementSummary = {
      branchId: BRANCH, date: '2026-10-06', devices: [],
      batches: [{ id: STATION, source: 'terminal', state: 'unsupported', deviceId: STATION,
        tid: 'TID-TEST', createdAt: '2026-10-06T10:00:00Z', completedAt: null, matched: 0, unmatched: 0, mismatched: 0 }],
      lines: [{ id: 'line', batchId: 'batch', attemptId: null, method: 'card', amountSatang: 12550, tid: 'TID-TEST', approvalCode: null,
        invoiceNo: 'fixture-invoice', terminalRef: 'terminal-reference-only', tranRef: null, transactionType: 'payment', match: 'amount_mismatch' }],
      unmatchedAttempts: [{ id: 'attempt', method: 'qr', amountSatang: 5000, tid: null, invoiceNo: null, status: 'awaiting_settlement' }],
    };
    const html = markup(React.createElement(SettlementResults, { data }));
    expect(html).toContain('Not supported by this terminal');
    expect(html).toContain('No payments were marked settled.');
    expect(html).toContain('Amount differs');
    expect(html).toContain('terminal-reference-only');
    expect(html).toContain('125.50');
    expect(html).toContain('Payments without a matched settlement (1)');
    expect(html).toContain('Awaiting settlement');
  });

  it('sends the selected park, day and device with the same identity on a retry', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    await settlementsApi.run(BRANCH, '2026-10-06', STATION, 'one-press');
    await settlementsApi.run(BRANCH, '2026-10-06', STATION, 'one-press');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(2, `/branches/${BRANCH}/settlements/terminal-runs`,
      { date: '2026-10-06', deviceId: STATION }, { idempotencyKey: 'one-press' });
  });

  it('exports one selected terminal and encodes its TID without widening the date filter', async () => {
    const get = vi.spyOn(api, 'getBlob').mockResolvedValue(new Blob(['fixture']));
    await settlementsApi.export(BRANCH, '2026-10-06', 'TID & 1');
    expect(get).toHaveBeenCalledWith(`/branches/${BRANCH}/settlements/export?date=2026-10-06&tid=TID+%26+1`);
    await settlementsApi.export(BRANCH, '2026-10-06');
    expect(get).toHaveBeenLastCalledWith(`/branches/${BRANCH}/settlements/export?date=2026-10-06`);
  });
});

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const bandRow: EodStrandedRow = {
  kind: 'band',
  subjectId: '0192f000-0000-7000-8000-0000000b0001',
  bandCode: 'A7K2Q',
  childName: null,
  childrenWithBand: 2,
  lastGateEvent: { kind: 'entry', at: '2026-10-02T09:00:00.000Z', stationName: 'Gate North' },
  checkedInAt: null,
  sale: { saleId: '0192f000-0000-7000-8000-0000000c0001', receiptNumber: 'T1-000042' },
  guardian: { name: 'Khun Malee', phone: '+66811112222' },
};

const childRow: EodStrandedRow = {
  kind: 'checkin',
  subjectId: '0192f000-0000-7000-8000-0000000d0001',
  bandCode: null,
  childName: 'Ploy',
  childrenWithBand: 0,
  lastGateEvent: null,
  checkedInAt: '2026-10-02T08:00:00.000Z',
  sale: null,
  guardian: { name: 'Khun Somchai', phone: null },
};

describe('eod-r2 the provisional banner', () => {
  it('names each box and what it is waiting on; nothing at all when no box holds the day', () => {
    const html = markup(
      React.createElement(ProvisionalBanner, {
        boxes: [
          { boxId: STATION, name: 'Counter Pi', reason: 'outbox', waiting: 3, since: null, message: 'Counter Pi has 3 records it has not sent yet.' },
        ],
        onRecheck: () => {},
      }),
    );
    expect(html).toContain('Day is provisional.');
    expect(html).toContain('Counter Pi has 3 records it has not sent yet.');
    expect(html).toContain('Check again');
    expect(markup(React.createElement(ProvisionalBanner, { boxes: [], onRecheck: () => {} }))).toBe('');
  });
});

describe('eod-r2 who is still counted inside', () => {
  const base = {
    override: null,
    resolving: null,
    error: null,
    overrideReason: '',
    onOverrideReason: () => {},
    onResolve: () => {},
  };

  it('lists each row with its gate event, sale and guardian, and the three reasons to resolve it', () => {
    const html = markup(React.createElement(StrandedList, { ...base, rows: [bandRow, childRow], readOnly: false, canOverride: false }));
    expect(html).toContain('Still counted inside');
    expect(html).toContain('Band A7K2Q');
    expect(html).toContain('+ 2 children');
    expect(html).toContain('Gate North');
    expect(html).toContain('Sale T1-000042');
    expect(html).toContain('Guardian: Khun Malee · +66811112222');
    expect(html).toContain('Ploy');
    expect(html).toContain('Left without scanning');
    expect(html).toContain('Band lost');
    expect(html).toContain('Gate fault');
    // Reception sees no override field, only how to get past the rows.
    expect(html).not.toContain('Manager override');
    expect(html).toContain('ask a manager to close the day with a reason');
  });

  it('a manager is offered the override reason', () => {
    const html = markup(React.createElement(StrandedList, { ...base, rows: [bandRow], readOnly: false, canOverride: true }));
    expect(html).toContain('Manager override');
  });

  it('a closed day shows the override it was closed under, with its rows and no actions', () => {
    const html = markup(
      React.createElement(StrandedList, {
        ...base,
        rows: [],
        readOnly: true,
        canOverride: true,
        override: { by: { accountId: MANAGER, name: 'Khun Lek' }, reason: 'Gate lost power', at: '2026-10-02T14:00:00.000Z', stranded: [bandRow] },
      }),
    );
    expect(html).toContain('Closed by manager override.');
    expect(html).toContain('Gate lost power — Khun Lek');
    expect(html).toContain('Band A7K2Q');
    expect(html).not.toContain('Band lost');
    // Nobody stranded and no override: the tab is as round 1 left it.
    expect(markup(React.createElement(StrandedList, { ...base, rows: [], readOnly: false, canOverride: true }))).toBe('');
  });
});

describe('eod-r2 the End of Day receipt', () => {
  const receipt: EodReceipt = {
    number: 'T1-EOD-000001',
    stationId: STATION,
    stationName: 'Reception Till 1',
    jobs: [
      { id: '0192f000-0000-7000-8000-0000000e0001', status: 'printed', reprint: false, deviceLabel: 'Receipt printer', errorMessage: null, queuedAt: '2026-10-02T14:00:00.000Z' },
      { id: '0192f000-0000-7000-8000-0000000e0002', status: 'queued', reprint: true, deviceLabel: 'Receipt printer', errorMessage: null, queuedAt: '2026-10-02T15:00:00.000Z' },
    ],
    note: null,
  };

  it('shows the number, the counter, the last print and Reprint', () => {
    const html = markup(React.createElement(EodReceiptCard, { receipt, reprinting: false, error: null, onReprint: () => {} }));
    expect(html).toContain('End of Day receipt T1-EOD-000001');
    expect(html).toContain('Reception Till 1 · sent to the printer on Receipt printer');
    expect(html).toContain('1 copy');
    expect(html).toContain('Reprint');
  });

  it('a day closed away from a printing counter shows the waiting receipt with Reprint', () => {
    const html = markup(
      React.createElement(EodReceiptCard, {
        receipt: { number: null, stationId: null, stationName: null, jobs: [], note: 'Receipt not printed — reprint it from a counter' },
        reprinting: false,
        error: null,
        onReprint: () => {},
      }),
    );
    expect(html).toContain('End of Day receipt</div>');
    expect(html).toContain('<div class="text-amber-600">Receipt not printed — reprint it from a counter</div>');
    expect(html).toContain('Reprint');
  });
});

describe('eod-r2 what the till sends', () => {
  const open: EndOfDayRecord = {
    id: `eod-${BRANCH}-2026-10-02`,
    branchId: BRANCH,
    date: '2026-10-02',
    status: 'open',
    lines: [{ channel: 'cash', expectedSatang: 100_00, actualSatang: null, differenceSatang: 0 }],
    cashCount: { countedSatang: null, floatSatang: DEFAULT_FLOAT, cashIncomeSatang: null },
    floatFromDate: null,
    floatLeftSatang: DEFAULT_FLOAT,
    vouchers: { handedOut: null, redeemed: null },
    totalExpectedSatang: 100_00,
    totalActualSatang: 0,
    totalDifferenceSatang: 0,
    notes: null,
    closedBy: null,
    closedAt: null,
    terminals: [],
    cashMovements: [],
  };

  it('Close Day carries the counter and a manager’s reason only when there is one', () => {
    expect(closeBodyOf(open)).not.toHaveProperty('stationId');
    expect(closeBodyOf(open)).not.toHaveProperty('override');
    expect(closeBodyOf(open, { stationId: STATION, overrideReason: '  ' })).not.toHaveProperty('override');
    expect(closeBodyOf(open, { stationId: STATION, overrideReason: ' Gate lost power ' })).toMatchObject({
      stationId: STATION,
      override: { reason: 'Gate lost power' },
    });
  });

  it('resolve and reprint go to their routes with one key per press', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    await resolveStrandedRow(BRANCH, { date: '2026-10-02', kind: 'band', subjectId: bandRow.subjectId, reason: 'band_lost', actionId: 'press-1' }, 'key-1');
    expect(post).toHaveBeenCalledWith(
      `/branches/${BRANCH}/end-of-day/stranded/resolve`,
      expect.objectContaining({ reason: 'band_lost', actionId: 'press-1' }),
      { idempotencyKey: 'key-1' },
    );
    await reprintEndOfDayReceipt(BRANCH, { date: '2026-10-02', stationId: STATION }, 'key-2');
    expect(post).toHaveBeenCalledWith(`/branches/${BRANCH}/end-of-day/reprint`, { date: '2026-10-02', stationId: STATION }, { idempotencyKey: 'key-2' });
  });
});
