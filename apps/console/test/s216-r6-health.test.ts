import { describe, expect, it } from 'vitest';
import { analyticsFreshnessLines } from '@/lib/analyticsFreshness';

/**
 * S2-15b round 6 closing sweep — Health's analytics card names every figure
 * set a park's screens read: the day (Today > Performance, Radar), the report
 * rows (Admin > Reports) and the booth fact (the booth report).
 */

const central = {
  branchId: '018f0000-0000-7000-8000-000000000001',
  name: 'Central',
  today: '2026-10-07',
  lastRolledUpAt: '2026-10-07T03:00:00.000Z',
  boothLastRolledUpAt: '2026-10-07T03:01:00.000Z',
  reportsLastRolledUpAt: '2026-10-07T03:00:00.000Z',
};
const chalong = {
  branchId: '018f0000-0000-7000-8000-000000000002',
  name: 'Chalong',
  today: '2026-10-07',
  lastRolledUpAt: null,
  boothLastRolledUpAt: null,
  reportsLastRolledUpAt: null,
};

describe('Health — the analytics freshness lines', () => {
  it('lists each park’s day, then its report figures, then its booth figures', () => {
    expect(analyticsFreshnessLines([central, chalong])).toEqual([
      { key: central.branchId, label: 'Central', at: central.lastRolledUpAt, today: '2026-10-07' },
      { key: chalong.branchId, label: 'Chalong', at: null, today: '2026-10-07' },
      { key: `reports-${central.branchId}`, label: 'Central · report figures', at: central.reportsLastRolledUpAt, today: '2026-10-07' },
      { key: `reports-${chalong.branchId}`, label: 'Chalong · report figures', at: null, today: '2026-10-07' },
      { key: `booth-${central.branchId}`, label: 'Central · booth figures', at: central.boothLastRolledUpAt, today: '2026-10-07' },
      { key: `booth-${chalong.branchId}`, label: 'Chalong · booth figures', at: null, today: '2026-10-07' },
    ]);
  });

  it('leaves out a line an older API does not report, rather than calling it never rolled up', () => {
    const { boothLastRolledUpAt: _booth, reportsLastRolledUpAt: _reports, ...old } = central;
    expect(analyticsFreshnessLines([old]).map((l) => l.label)).toEqual(['Central']);
  });
});
