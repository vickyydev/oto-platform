// SCRUM-825 — a party's deposit asked from the BEO and watched by the
// platform, on the thread: the eight pills the api writes beside the
// assistant's lines (ids and figures in their payloads, never the link), the
// deposit's word on the event chip beside the date, and the money as the till
// writes it. Node, no DOM: pure functions.
import { describe, expect, it } from 'vitest';
import type { InboxEvent, InboxMe } from '@/api/inbox';
import { depositChipWords, eventChipLabel } from '@/lib/beo';
import { bahtOf, collapsePills, eventText, timeline, type TimelineItem } from '@/lib/view';

const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const me: Pick<InboxMe, 'people' | 'teams'> = {
  teams: [{ id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: true }],
  people: [{ accountId: 'acc-1', name: 'Anya', teamIds: [T_BIRTHDAYS], operatorWide: false }],
};
const ctx = { me };
const REQUEST = '0192f0a0-1234-7abc-8def-00000000d825';

function ev(over: Partial<InboxEvent>): InboxEvent {
  return {
    id: 'e1',
    kind: 'deposit_requested',
    actorKind: 'ai',
    actorAccountId: null,
    actorName: null,
    payload: { requestId: REQUEST, eventId: 'ev-1', amountSatang: 300_000, currency: 'THB', linkExpiresAt: '2026-11-14T08:02:00.000Z' },
    createdAt: '2026-11-11T08:00:00.000Z',
    ...over,
  };
}

describe('money as the till writes it', () => {
  it('฿3,000 for 300,000 satang; cents only when there are some; nothing for a figure that is not one', () => {
    expect(bahtOf(300_000)).toBe('฿3,000');
    expect(bahtOf(12_550)).toBe('฿125.50');
    expect(bahtOf(1_690_000)).toBe('฿16,900');
    expect(bahtOf(0)).toBe('฿0');
    expect(bahtOf(-300_000)).toBe('-฿3,000');
    expect(bahtOf('3000')).toBe('');
    expect(bahtOf(undefined)).toBe('');
  });
});

describe('the deposit pills (SCRUM-825)', () => {
  it('says each step of the request with its amount, and never the link', () => {
    expect(eventText(ev({ kind: 'deposit_requested' }), ctx)).toBe('Deposit requested ฿3,000');
    expect(eventText(ev({ kind: 'deposit_requested', payload: { amountSatang: 300_000, resend: true } }), ctx)).toBe('Deposit requested ฿3,000 · resent');
    expect(eventText(ev({ kind: 'deposit_reminded' }), ctx)).toBe('Deposit reminder sent · ฿3,000 still unpaid');
    expect(eventText(ev({ kind: 'deposit_paid', payload: { amountSatang: 300_000, late: false, source: 'webhook' } }), ctx)).toBe('Deposit paid ฿3,000');
    expect(eventText(ev({ kind: 'deposit_paid', payload: { amountSatang: 300_000, late: true } }), ctx)).toBe('Deposit paid ฿3,000 · after the request was closed');
    expect(eventText(ev({ kind: 'deposit_expired', payload: { amountSatang: 300_000, reason: 'gateway_expired' } }), ctx)).toBe('Deposit link ran out unpaid · ฿3,000');
    expect(
      eventText(ev({ kind: 'deposit_cancelled', actorKind: 'account', actorAccountId: 'acc-1', actorName: 'Anya', payload: { amountSatang: 300_000, reason: 'staff' } }), ctx),
    ).toBe('Deposit request cancelled by Anya · ฿3,000');
    expect(eventText(ev({ kind: 'deposit_overdue', payload: { amountSatang: 300_000, reroutedTeamId: T_BIRTHDAYS } }), ctx)).toBe(
      'Deposit overdue ฿3,000 · handed to Birthdays & Events',
    );
    expect(eventText(ev({ kind: 'deposit_overdue', payload: { amountSatang: 300_000, reroutedTeamId: null } }), ctx)).toBe('Deposit overdue ฿3,000 · handed to the team');
    expect(eventText(ev({ kind: 'menu_link_sent', payload: { eventId: 'ev-1' } }), ctx)).toBe('Menu choice link sent');
    expect(eventText(ev({ kind: 'menu_received', payload: { eventId: 'ev-1', submittedAt: null } }), ctx)).toBe('Menu choices received from the family');
    for (const kind of ['deposit_requested', 'deposit_paid', 'deposit_overdue'] as const) {
      const text = eventText(ev({ kind, payload: { amountSatang: 300_000, link: 'https://pay.example/x', paymentLink: 'https://pay.example/y' } }), ctx)!;
      expect(text).not.toContain('pay.example');
    }
  });

  it('sits on the timeline as a pill beside the assistant’s line, and heads a run it shares with the router', () => {
    const pill = ev({ kind: 'deposit_paid', createdAt: '2026-11-11T09:00:00.000Z', payload: { amountSatang: 300_000, late: false } });
    const routed = ev({ id: 'e2', kind: 'routed', actorKind: 'system', createdAt: '2026-11-11T09:00:01.000Z', payload: { teamId: T_BIRTHDAYS, language: 'en' } });
    const items = timeline([], [pill, routed], true, ctx);
    expect(items).toHaveLength(1);
    const group = items[0] as Extract<TimelineItem, { kind: 'group' }>;
    expect(group.kind).toBe('group');
    expect(group.summary).toContain('Deposit paid ฿3,000');
    expect(group.pills.map((p) => p.event)).toEqual(['deposit_paid', 'routed']);
    const alone = collapsePills(timeline([], [pill], true, ctx), new Map([[pill.id, pill]]), ctx);
    expect(alone).toEqual([{ kind: 'pill', at: pill.createdAt, id: 'e1', text: 'Deposit paid ฿3,000', event: 'deposit_paid' }]);
  });
});

