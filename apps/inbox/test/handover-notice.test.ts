// SCRUM-823: the hand-over pill says who was told, and only what reached a
// person — the birthday manager on duty when the bell (or a live ping) went,
// "manager not notified (…)" with the reason otherwise, the GM when an
// escalation reached them because nobody picked it up within fifteen minutes,
// and "GM not notified (…)" when it reached nobody. Node, no DOM.
import { describe, expect, it } from 'vitest';
import type { InboxEvent, InboxMe } from '@/api/inbox';
import { eventText, handoverNoticeNotes, timeline, type PillContext } from '@/lib/view';

const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const TURN = '00000000-0000-7000-8000-0000000000a1';
const me: Pick<InboxMe, 'people' | 'teams'> = {
  teams: [{ id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: true }],
  people: [],
};

const handover = (over: Partial<InboxEvent> = {}): InboxEvent => ({
  id: 'h1',
  kind: 'ai_handover',
  actorKind: 'ai',
  actorAccountId: null,
  actorName: null,
  payload: { turnId: TURN, intent: 'birthday_advice', reroutedTeamId: T_BIRTHDAYS },
  createdAt: '2026-11-10T07:05:00.000Z',
  ...over,
});

// 14:05 and 14:20 Bangkok.
const NOTIFIED = { turnId: TURN, notifiedAt: '2026-11-10T07:05:02.000Z', notNotified: false, escalatedAt: null };
const NOBODY = { turnId: TURN, notifiedAt: null, notNotified: true, escalatedAt: null };
const ESCALATED = { ...NOTIFIED, escalatedAt: '2026-11-10T07:20:30.000Z' };

describe('the hand-over pill says who was told (SCRUM-823)', () => {
  it('"manager notified HH:MM", in the parks’ time', () => {
    const ctx: PillContext = { me, handoverNotices: [NOTIFIED] };
    expect(eventText(handover(), ctx)).toBe('AI handed over to Birthdays & Events · birthday advice · manager notified 14:05');
  });

  it('"escalated to GM HH:MM" once nobody picked it up', () => {
    const ctx: PillContext = { me, handoverNotices: [ESCALATED] };
    expect(handoverNoticeNotes(ctx, TURN)).toEqual(['manager notified 14:05', 'escalated to GM 14:20']);
    expect(eventText(handover(), ctx)).toMatch(/manager notified 14:05 · escalated to GM 14:20$/);
  });

  it('"manager not notified (no contact)" and "GM not notified (no contact)" when the park names nobody', () => {
    const ctx: PillContext = {
      me,
      handoverNotices: [{ ...NOBODY, notNotifiedWhy: 'no_contact', gmNotNotified: true, gmNotNotifiedWhy: 'no_contact' }],
    };
    expect(handoverNoticeNotes(ctx, TURN)).toEqual(['manager not notified (no contact)', 'GM not notified (no contact)']);
  });

  it('a ping only written to the log is never "notified"; a failed escalation is never "escalated"', () => {
    const logged: PillContext = { me, handoverNotices: [{ ...NOBODY, notNotifiedWhy: 'ping_logged_only' }] };
    expect(handoverNoticeNotes(logged, TURN)).toEqual(['manager not notified (ping logged only)']);
    expect(eventText(handover(), logged)).toBe('AI handed over to Birthdays & Events · birthday advice · manager not notified (ping logged only)');
    const failed: PillContext = { me, handoverNotices: [{ ...NOTIFIED, gmNotNotified: true, gmNotNotifiedWhy: 'failed' }] };
    expect(handoverNoticeNotes(failed, TURN)).toEqual(['manager notified 14:05', 'GM not notified (sending failed)']);
  });

  it('an api from before the reasons: "manager not notified" alone', () => {
    expect(handoverNoticeNotes({ me, handoverNotices: [NOBODY] }, TURN)).toEqual(['manager not notified']);
  });

  it('says nothing of notices for another hand-over, or with none read', () => {
    expect(handoverNoticeNotes({ me, handoverNotices: [NOTIFIED] }, 'another-turn')).toEqual([]);
    expect(eventText(handover(), { me })).toBe('AI handed over to Birthdays & Events · birthday advice');
  });

  it('the collapsed hand-over line carries the notes too', () => {
    const at = '2026-11-10T07:05:00.000Z';
    const events: InboxEvent[] = [
      handover({ createdAt: at }),
      { id: 'm1', kind: 'moved_team', actorKind: 'ai', actorAccountId: null, actorName: null, payload: { toTeamId: T_BIRTHDAYS }, createdAt: at },
    ];
    const items = timeline([], events, true, { me, handoverNotices: [ESCALATED] });
    const group = items.find((i) => i.kind === 'group');
    expect(group && group.kind === 'group' ? group.summary : '').toMatch(/manager notified 14:05, escalated to GM 14:20/);
  });
});
