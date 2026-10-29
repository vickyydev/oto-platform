// Teach the assistant (SCRUM-696), the shell side: the rules screen and the
// teach chat's small pure rules, and the two panels rendered to markup with
// react-dom/server (Node, no DOM; effects do not run, so nothing is fetched).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiRule, KbEntry, TeachCard } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { AssistantSettings } from '@/components/AssistantSettings';
import { KbConfirm, RuleConfirm } from '@/components/AssistantConfirms';
import { ASK_FIRST_IGNORED_LINE, RuleEditor, RulesPanel } from '@/components/RulesPanel';
import {
  DryRun,
  TEACH_CARD_GONE,
  TEACH_DRY_RUN_NOTE,
  TEACH_INTRO,
  TeachApproveConfirm,
  TeachCardView,
  TeachPanel,
} from '@/components/TeachPanel';
import {
  askFirstIgnored,
  ruleAskFirst,
  ruleDraftProblem,
  ruleIntentLabel,
  teachDraftContents,
  teachPayload,
  uniqueTeachCards,
  type RuleDraft,
  type TeachDraftContent,
} from '@/lib/assistant';

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

describe('a teach card shows the whole draft before Approve', () => {
  const entry = (over: Partial<KbEntry> = {}): KbEntry => ({
    id: '00000000-0000-7000-8000-0000000000f1',
    branchId: CENTRAL,
    topic: 'faq',
    key: 'faq.lost-property',
    language: 'en',
    question: 'What happens to things left at the park?',
    body: `Reception keeps lost property for thirty days.\nAsk at the front desk with a photo of the item. ${'More words. '.repeat(30)}The last sentence.`,
    status: 'draft',
    needsTranslation: false,
    sourceExampleId: null,
    updatedByAccountId: null,
    approvedByAccountId: null,
    approvedAt: null,
    canManage: true,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    ...over,
  });
  const factCard: TeachCard = { kind: 'fact', id: entry().id, title: 'faq.lost-property · What happens to…', status: 'draft' };
  const draftRule = rule({
    status: 'draft',
    intent: 'lost_item',
    instruction: 'If someone says they lost something, first ask which park they visited.',
    askFirst: { condition: 'branch_unknown', question: { en: 'Which park did you visit?', th: 'คุณไปสาขาไหนคะ' } },
  });
  const ruleCard: TeachCard = { kind: 'rule', id: draftRule.id, title: 'lost item: If someone…', status: 'draft' };
  const card = (c: TeachCard, content: TeachDraftContent | undefined, over: { approved?: boolean; readError?: string | null } = {}) =>
    renderToStaticMarkup(
      createElement(TeachCardView, {
        me,
        card: c,
        content,
        approved: over.approved ?? false,
        readError: over.readError ?? null,
        onApprove: noop,
        onOpen: noop,
      }),
    );

  it('reads each card’s draft by id from the drafts lists, each card once', () => {
    expect(uniqueTeachCards([factCard, ruleCard, factCard])).toEqual([factCard, ruleCard]);
    const found = teachDraftContents([factCard, ruleCard], { rules: [draftRule], entries: [entry()] });
    expect(found[factCard.id]).toEqual({ kind: 'fact', entry: entry() });
    expect(found[ruleCard.id]).toEqual({ kind: 'rule', rule: draftRule });
    // Not in a list that was read: no longer a draft. A list not read leaves its cards out.
    expect(teachDraftContents([factCard, ruleCard], { rules: [], entries: null })).toEqual({ [ruleCard.id]: { kind: 'gone' } });
    expect(teachDraftContents([factCard], { rules: null, entries: [entry({ status: 'approved' })] })).toEqual({ [factCard.id]: { kind: 'gone' } });
  });

  it('a fact: its key, language, park, question and the whole answer', () => {
    const html = card(factCard, { kind: 'fact', entry: entry() });
    for (const part of ['faq.lost-property', '>EN<', 'Central Floresta', 'What happens to things left at the park?', 'The last sentence.'])
      expect(html).toContain(part);
    expect(html).toContain(entry().body);
    expect(html).not.toContain('line-clamp');
    expect(html).toContain('Approve');
    expect(card(factCard, { kind: 'fact', entry: entry({ branchId: null, language: 'th' }) })).toContain('Both parks');
  });

  it('a rule: its kind of message, park, instruction, condition and the question in each language', () => {
    const html = card(ruleCard, { kind: 'rule', rule: draftRule });
    for (const part of [
      ruleIntentLabel('lost_item'),
      'Both parks',
      draftRule.instruction,
      'When the park is not known yet',
      'English:',
      'Which park did you visit?',
      'Thai:',
      'คุณไปสาขาไหนคะ',
      'Russian:',
      'not written',
      'Approve',
    ])
      expect(html).toContain(part);
    expect(card(ruleCard, { kind: 'rule', rule: rule({ status: 'draft', askFirst: null }) })).toContain('Asks nothing first.');
  });

  it('offers Approve only once the draft is read and still a draft', () => {
    const loading = card(ruleCard, undefined);
    expect(loading).toContain(ruleCard.title);
    expect(loading).toContain('Reading the whole draft');
    expect(loading).not.toContain('Approve');
    const failed = card(ruleCard, undefined, { readError: 'The drafts could not be read.' });
    expect(failed).toContain('The drafts could not be read.');
    expect(failed).not.toContain('Approve');
    const gone = card(ruleCard, { kind: 'gone' });
    expect(gone).toContain(TEACH_CARD_GONE);
    expect(gone).not.toContain('Approve');
    expect(gone).toContain('Open in Rules');
    const done = card(ruleCard, { kind: 'rule', rule: draftRule }, { approved: true });
    expect(done).toContain('Approved');
    expect(done).not.toMatch(/<\/svg>Approve<\/button>/);
    expect(card(ruleCard, { kind: 'rule', rule: { ...draftRule, canManage: false } })).not.toContain('Approve');
  });

  it('Approve opens the Rules and Knowledge tabs’ own confirmation', () => {
    // The dialog's title id is React's useId, numbered per render.
    const markup = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/«[^»]*»/g, '«id»');
    const confirm = (content: TeachDraftContent | undefined) =>
      markup(createElement(TeachApproveConfirm, { me, content, busy: false, error: null, onCancel: noop, onConfirm: noop }));
    const forRule = confirm({ kind: 'rule', rule: draftRule });
    expect(forRule).toContain('Approve this rule?');
    expect(forRule).toContain(draftRule.instruction);
    expect(forRule).toBe(
      markup(
        createElement(RuleConfirm, { me, acting: { rule: draftRule, what: 'approve' }, busy: false, error: null, onCancel: noop, onConfirm: noop }),
      ),
    );
    const forFact = confirm({ kind: 'fact', entry: entry() });
    expect(forFact).toContain('Approve this entry?');
    expect(forFact).toBe(
      markup(createElement(KbConfirm, { acting: { entry: entry(), what: 'approve' }, busy: false, error: null, onCancel: noop, onConfirm: noop })),
    );
    expect(confirm(undefined)).toBe('');
    expect(confirm({ kind: 'gone' })).toBe('');
  });
});

