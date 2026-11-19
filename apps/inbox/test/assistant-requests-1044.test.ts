// @vitest-environment jsdom
//
// SCRUM-1044 — the assistant's pages ask the server exactly what they asked
// before the redesign. Written against the pages as they were, before their
// layout changed, and kept unchanged after: every read, every write, its
// body, its defaults and the order of its fields, for Numbers, Knowledge,
// Examples, Rules and Teach. The controls are found by the words or names a
// person meets (a row's "Edit", a field's label), never by layout, so the
// same file holds the old page and the new one. If a test here fails after a
// layout change, the change altered behaviour: put it back.
//
// FICTIONAL TEST DATA: every name and text is "ZZ TEST".
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { assistantApi, type AiChannelAccount, type AiExample, type AiRule, type KbEntry } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { AssistantSettings } from '@/components/AssistantSettings';
import type { AssistantTab } from '@/lib/url';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const noop = () => undefined;

const me: InboxMe = {
  accountId: '00000000-0000-7000-8000-00000000009a',
  name: 'ZZ TEST manager',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams: [{ id: '00000000-0000-7000-8000-0000000000c1', kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false }],
  people: [{ accountId: '00000000-0000-7000-8000-0000000000a1', name: 'ZZ TEST Anya', teamIds: [], operatorWide: false }],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: true, ai: true },
  simulator: null,
};

const account = (n: number, over: Partial<AiChannelAccount>): AiChannelAccount => ({
  id: `0192f0a0-1234-7abc-8def-0000000007${String(n).padStart(2, '0')}`,
  channel: 'whatsapp',
  provider: 'zz-test',
  displayName: `ZZ TEST number ${n}`,
  branchId: CENTRAL,
  status: 'active',
  canReply: true,
  aiMode: 'off',
  ...over,
});

const entry = (n: number, over: Partial<KbEntry> = {}): KbEntry => ({
  id: `0192f0a0-1234-7abc-8def-0000000008${String(n).padStart(2, '0')}`,
  branchId: null,
  topic: 'faq',
  key: `faq.zz-test-${n}`,
  language: 'en',
  question: `ZZ TEST question ${n}?`,
  body: `ZZ TEST answer ${n}.\nA second line.`,
  status: 'draft',
  needsTranslation: false,
  sourceExampleId: null,
  updatedByAccountId: null,
  approvedByAccountId: null,
  approvedAt: null,
  canManage: true,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...over,
});

const example = (n: number, over: Partial<AiExample> = {}): AiExample => ({
  id: `0192f0a0-1234-7abc-8def-0000000009${String(n).padStart(2, '0')}`,
  intent: 'faq',
  language: 'en',
  customerText: `ZZ TEST can we bring a cake ${n}?`,
  goodReply: `ZZ TEST yes, a cake is welcome ${n}.`,
  verdict: 'should_answer',
  status: 'proposed',
  sourceMessageId: null,
  sourceConversationId: null,
  proposedByAccountId: '00000000-0000-7000-8000-0000000000a1',
  approvedByAccountId: null,
  approvedAt: null,
  deidentifiedConfirmed: false,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...over,
});

const rule = (n: number, over: Partial<AiRule> = {}): AiRule => ({
  id: `0192f0a0-1234-7abc-8def-0000000010${String(n).padStart(2, '0')}`,
  intent: 'lost_item',
  branchId: null,
  instruction: `ZZ TEST ask which park first ${n}.`,
  askFirst: null,
  status: 'draft',
  taughtFrom: null,
  source: 'manual',
  approvedByAccountId: null,
  approvedAt: null,
  updatedByAccountId: null,
  canManage: true,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...over,
});

// --- The DOM -------------------------------------------------------------------------------

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function mount(el: ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  await settle();
  return host;
}
const page = (tab: AssistantTab) => mount(createElement(AssistantSettings, { me, tab, onTab: noop }));

