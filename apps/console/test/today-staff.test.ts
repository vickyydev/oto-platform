import { describe, expect, it } from 'vitest';
import { initialOf, labelLine, logLineText, logTime } from '../src/components/booth/todayStaff';

/**
 * SCRUM-473 — the words of the "Today's staff" card: the label preview and
 * the audit rows as the quiet log reads them.
 */

describe('Today’s staff — the words', () => {
  it('previews the day’s label, and says plainly when there is none', () => {
    expect(labelLine('Tom and Jerry')).toBe('On every voucher today: Tom and Jerry');
    expect(labelLine(null)).toMatch(/unattributed/);
  });

  it('reads each log line as a person would', () => {
    const at = '2026-10-01T00:02:00.000Z';
    expect(
      logLineText({ at, action: 'booth_duty.assign', actorAccountId: null, detail: { displayName: 'Tom', source: 'app_schedule' } }),
    ).toBe('Tom assigned to today’s booth duty · rota sync');
    expect(
      logLineText({ at, action: 'booth_duty.assign', actorAccountId: null, detail: { displayName: 'Nok', source: 'self_assigned' } }),
    ).toBe('Nok assigned to today’s booth duty · signed in at the booth');
    expect(logLineText({ at, action: 'booth_duty.unassign', actorAccountId: null, detail: { displayName: 'Tom' } })).toBe(
      'Tom taken off today’s booth duty',
    );
    expect(
      logLineText({
        at,
        action: 'booth_duty.sync',
        actorAccountId: null,
        detail: { appState: 'ok', added: 2, removed: 0, unmatched: [{ name: 'Chai' }] },
      }),
    ).toBe('Synced from the OTO App · 2 added, 0 removed, 1 not matched');
    expect(
      logLineText({ at, action: 'booth_duty.sync', actorAccountId: null, detail: { appState: 'no_app_branch' } }),
    ).toBe('Sync ran, but the rota could not be read');
  });

  it('stamps the log in the branch’s own time, and badges a name by its first letter', () => {
    expect(logTime('2026-10-01T00:02:00.000Z', 'Asia/Bangkok')).toBe('07:02');
    expect(initialOf(' jerry')).toBe('J');
    expect(initialOf('')).toBe('?');
  });
});