describe('the teach chat survives a tab switch', () => {
  const settings = (tab: 'rules' | 'teach' | 'knowledge') =>
    renderToStaticMarkup(createElement(AssistantSettings, { me, tab, onBack: noop, onTab: noop }));

  it('stays mounted, hidden, while Rules or Knowledge shows', () => {
    for (const tab of ['rules', 'knowledge'] as const) {
      expect(settings(tab)).toMatch(/<div class="hidden" data-teach-chat="true">[\s\S]*Brief the assistant like a new receptionist/);
    }
    expect(settings('teach')).toMatch(/<div data-teach-chat="true">[\s\S]*Brief the assistant like a new receptionist/);
  });
});

describe('the dry run says what it does not show', () => {
  it('names park-only rules, the closing line and routing, the second message and the unclear hand-over', () => {
    const html = renderToStaticMarkup(
      createElement(DryRun, { run: { message: 'I lost my bag', intent: 'lost_item', outcome: 'silent', bubbles: [], ruleFired: null } }),
    );
    expect(html).toContain(TEACH_DRY_RUN_NOTE);
    for (const part of ['one park only', 'closing line and routing', 'second message', '“Stays silent”', 'unclear message'])
      expect(TEACH_DRY_RUN_NOTE).toContain(part);
  });
});
