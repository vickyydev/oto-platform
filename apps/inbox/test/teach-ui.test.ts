// Teach the assistant (SCRUM-696), the shell side: the rules screen and the
// teach chat's small pure rules, and the two panels rendered to markup with
// react-dom/server (Node, no DOM; effects do not run, so nothing is fetched).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiRule } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { ASK_FIRST_IGNORED_LINE, RuleEditor, RulesPanel } from '@/components/RulesPanel';
import { TEACH_INTRO, TeachPanel } from '@/components/TeachPanel';
import { askFirstIgnored, ruleAskFirst, ruleDraftProblem, teachPayload, type RuleDraft } from '@/lib/assistant';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const me: InboxMe = {
  accountId: '00000000-0000-7000-8000-00000000009a',
  name: 'Demo Tom',
  roles: ['marketing'],
  tabs: ['team', 'handled'],
  teams: [{ id: '00000000-0000-7000-8000-0000000000r1', kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false }],
  people: [],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: true, ai: false },
  simulator: null,
};
const noop = () => undefined;
const saved = async () => undefined;

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  intent: 'lost_item',
  instruction: 'If someone says they lost something, first ask which park they visited.',
  askFirst: false,
  condition: 'branch_unknown',
  questionEn: '',
  questionTh: '',
  questionRu: '',
  ...over,
});

const rule = (over: Partial<AiRule> = {}): AiRule => ({
  id: '00000000-0000-7000-8000-0000000000a1',
  intent: 'lost_item',
  branchId: null,
  instruction: 'Ask which park first.',
  askFirst: { condition: 'branch_unknown', question: { en: 'Which park did you visit?' } },
  status: 'approved',
  taughtFrom: 'if someone lost something ask which branch',
  source: 'teach',
  approvedByAccountId: null,
  approvedAt: null,
  updatedByAccountId: null,
  canManage: true,
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
  ...over,
});

describe('the rule editor’s refusals before the server’s', () => {
  it('needs a kind of message, an instruction and, when asking first, the English question', () => {
    expect(ruleDraftProblem(draft())).toBeNull();
    expect(ruleDraftProblem(draft({ intent: '' }))).toMatch(/kind of message/);
    expect(ruleDraftProblem(draft({ intent: 'any' }))).toBeNull();
    expect(ruleDraftProblem(draft({ instruction: '   ' }))).toMatch(/should do/);
    expect(ruleDraftProblem(draft({ instruction: 'x'.repeat(601) }))).toMatch(/600/);
    expect(ruleDraftProblem(draft({ askFirst: true }))).toMatch(/English/);
    expect(ruleDraftProblem(draft({ askFirst: true, questionEn: 'Which park?', questionTh: 'x'.repeat(201) }))).toMatch(/200/);
  });

  it('sends the ask-first part only when ticked, Thai and Russian only when written', () => {
    expect(ruleAskFirst(draft({ questionEn: 'Which park?' }))).toBeNull();
    expect(ruleAskFirst(draft({ askFirst: true, questionEn: ' Which park? ', questionRu: '' }))).toEqual({
      condition: 'branch_unknown',
      question: { en: 'Which park?' },
    });
  });

  it('says under the picker when the question is never asked first', () => {
    expect(askFirstIgnored('complaint_onsite')).toBe(true);
    expect(askFirstIgnored('lost_item')).toBe(false);
    const html = renderToStaticMarkup(createElement(RuleEditor, { me, rule: rule({ intent: 'complaint_onsite' }), onClose: noop, onSaved: saved }));
    expect(html).toContain(ASK_FIRST_IGNORED_LINE.slice(0, 40));
    expect(html).toContain('Saving replaces the approved rule at once');
    const plain = renderToStaticMarkup(createElement(RuleEditor, { me, rule: null, onClose: noop, onSaved: saved }));
    expect(plain).not.toContain(ASK_FIRST_IGNORED_LINE.slice(0, 40));
  });
});

describe('the teach chat', () => {
  it('sends the last twenty lines, starting on one of the staff member’s', () => {
    const lines = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), text: `line ${i}` }));
    const sent = teachPayload(lines);
    expect(sent.length).toBeLessThanOrEqual(20);
    expect(sent[0]?.role).toBe('user');
    expect(sent[sent.length - 1]).toEqual({ role: 'user', text: 'line 24' });
    expect(teachPayload([{ role: 'assistant', text: 'hello' }, { role: 'user', text: 'hi' }])).toEqual([{ role: 'user', text: 'hi' }]);
  });

  it('renders the panels', () => {
    expect(renderToStaticMarkup(createElement(TeachPanel, { me, onTab: noop }))).toContain(TEACH_INTRO.slice(0, 40));
    const rules = renderToStaticMarkup(createElement(RulesPanel, { me }));
    for (const label of ['Drafts', 'Approved', 'Archived', 'New rule']) expect(rules).toContain(label);
  });
});