/** A control's name as a person meets it: its accessible name, else its words. */
const nameOf = (b: Element) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
/** The first button (or menu item) in `scope` whose name matches. */
function button(name: RegExp, scope: ParentNode = document): HTMLElement {
  const found = [...scope.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find((b) => name.test(nameOf(b)));
  expect(found, `a control named ${name}`).toBeTruthy();
  return found!;
}
/** The list item that holds these words: a row of a list. */
function row(words: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('li')].find((li) => li.textContent?.includes(words));
  expect(found, `a row with "${words}"`).toBeTruthy();
  return found!;
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const press = async (el: Element) => {
  await act(async () => void (el as HTMLElement).click());
  await settle();
};
/** The control a field's label names, by the label's first words. */
function field<T extends HTMLElement>(label: string, scope: ParentNode = document): T {
  const found = [...scope.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent?.trim().startsWith(label));
  const control = found?.querySelector<T>('input, select, textarea');
  expect(control, `a field labelled "${label}"`).toBeTruthy();
  return control!;
}
/** A checkbox by the words beside it. */
function tick(words: string, scope: ParentNode = document): HTMLInputElement {
  const found = [...scope.querySelectorAll('label')].find((l) => l.textContent?.includes(words))?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(found, `a checkbox "${words}"`).toBeTruthy();
  return found!;
}
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const submit = async () => press(dialog()!.querySelector('button[type="submit"]')!);

// --- Numbers ----------------------------------------------------------------------------------

describe('SCRUM-1044 requests: Numbers', () => {
  it('reads the numbers; Shadow is set at once, Live only after its confirmation; a refusal stays on its row', async () => {
    const one = account(1, { aiMode: 'off' });
    const two = account(2, { aiMode: 'shadow', displayName: 'ZZ TEST number 2', branchId: null });
    const read = vi.spyOn(assistantApi, 'channelAccounts').mockResolvedValue({ channelAccounts: [one, two] });
    const set = vi
      .spyOn(assistantApi, 'setAiMode')
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'ZZ TEST the number is busy'));
    await page('numbers');
    expect(read).toHaveBeenCalledTimes(1);

    const first = document.querySelector('[role="radiogroup"][aria-label="Assistant mode for ZZ TEST number 1"]')!;
    await press(button(/^Shadow$/, first));
    expect(set).toHaveBeenNthCalledWith(1, one.id, 'shadow');
    expect(dialog()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);

    const second = document.querySelector('[role="radiogroup"][aria-label="Assistant mode for ZZ TEST number 2"]')!;
    await press(button(/^Live$/, second));
    expect(set).toHaveBeenCalledTimes(1);
    expect(dialog()?.textContent).toContain('Put the assistant live on this number?');
    await press(button(/^Yes, customers hear it$/, dialog()!));
    expect(set).toHaveBeenNthCalledWith(2, two.id, 'live');
    expect(dialog()).toBeNull();

    await press(button(/^Shadow$/, document.querySelector('[role="radiogroup"][aria-label="Assistant mode for ZZ TEST number 1"]')!));
    expect(set).toHaveBeenNthCalledWith(3, one.id, 'shadow');
    expect(row('ZZ TEST number 1').querySelector('[role="alert"]')?.textContent).toContain('ZZ TEST the number is busy');
  });
});

// --- Knowledge --------------------------------------------------------------------------------

