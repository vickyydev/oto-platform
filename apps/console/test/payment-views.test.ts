import { describe, expect, it } from 'vitest';
import type { ConfigurationEntry } from '@/api/consoleConfiguration';
import type { MoneyCashDay, MoneySettlement } from '@/api/moneyOversight';
import { cashDaysForView, configurationGroups, settlementDaysForView } from '@/lib/paymentViews';

const entry = (key: string, appOwner: string, label: string): ConfigurationEntry => ({
  id: key, key, label, appOwner, editableHere: appOwner === 'platform', supported: true,
  requiredPermission: 'catalog:menu:manage', scope: 'operator', branchIds: [], url: '/catalogue/tenders',
  openInApp: null, lastChangedAt: null, lastChangedAvailability: 'unsupported',
});
const cashDay = (verdict: 'ok' | 'off' | 'pending', date: string): MoneyCashDay => ({
  businessDate: date, available: true, status: 'open', verdict, floatSatang: 600000, countedSatang: null,
  floatLeftSatang: null, paidOutSatang: 0, safeDropSatang: 0, totalExpectedSatang: 10000,
  totalActualSatang: 0, totalDifferenceSatang: -10000, linesOff: 0, lines: [], closedBy: null, closedAt: null, provisionalBoxes: 0,
});
type SettlementDay = MoneySettlement['branches'][number]['days'][number];
const settled = (date: string): SettlementDay => ({ businessDate: date, gateway: { state: 'matched', files: 1 },
  terminals: [], matched: 1, unmatchedLines: [], unmatchedAttempts: [] });

describe('loaded payment views (SCRUM-683)', () => {
  it('groups only supplied entries by owner and preserves native order within each owner', () => {
    const rows = Object.freeze([entry('a', 'platform', 'Tenders'), entry('b', 'inbox', 'Message templates'), entry('c', 'platform', 'Tax')]);
    const groups = configurationGroups(rows, '');
    expect(groups.map(group => [group.owner, group.entries.map(row => row.key)])).toEqual([['platform', ['a', 'c']], ['inbox', ['b']]]);
    expect(groups[0]!.entries[0]).toBe(rows[0]);
    expect(rows.map(row => row.key)).toEqual(['a', 'b', 'c']);
  });
  it('searches name, key and human owner label without adding a destination or changing an entry', () => {
    const rows = [entry('tenders', 'platform', 'Accepted methods'), entry('hr', 'oto_app', 'Staff settings')];
    expect(configurationGroups(rows, '  TENDERS  ')[0]!.entries).toEqual([rows[0]]);
    expect(configurationGroups(rows, 'oto app')[0]!.entries[0]).toBe(rows[1]);
    expect(configurationGroups(rows, 'not in this reading')).toEqual([]);
    expect(rows[0]!.url).toBe('/catalogue/tenders');
  });
  it('cash attention retains unavailable and not-counted days, excluding only matched days', () => {
    const rows: MoneyCashDay[] = [cashDay('ok', '2026-10-01'), cashDay('off', '2026-10-02'),
      cashDay('pending', '2026-10-03'), { businessDate: '2026-10-04', available: false, code: 'UNREAD', reason: 'ZZ TEST unavailable' }];
    const before = JSON.stringify(rows);
    expect(cashDaysForView(rows, true)).toEqual(rows.slice(1));
    expect(cashDaysForView(rows, false)).toEqual(rows);
    expect(cashDaysForView(rows, true)[0]).toBe(rows[1]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('settlement attention keeps no-file, unmatched and uncompleted native states without changing evidence', () => {
    const rows: SettlementDay[] = [settled('2026-10-01'), { ...settled('2026-10-02'), gateway: { state: 'no_file', files: 0 } },
      { ...settled('2026-10-03'), unmatchedAttempts: [{ method: 'qr', amountSatang: 7000, tid: null, status: 'approved', attemptId: null, trace: null }] },
      { ...settled('2026-10-04'), terminals: [{ label: 'ZZ TEST terminal', tid: null, provider: 'simulator', state: 'failed', batches: 1 }] }];
    const before = JSON.stringify(rows);
    expect(settlementDaysForView(rows, true)).toEqual(rows.slice(1));
    expect(settlementDaysForView(rows, false)).toEqual(rows);
    expect(settlementDaysForView(rows, true)[1]).toBe(rows[2]);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
