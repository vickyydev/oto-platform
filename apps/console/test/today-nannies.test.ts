import { describe, expect, it } from 'vitest';
import {
  APP_STATE_NOTE,
  alsoMatchesLine,
  loadText,
  logLineText,
  shiftHours,
  shiftOver,
  unmatchedLine,
} from '../src/components/care/todayNannies';

/**
 * SCRUM-699 — the words of the "Today's nannies" card: shift hours in the
 * park's own time, and the audit rows as the quiet log reads them.
 */

const at = '2026-11-02T03:00:00.000Z';
const fah = { branchId: 'b', businessDate: '2026-11-02', nannyId: 'n', name: 'Fah' };

describe('Today’s nannies — the hours', () => {
  it('says a shift in the park’s own time, across midnight too', () => {
    // 03:00Z-12:00Z is 10:00-19:00 in Bangkok (UTC+7, no daylight saving).
    expect(shiftHours('2026-11-02T03:00:00.000Z', '2026-11-02T12:00:00.000Z', 'Asia/Bangkok')).toBe(
      '10:00–19:00',
    );
    // 15:00Z-19:00Z is 22:00 that day to 02:00 the next.
    expect(shiftHours('2026-11-02T15:00:00.000Z', '2026-11-02T19:00:00.000Z', 'Asia/Bangkok')).toBe(
      '22:00–02:00',
    );
    // The same instants read in London (UTC+0 in November).
    expect(
      shiftHours('2026-11-02T03:00:00.000Z', '2026-11-02T12:00:00.000Z', 'Europe/London'),
    ).toBe('03:00–12:00');
  });

  it('knows when a shift is over, at its end and after', () => {
    expect(shiftOver({ endsAt: '2026-11-02T12:00:00.000Z' }, '2026-11-02T12:00:00.000Z')).toBe(
      true,
    );
    expect(shiftOver({ endsAt: '2026-11-02T12:00:00.000Z' }, '2026-11-02T13:00:00.000Z')).toBe(
      true,
    );
    expect(shiftOver({ endsAt: '2026-11-02T12:00:00.000Z' }, '2026-11-02T11:59:00.000Z')).toBe(
      false,
    );
  });

  it('counts children, and names what else matches', () => {
    expect(loadText(0)).toBe('0 children');
    expect(loadText(1)).toBe('1 child');
    expect(loadText(2)).toBe('2 children');
    expect(alsoMatchesLine(['พี่เลี้ยง'])).toBe('พี่เลี้ยง also matches');
    expect(alsoMatchesLine([])).toBeNull();
  });

  it('says every unmatched entry, with or without a name', () => {
    expect(unmatchedLine({ name: 'Nok', reason: 'casual_worker' })).toBe(
      'Nok — a casual worker, not an employee, so not added as a nanny',
    );
    expect(unmatchedLine({ name: null, reason: 'no_employee_row' })).toBe(
      'Somebody on the rota — the OTO App has no employee record for this shift',
    );
    expect(APP_STATE_NOTE.ok).toBeNull();
    for (const state of ['app_not_installed', 'no_app_branch', 'ambiguous_app_branch'] as const) {
      expect(APP_STATE_NOTE[state]).toMatch(/add today’s nannies by hand\.$/i);
    }
  });
});

describe('Today’s nannies — the log', () => {
  const tz = 'Asia/Bangkok';
  const shift = { startsAt: '2026-11-02T03:00:00.000Z', endsAt: '2026-11-02T12:00:00.000Z' };

  it('reads an assignment, with its hours when the time zone is known', () => {
    const line = {
      at,
      action: 'nanny_duty.assign',
      actorAccountId: null,
      detail: { ...fah, ...shift, source: 'app_schedule', nannyCreated: true },
    };
    expect(logLineText(line, tz)).toBe('Fah on today’s nannies, 10:00–19:00 · rota sync');
    expect(logLineText(line)).toBe('Fah on today’s nannies · rota sync');
    expect(
      logLineText(
        {
          at,
          action: 'nanny_duty.assign',
          actorAccountId: 'a',
          detail: { ...fah, ...shift, source: 'manual' },
        },
        tz,
      ),
    ).toBe('Fah on today’s nannies, 10:00–19:00 · added by hand');
  });

  it('reads a removal, and a shift cut short', () => {
    expect(
      logLineText(
        {
          at,
          action: 'nanny_duty.unassign',
          actorAccountId: null,
          detail: { ...fah, ...shift, source: 'app_schedule' },
        },
        tz,
      ),
    ).toBe('Fah’s shift taken off today’s nannies, 10:00–19:00 · rota sync');
    expect(
      logLineText(
        {
          at,
          action: 'nanny_duty.unassign',
          actorAccountId: 'a',
          detail: {
            ...fah,
            ...shift,
            endsAt: '2026-11-02T07:20:00.000Z',
            source: 'manual',
            cutShort: true,
          },
        },
        tz,
      ),
    ).toBe('Fah’s shift cut short at 14:20 · added by hand');
  });

  it('reads new hours, a new name, a sync and a rule change', () => {
    expect(
      logLineText(
        {
          at,
          action: 'nanny_duty.reshift',
          actorAccountId: null,
          detail: { ...fah, ...shift, source: 'app_schedule' },
        },
        tz,
      ),
    ).toBe('Fah: hours updated from the rota, 10:00–19:00');
    expect(
      logLineText({
        at,
        action: 'nanny_duty.rename',
        actorAccountId: null,
        detail: { ...fah, name: 'Fah K.', source: 'app_schedule' },
      }),
    ).toBe('Fah K.: name updated from the rota');
    expect(
      logLineText({
        at,
        action: 'nanny_duty.sync',
        actorAccountId: null,
        detail: {
          branchId: 'b',
          businessDate: '2026-11-02',
          appState: 'ok',
          added: 2,
          removed: 1,
          renamed: 0,
          reshifted: 1,
          unmatched: [{ name: null, reason: 'no_name' }],
        },
      }),
    ).toBe('Synced from the OTO App · 2 added, 1 removed, 1 with new hours, 1 not matched');
    expect(
      logLineText({
        at,
        action: 'nanny_duty.sync',
        actorAccountId: null,
        detail: { appState: 'no_app_branch', added: 0, removed: 0 },
      }),
    ).toBe('Sync ran, but the rota could not be read');
    expect(
      logLineText({
        at,
        action: 'nanny_duty.rule',
        actorAccountId: 'a',
        detail: { matchText: 'Nanny team' },
      }),
    ).toBe('How nannies are found on the rota was changed');
    expect(
      logLineText({ at, action: 'nanny_duty.unknown', actorAccountId: null, detail: null }),
    ).toBe('nanny_duty.unknown');
  });
});