describe('SCRUM-1044 requests: Knowledge', () => {
  it('reads the entries, and again with Show archived', async () => {
    const read = vi.spyOn(assistantApi, 'kb').mockResolvedValue({ entries: [entry(1)] });
    await page('knowledge');
    expect(read).toHaveBeenLastCalledWith(false);
    await press(tick('Show archived'));
    expect(read).toHaveBeenLastCalledWith(true);
  });

  it('New entry: the same body, the same defaults, in the same order', async () => {
    vi.spyOn(assistantApi, 'kb').mockResolvedValue({ entries: [] });
    const create = vi.spyOn(assistantApi, 'createKb').mockResolvedValue({} as never);
    await page('knowledge');
    await press(button(/^New entry$/));
    expect(dialog()?.textContent).toContain('New entry');
    await type(field<HTMLInputElement>('Key', dialog()!), 'faq.zz-test');
    await type(field<HTMLInputElement>('The question', dialog()!), '  ZZ TEST may we bring food?  ');
    await type(field<HTMLTextAreaElement>('The answer', dialog()!), '  ZZ TEST snacks are welcome.\nNo glass.  ');
    await submit();
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0]![0];
    expect(Object.keys(sent)).toEqual(['id', 'branchId', 'topic', 'key', 'language', 'question', 'body', 'needsTranslation']);
    expect(sent).toEqual({
      id: expect.any(String),
      branchId: null,
      topic: 'faq',
      key: 'faq.zz-test',
      language: 'en',
      question: 'ZZ TEST may we bring food?',
      body: 'ZZ TEST snacks are welcome.\nNo glass.',
      needsTranslation: false,
    });
    expect(dialog()).toBeNull();
  });

  it('Edit: the same patch, in the same order; a refusal is said as the server said it', async () => {
    const draft = entry(1, { branchId: CENTRAL, needsTranslation: true, language: 'th' });
    vi.spyOn(assistantApi, 'kb').mockResolvedValue({ entries: [draft] });
    const update = vi
      .spyOn(assistantApi, 'updateKb')
      .mockRejectedValueOnce(new ApiError(409, 'KB_KEY_TAKEN', 'ZZ TEST that key is taken'))
      .mockResolvedValue({} as never);
    await page('knowledge');
    await press(button(/^Edit\b/, row(draft.question)));
    await submit();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('ZZ TEST that key is taken');
    await submit();
    expect(update).toHaveBeenCalledTimes(2);
    const [id, patch] = update.mock.calls[1]!;
    expect(id).toBe(draft.id);
    expect(Object.keys(patch)).toEqual(['branchId', 'topic', 'key', 'language', 'question', 'body', 'needsTranslation']);
    expect(patch).toEqual({
      branchId: CENTRAL,
      topic: 'faq',
      key: draft.key,
      language: 'th',
      question: draft.question,
      body: draft.body,
      needsTranslation: true,
    });
    expect(dialog()).toBeNull();
  });

  it('Approve and Archive: each after its confirmation, by the entry’s id; none on an approved entry’s Approve', async () => {
    const draft = entry(1);
    const live = entry(2, { status: 'approved' });
    vi.spyOn(assistantApi, 'kb').mockResolvedValue({ entries: [draft, live] });
    const approve = vi.spyOn(assistantApi, 'approveKb').mockResolvedValue({} as never);
    const archive = vi.spyOn(assistantApi, 'archiveKb').mockResolvedValue({} as never);
    await page('knowledge');
    expect([...row(live.question).querySelectorAll('button, [role="menuitem"]')].some((b) => /^Approve\b/.test(nameOf(b)))).toBe(false);
    await press(button(/^Approve\b/, row(draft.question)));
    expect(dialog()?.textContent).toContain('Approve this entry?');
    await press(button(/^Yes, approve$/, dialog()!));
    expect(approve).toHaveBeenCalledWith(draft.id);
    await press(button(/^Archive\b/, row(live.question)));
    expect(dialog()?.textContent).toContain('Archive this entry?');
    await press(button(/^Yes, archive$/, dialog()!));
    expect(archive).toHaveBeenCalledWith(live.id);
  });
});

// --- Examples ---------------------------------------------------------------------------------

