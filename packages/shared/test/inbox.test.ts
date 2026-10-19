import { describe, expect, it } from 'vitest';
import {
  inTab,
  isUnanswered,
  isVisibleTo,
  matchesBranchFilter,
  matchesSearch,
  tabsForRole,
  tabsForRoles,
  teamDestOf,
  type InboxUnansweredFacts,
} from '../src/inbox';

/**
 * S2-19 I2b (SCRUM-581) — the Inbox's rules, table-tested against the
 * prototype's own cases (`imports/oto-asset-manager/artifacts/oto-org-chart/
 * src/WhatsAppDemo.tsx`). Where the prototype's CODE and the IT Brief
 * disagree, these pin the code ON PURPOSE: the owner-note on SCRUM-220
 * (plan "What reading the repo changed", "Open matters" 3).
 */

describe('tabsForRole (:705-710), as coded', () => {
  it.each([
    // Owner-note: the Brief gives everyone three tabs; the code hides My
    // Inbox for the owner and for both reception views. Pinned as the code.
    ['owner', ['team', 'handled']],
    ['reception', ['team', 'handled']],
    ['events', ['mine', 'team', 'handled']],
    ['marketing', ['mine', 'team', 'handled']],
    // No prototype view: the default arm.
    ['staff', ['mine', 'team', 'handled']],
  ] as const)('%s → %j', (role, tabs) => {
    expect(tabsForRole(role)).toEqual(tabs);
  });

  it('a viewer in several views gets the union, in the prototype order; the owner view wins', () => {
    expect(tabsForRoles(['reception', 'events'])).toEqual(['mine', 'team', 'handled']);
    expect(tabsForRoles(['reception'])).toEqual(['team', 'handled']);
    expect(tabsForRoles(['owner', 'events'])).toEqual(['team', 'handled']);
    expect(tabsForRoles([])).toEqual([]);
  });
});

describe('inTab (:712-721), as coded', () => {
  it.each([
    // [status, assigned to the viewer, tab, in it]
    ['active', true, 'mine', true],
    ['active', false, 'mine', false],
    ['handled', true, 'mine', false],
    // Owner-note: the Brief's Team Inbox excludes "already mine"; the code's
    // includes it. Pinned as the code.
    ['active', true, 'team', true],
    ['active', false, 'team', true],
    ['handled', false, 'team', false],
    ['handled', true, 'handled', true],
    ['active', true, 'handled', false],
  ] as const)('%s, assigned %s: in %s → %s', (status, assignedToViewer, tab, expected) => {
    expect(inTab({ status, assignedToViewer }, tab)).toBe(expected);
  });
});

describe('isUnanswered (:644-656), restated over the columns', () => {
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 20, 3, minute));
  const facts = (over: Partial<InboxUnansweredFacts>): InboxUnansweredFacts => ({
    status: 'active',
    lastCustomerMessageAt: null,
    lastStaffMessageAt: null,
    lastRoutedAt: null,
    ...over,
  });

  it.each([
    // The prototype's walk, case by case.
    ['customer wrote, nobody replied', facts({ lastCustomerMessageAt: t(1), lastRoutedAt: t(1) }), true],
    ['an agent replied last', facts({ lastCustomerMessageAt: t(1), lastStaffMessageAt: t(5), lastRoutedAt: t(1) }), false],
    ['the customer wrote again after the reply', facts({ lastCustomerMessageAt: t(9), lastStaffMessageAt: t(5) }), true],
    // "Routed to …" before any human reply: a person still owes an answer.
    ['routed after the last reply (a move or re-route)', facts({ lastStaffMessageAt: t(5), lastRoutedAt: t(7) }), true],
    // AI lines are not staff lines (:651), so an AI-only thread stays unanswered.
    ['the AI answered, no staff', facts({ lastCustomerMessageAt: t(1), lastRoutedAt: t(2) }), true],
    // The walk that finds nothing returns false.
    ['nothing at all', facts({}), false],
    ['handled is never unanswered', facts({ status: 'handled', lastCustomerMessageAt: t(9) }), false],
    ['ISO strings read the same as dates', facts({ lastCustomerMessageAt: t(9).toISOString(), lastStaffMessageAt: t(5).toISOString() }), true],
  ])('%s → %s', (_label, c, expected) => {
    expect(isUnanswered(c)).toBe(expected);
  });
});

describe('teamDestOf (:965-969)', () => {
  const CENTRAL = '00000000-0000-7000-8000-00000000000c';
  const CHALONG = '00000000-0000-7000-8000-0000000000ca';
  it.each([
    [{ category: 'birthdays', branchId: CHALONG }, { kind: 'birthdays' }],
    [{ category: 'marketing', branchId: null }, { kind: 'marketing' }],
    [{ category: 'general', branchId: CHALONG }, { kind: 'reception', branchId: CHALONG }],
    [{ category: 'general', branchId: CENTRAL }, { kind: 'reception', branchId: CENTRAL }],
    // The prototype's "all" goes to Central: the operator's first park here.
    [{ category: 'general', branchId: null }, { kind: 'reception', branchId: CENTRAL }],
  ] as const)('%j → %j', (c, dest) => {
    expect(teamDestOf(c, CENTRAL)).toEqual(dest);
  });
});

describe('the scope rule (:662-674) on the platform grants', () => {
  const me = 'acct-me';
  const conv = { branchId: 'b1', teamDepartmentId: 'd-bday', assignedAccountIds: ['someone'] };
  const nobody = { accountId: me, operatorWide: false, branchIds: [], departmentIds: [] };
  it('the owner sees everything', () => {
    expect(isVisibleTo(conv, { ...nobody, operatorWide: true })).toBe(true);
  });
  it('a branch grant sees its branch only', () => {
    expect(isVisibleTo(conv, { ...nobody, branchIds: ['b1'] })).toBe(true);
    expect(isVisibleTo(conv, { ...nobody, branchIds: ['b2'] })).toBe(false);
    expect(isVisibleTo({ ...conv, branchId: null }, { ...nobody, branchIds: ['b1'] })).toBe(false);
  });
  it("a team member sees the team's", () => {
    expect(isVisibleTo(conv, { ...nobody, departmentIds: ['d-bday'] })).toBe(true);
    expect(isVisibleTo(conv, { ...nobody, departmentIds: ['d-mkt'] })).toBe(false);
  });
  it('anyone sees what they hold a slot on — the manual-only person sees nothing else', () => {
    expect(isVisibleTo({ ...conv, assignedAccountIds: [me] }, nobody)).toBe(true);
    expect(isVisibleTo(conv, nobody)).toBe(false);
  });
});

describe('the filters (:1066, :1079-1085)', () => {
  it('a branch filter keeps the operator-wide conversations', () => {
    expect(matchesBranchFilter({ branchId: 'b1' }, 'b1')).toBe(true);
    expect(matchesBranchFilter({ branchId: 'b2' }, 'b1')).toBe(false);
    expect(matchesBranchFilter({ branchId: null }, 'b1')).toBe(true);
    expect(matchesBranchFilter({ branchId: 'b2' }, undefined)).toBe(true);
  });
  it('search reads customer, intent and last message, case-insensitively', () => {
    const c = { contactName: 'Sarah Demo', intent: 'birthday enquiry', preview: 'Saturday the 14th' };
    expect(matchesSearch(c, 'sarah')).toBe(true);
    expect(matchesSearch(c, 'ENQUIRY')).toBe(true);
    expect(matchesSearch(c, '14th')).toBe(true);
    expect(matchesSearch(c, 'socks')).toBe(false);
    expect(matchesSearch(c, '  ')).toBe(true);
  });
});