describe('the event chip’s deposit word (SCRUM-825)', () => {
  it('names the request’s state beside the date; a cancelled request says nothing; an api without it changes nothing', () => {
    const base = { date: '2026-11-18', branchName: 'Central Floresta' };
    expect(eventChipLabel(base)).toBe('Event: 18 Nov 2026 at Central Floresta');
    expect(eventChipLabel({ ...base, deposit: null })).toBe('Event: 18 Nov 2026 at Central Floresta');
    expect(eventChipLabel({ ...base, deposit: { state: 'requested', amountSatang: 300_000, overdue: false } })).toBe(
      'Event: 18 Nov 2026 at Central Floresta · Deposit requested ฿3,000',
    );
    expect(eventChipLabel({ ...base, deposit: { state: 'requested', amountSatang: 300_000, overdue: true } })).toBe(
      'Event: 18 Nov 2026 at Central Floresta · Deposit overdue ฿3,000',
    );
    expect(eventChipLabel({ ...base, deposit: { state: 'paid', amountSatang: 300_000, overdue: false } })).toBe(
      'Event: 18 Nov 2026 at Central Floresta · Deposit paid ฿3,000',
    );
    expect(eventChipLabel({ ...base, deposit: { state: 'expired', amountSatang: 300_000, overdue: false } })).toBe(
      'Event: 18 Nov 2026 at Central Floresta · Deposit link expired',
    );
    expect(eventChipLabel({ ...base, deposit: { state: 'cancelled', amountSatang: 300_000, overdue: false } })).toBe('Event: 18 Nov 2026 at Central Floresta');
    expect(eventChipLabel({ ...base, archived: true, deposit: { state: 'paid', amountSatang: 300_000, overdue: false } })).toBe(
      'Event: 18 Nov 2026 at Central Floresta · Archived · Deposit paid ฿3,000',
    );
    expect(depositChipWords(undefined)).toBeNull();
    expect(depositChipWords({ state: 'paid', amountSatang: 12_550, overdue: false })).toBe('Deposit paid ฿125.50');
  });
});