describe('SCRUM-1044 requests: Examples', () => {
  it('reads each queue; Withdraw rejects an approved example after its confirmation', async () => {
    const proposed = example(1);
    const approved = example(2, { status: 'approved' });
    const read = vi
      .spyOn(assistantApi, 'examples')
      .mockImplementation(async (status) => ({ examples: status === 'approved' ? [approved] : status === 'proposed' ? [proposed] : [], intents: [] }));
    const reject = vi.spyOn(assistantApi, 'rejectExample').mockResolvedValue({} as never);
    await page('examples');
    expect(read).toHaveBeenLastCalledWith('proposed');
    await press(button(/^Approved$/));
    expect(read).toHaveBeenLastCalledWith('approved');
    await press(button(/^Withdraw\b/, row(approved.customerText)));
    expect(dialog()?.textContent).toContain('Withdraw this example?');
    await press(button(/^Yes, withdraw$/, dialog()!));
    expect(reject).toHaveBeenCalledWith(approved.id);
    await press(button(/^Rejected$/));
    expect(read).toHaveBeenLastCalledWith('rejected');
    await press(button(/^To review$/));
    expect(read).toHaveBeenLastCalledWith('proposed');
  });

  it('Review: Approve waits for the tick; the edits are saved first, in the same order, then the approval', async () => {
    const proposed = example(1);
    vi.spyOn(assistantApi, 'examples').mockResolvedValue({ examples: [proposed], intents: [] });
    const update = vi.spyOn(assistantApi, 'updateExample').mockResolvedValue({} as never);
    const approve = vi.spyOn(assistantApi, 'approveExample').mockResolvedValue({} as never);
    await page('examples');
    await press(button(/^Review\b/, row(proposed.customerText)));
    expect(dialog()?.textContent).toContain('Review the example');
    const approveButton = () => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Approve')!;
    expect(approveButton().disabled).toBe(true);
    await type(field<HTMLTextAreaElement>('The good reply', dialog()!), '  ZZ TEST a cake is very welcome.  ');
    await press(tick('Contains no personal data.', dialog()!));
    expect(approveButton().disabled).toBe(false);
    await press(approveButton());
    const [id, patch] = update.mock.calls[0]!;
    expect(id).toBe(proposed.id);
    expect(Object.keys(patch)).toEqual(['customerText', 'goodReply', 'verdict', 'intent', 'language']);
    expect(patch).toEqual({ customerText: proposed.customerText, goodReply: 'ZZ TEST a cake is very welcome.', verdict: 'should_answer', intent: 'faq', language: 'en' });
    expect(approve).toHaveBeenCalledWith(proposed.id);
    expect(update.mock.invocationCallOrder[0]!).toBeLessThan(approve.mock.invocationCallOrder[0]!);
  });

  it('Review: Reject and Delete ask nothing more and send only the id', async () => {
    const proposed = example(1);
    vi.spyOn(assistantApi, 'examples').mockResolvedValue({ examples: [proposed], intents: [] });
    const reject = vi.spyOn(assistantApi, 'rejectExample').mockResolvedValue({} as never);
    const remove = vi.spyOn(assistantApi, 'deleteExample').mockResolvedValue({} as never);
    await page('examples');
    await press(button(/^Review\b/, row(proposed.customerText)));
    await press(button(/^Reject$/, dialog()!));
    expect(reject).toHaveBeenCalledWith(proposed.id);
    await press(button(/^Review\b/, row(proposed.customerText)));
    await press(button(/^Delete$/, dialog()!));
    expect(remove).toHaveBeenCalledWith(proposed.id);
  });
});

// --- Rules ------------------------------------------------------------------------------------

describe('SCRUM-1044 requests: Rules', () => {
  it('reads each status', async () => {
    const read = vi.spyOn(assistantApi, 'rules').mockResolvedValue({ rules: [] });
    await page('rules');
    expect(read).toHaveBeenLastCalledWith('draft');
    await press(button(/^Approved$/));
    expect(read).toHaveBeenLastCalledWith('approved');
    await press(button(/^Archived$/));
    expect(read).toHaveBeenLastCalledWith('archived');
    await press(button(/^Drafts$/));
    expect(read).toHaveBeenLastCalledWith('draft');
  });

  it('New rule: the same body in the same order, the ask-first part only when ticked; the server’s refusal word for word', async () => {
    vi.spyOn(assistantApi, 'rules').mockResolvedValue({ rules: [] });
    const refusal = 'ZZ TEST A rule cannot carry numbers. Write it without numbers.';
    const create = vi
      .spyOn(assistantApi, 'createRule')
      .mockRejectedValueOnce(new ApiError(400, 'RULE_UNSAFE', refusal, { rule: 'digits' }))
      .mockResolvedValue({} as never);
    await page('rules');
    await press(button(/^New rule$/));
    expect(dialog()?.textContent).toContain('New rule');
    await choose(field<HTMLSelectElement>('Kind of message', dialog()!), 'lost_item');
    await type(field<HTMLTextAreaElement>('What the assistant should do', dialog()!), '  ZZ TEST first ask which park they visited.  ');
    await press(tick('Ask one question first', dialog()!));
    await type(field<HTMLInputElement>('The question, in English', dialog()!), ' ZZ TEST which park did you visit? ');
    await submit();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent?.trim()).toBe(refusal);
    await submit();
    expect(create).toHaveBeenCalledTimes(2);
    const sent = create.mock.calls[1]![0];
    expect(Object.keys(sent)).toEqual(['id', 'branchId', 'intent', 'instruction', 'askFirst']);
    expect(sent).toEqual({
      id: expect.any(String),
      branchId: null,
      intent: 'lost_item',
      instruction: 'ZZ TEST first ask which park they visited.',
      askFirst: { condition: 'branch_unknown', question: { en: 'ZZ TEST which park did you visit?' } },
    });
    expect(dialog()).toBeNull();
  });

  it('Edit, Approve and Archive: the same patch and ids', async () => {
    const draft = rule(1, { branchId: CENTRAL, askFirst: { condition: 'branch_unknown', question: { en: 'ZZ TEST which park?', th: 'ZZ TEST th' } } });
    vi.spyOn(assistantApi, 'rules').mockResolvedValue({ rules: [draft] });
    const update = vi.spyOn(assistantApi, 'updateRule').mockResolvedValue({} as never);
    const approve = vi.spyOn(assistantApi, 'approveRule').mockResolvedValue({} as never);
    const archive = vi.spyOn(assistantApi, 'archiveRule').mockResolvedValue({} as never);
    await page('rules');
    await press(button(/^Edit\b/, row(draft.instruction)));
    await submit();
    const [id, patch] = update.mock.calls[0]!;
    expect(id).toBe(draft.id);
    expect(Object.keys(patch)).toEqual(['branchId', 'intent', 'instruction', 'askFirst']);
    expect(patch).toEqual({
      branchId: CENTRAL,
      intent: 'lost_item',
      instruction: draft.instruction,
      askFirst: { condition: 'branch_unknown', question: { en: 'ZZ TEST which park?', th: 'ZZ TEST th' } },
    });
    await press(button(/^Approve\b/, row(draft.instruction)));
    expect(dialog()?.textContent).toContain('Approve this rule?');
    await press(button(/^Yes, approve$/, dialog()!));
    expect(approve).toHaveBeenCalledWith(draft.id);
    await press(button(/^Archive\b/, row(draft.instruction)));
    expect(dialog()?.textContent).toContain('Archive this rule?');
    await press(button(/^Yes, archive$/, dialog()!));
    expect(archive).toHaveBeenCalledWith(draft.id);
  });
});

