import { describe, expect, it } from 'vitest';
import { presenceRecoveryTargets, remainingPresenceDeliveries, restorePresenceRequests, retryPresenceTarget, type LocalPresenceDelivery } from '../../oto-app/client/src/lib/presence-delivery';

// Pure request-selection checks: no app server, database or provider is imported.
const pending: LocalPresenceDelivery = {
  employeeId: 'employee-a', branchId: 'branch-a', shiftRowId: 'shift-a', shiftDate: '2000-01-02',
  requestKey: 'original-request', status: 'Pending', failureMessage: null, unconfirmed: true,
};

describe('Presence recovery outside live rows', () => {
  it('FINDING 8 medium: the original request remains retryable after both live rows disappear; prescribed fix: compact server-scoped recovery area', () => {
    expect(remainingPresenceDeliveries([pending], [pending.requestKey])).toEqual([]);
    const outside = remainingPresenceDeliveries([pending], []);
    expect(outside).toEqual([pending]);
    expect(presenceRecoveryTargets(outside)).toEqual([{ employeeId: 'employee-a', branchId: 'branch-a', shiftRowId: 'shift-a', shiftDate: '2000-01-02', requestKey: 'original-request' }]);
  });

  it('only server-returned targets appear when a local attempt is outside both tabs', () => {
    expect(presenceRecoveryTargets([pending])).toHaveLength(1);
    expect(remainingPresenceDeliveries([], [])).toEqual([]);
    const own = { ...pending, requestKey: 'verified-own' };
    expect(remainingPresenceDeliveries([own], []).map(row => row.requestKey)).toEqual(['verified-own']);
  });

  it('existing buttons are not duplicated while separate outstanding shifts remain available', () => {
    const other = { ...pending, shiftRowId: 'shift-b', requestKey: 'other-request' };
    expect(remainingPresenceDeliveries([pending, other], [pending.requestKey])).toEqual([other]);
    expect(retryPresenceTarget(other)?.shiftRowId).toBe('shift-b');
  });

  it('Delivered confirmation removes recovery while Failed keeps the same target', () => {
    expect(remainingPresenceDeliveries([{ ...pending, status: 'Delivered' }], [])).toEqual([]);
    const failed = { ...pending, status: 'Failed' as const, failureMessage: 'Try again' };
    expect(remainingPresenceDeliveries([failed], [])).toEqual([failed]);
    expect(presenceRecoveryTargets([failed])[0]?.requestKey).toBe(pending.requestKey);
  });

  it('reload recovery belongs to the same sender and submits only the target fields', () => {
    const entries = new Map([
      ['presence-ping-target:sender-a:employee-a:shift-a:2000-01-02', JSON.stringify({ ...pending, employeeName: 'ZZ TEST Name', extra: 'ZZ TEST local metadata' })],
      ['presence-ping-target:sender-b:employee-a:shift-a:2000-01-02', JSON.stringify({ ...pending, requestKey: 'different-sender' })],
    ]);
    const storage = { length: entries.size, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null };
    const restored = restorePresenceRequests(storage, 'sender-a');
    const targets = presenceRecoveryTargets(Object.values(restored));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({ employeeId: 'employee-a', branchId: 'branch-a', shiftRowId: 'shift-a', shiftDate: '2000-01-02', requestKey: 'original-request' });
  });
});