// --- Teach ------------------------------------------------------------------------------------

describe('SCRUM-1044 requests: Teach', () => {
  it('sends the session and the lines, newest last; reads the card’s draft; Approve goes through the Rules confirmation', async () => {
    const drafted = rule(7, { source: 'teach', taughtFrom: 'ZZ TEST ask which park' });
    const teach = vi
      .spyOn(assistantApi, 'teach')
      .mockResolvedValueOnce({ reply: 'ZZ TEST saved as a draft rule.', cards: [{ kind: 'rule', id: drafted.id, title: 'ZZ TEST rule', status: 'draft' }], dryRun: null })
      .mockResolvedValueOnce({ reply: 'ZZ TEST noted.', cards: [], dryRun: null });
    const read = vi.spyOn(assistantApi, 'rules').mockResolvedValue({ rules: [drafted] });
    const approve = vi.spyOn(assistantApi, 'approveRule').mockResolvedValue({} as never);
    await page('teach');
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the assistant"]')!;
    expect(box).toBeTruthy();
    await type(box, '  ZZ TEST if someone lost something, ask which park.  ');
    await press(button(/^Send$/));
    expect(teach).toHaveBeenCalledTimes(1);
    const first = teach.mock.calls[0]![0];
    expect(Object.keys(first)).toEqual(['sessionId', 'messages']);
    expect(first).toEqual({ sessionId: expect.any(String), messages: [{ role: 'user', text: 'ZZ TEST if someone lost something, ask which park.' }] });
    expect(read).toHaveBeenCalledWith('draft');
    expect(document.body.textContent).toContain('ZZ TEST saved as a draft rule.');
    expect(document.body.textContent).toContain(drafted.instruction);

    // Enter sends the next line with the conversation so far, under the same session.
    await type(box, 'ZZ TEST thank you');
    await act(async () => void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    const second = teach.mock.calls[1]![0];
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.messages).toEqual([
      { role: 'user', text: 'ZZ TEST if someone lost something, ask which park.' },
      { role: 'assistant', text: 'ZZ TEST saved as a draft rule.' },
      { role: 'user', text: 'ZZ TEST thank you' },
    ]);

    await press(button(/^Approve\b/));
    expect(dialog()?.textContent).toContain('Approve this rule?');
    await press(button(/^Yes, approve$/, dialog()!));
    expect(approve).toHaveBeenCalledWith(drafted.id);
  });

  it('a message that could not be sent goes back into the box, and the refusal is said', async () => {
    vi.spyOn(assistantApi, 'teach').mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'ZZ TEST the curator is resting'));
    await page('teach');
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the assistant"]')!;
    await type(box, 'ZZ TEST a fact');
    await press(button(/^Send$/));
    expect(box.value).toBe('ZZ TEST a fact');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('ZZ TEST the curator is resting');
  });
});
