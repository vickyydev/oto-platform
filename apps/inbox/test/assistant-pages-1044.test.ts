// @vitest-environment jsdom
//
// SCRUM-1044 (second half) — the assistant's pages in the settings frame
// (docs/progress/plans/inbox-redesign/SETTINGS.md): each page still offers
// every control it had, with data on it; the Teach chat's message box is on
// the page for an open conversation on a phone, held at the foot of the page
// area; every control named, a 44 px target to a finger and on the scale; and
// every new pair of words and ground at 4.5 : 1 in both themes. What each
// page asks the server is pinned apart, unchanged since before the redesign
// (assistant-requests-1044.test.ts).
//
// FICTIONAL TEST DATA: every name and text is "ZZ TEST".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assistantApi, type AiChannelAccount, type AiExample, type AiRule, type KbEntry } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { EXAMPLES_NOTE, KNOWLEDGE_NOTE, NUMBERS_NOTE_LEAD, AssistantSettings } from '@/components/AssistantSettings';
import { ASSISTANT_HELP, countWords, intentTitle, quoteFor } from '@/components/assistant-parts';
import { ASK_FIRST_IGNORED_LINE, RULES_NOTE } from '@/components/RulesPanel';
import { SettingsFrame } from '@/components/SettingsFrame';
import { TEACH_EXAMPLE, TEACH_INTRO, TEACH_KEYS_HINT, TEACH_PLACEHOLDER } from '@/components/TeachPanel';
import { AI_MODE_OPTIONS } from '@/lib/assistant';
import type { AssistantTab } from '@/lib/url';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const ANYA = '00000000-0000-7000-8000-0000000000a1';
const noop = () => undefined;
const T = '2026-11-19T00:00:00.000Z';

const me: InboxMe = {
  accountId: '00000000-0000-7000-8000-00000000009a',
  name: 'ZZ TEST manager',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams: [{ id: '00000000-0000-7000-8000-0000000000c1', kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false }],
  people: [{ accountId: ANYA, name: 'ZZ TEST Anya', teamIds: [], operatorWide: false }],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: true, kb: true, ai: true },
  simulator: null,
};

const ids = (() => {
  let n = 0;
  return () => `0192f0a0-1234-7abc-8def-0000000011${String(++n).padStart(2, '0')}`;
})();
const account = (over: Partial<AiChannelAccount>): AiChannelAccount => ({
  id: ids(), channel: 'whatsapp', provider: 'zz-test', displayName: 'ZZ TEST number', branchId: CENTRAL, status: 'active', canReply: true, aiMode: 'off', ...over,
});
const entry = (over: Partial<KbEntry>): KbEntry => ({
  id: ids(), branchId: null, topic: 'faq', key: 'faq.zz-test', language: 'en', question: 'ZZ TEST question?', body: 'ZZ TEST answer.\nZZ TEST second line.', status: 'approved',
  needsTranslation: false, sourceExampleId: null, updatedByAccountId: null, approvedByAccountId: null, approvedAt: null, canManage: true, createdAt: T, updatedAt: T, ...over,
});
const example = (over: Partial<AiExample>): AiExample => ({
  id: ids(), intent: 'ticket_prices', language: 'en', customerText: 'ZZ TEST how much is it?', goodReply: 'ZZ TEST the team confirms today’s price.', verdict: 'should_handover',
  status: 'proposed', sourceMessageId: null, sourceConversationId: null, proposedByAccountId: ANYA, approvedByAccountId: null, approvedAt: null, deidentifiedConfirmed: false,
  createdAt: T, updatedAt: T, ...over,
});
const rule = (over: Partial<AiRule>): AiRule => ({
  id: ids(), intent: 'lost_item', branchId: null, instruction: 'ZZ TEST ask which park first.', askFirst: null, status: 'draft', taughtFrom: null, source: 'manual',
  approvedByAccountId: null, approvedAt: null, updatedByAccountId: null, canManage: true, createdAt: T, updatedAt: T, ...over,
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
const press = async (el: Element | null | undefined) => {
  expect(el, 'the control is on the page').toBeTruthy();
  await act(async () => void (el as HTMLElement).click());
  await settle();
};
const nameOf = (b: Element) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
/** The names of a row's controls (its buttons at the end and its phone menu's button). */
const controls = (li: Element) => [...li.querySelectorAll('button')].map(nameOf);
const row = (words: string) => [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(words))!;
const button = (name: RegExp, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('button')].find((b) => name.test(nameOf(b)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const labels = (scope: ParentNode) => [...scope.querySelectorAll('label')].map((l) => l.textContent?.trim() ?? '');

/** Every button: named, on the scale, a 44 px target to a finger; and no control inside another. */
function controlsAreSound(scope: Element) {
  expect(scope.querySelectorAll('button button, button a[href], button input, button select, button textarea')).toHaveLength(0);
  for (const b of scope.querySelectorAll('button')) {
    expect(nameOf(b), b.outerHTML.slice(0, 120)).not.toBe('');
    expect(b.className, nameOf(b)).toMatch(/(?:^|\s)hit(?:\s|$)/);
    expect(b.className, nameOf(b)).toMatch(/(?:^|\s)(?:min-h|h|size)-(?:ctl|ctl-sm|ctl-lg|icon)(?:\s|$)/);
  }
  expect(scope.innerHTML).not.toMatch(/\b(?:bg|text|border|ring)-(?:slate|amber|indigo|emerald|violet|rose|sky|orange|gray|teal|red|green)-\d/);
}

describe('SCRUM-1044: Numbers offers what it did', () => {
  it('a row per number with its three modes, the current one chosen; Live asks first; the modes explained once', async () => {
    vi.spyOn(assistantApi, 'channelAccounts').mockResolvedValue({
      channelAccounts: [account({ displayName: 'ZZ TEST live', aiMode: 'live' }), account({ displayName: 'ZZ TEST quiet', aiMode: 'off', branchId: null })],
    });
    const el = await page('numbers');
    expect(el.querySelector('h2')?.textContent).toBe('Numbers');
    expect(el.textContent).toContain(ASSISTANT_HELP);
    expect(el.textContent).toContain(NUMBERS_NOTE_LEAD);
    for (const name of ['ZZ TEST live', 'ZZ TEST quiet']) {
      const group = el.querySelector(`[role="radiogroup"][aria-label="Assistant mode for ${name}"]`)!;
      expect([...group.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual(['Off', 'Shadow', 'Live']);
    }
    expect(el.querySelector('[aria-label="Assistant mode for ZZ TEST live"] [aria-checked="true"]')?.textContent).toBe('Live');
    expect(el.querySelector('[aria-label="Assistant mode for ZZ TEST quiet"] [aria-checked="true"]')?.textContent).toBe('Off');
    expect(row('ZZ TEST quiet').textContent).toContain('Both parks');
    // Each mode's words, once.
    for (const o of AI_MODE_OPTIONS) expect(el.textContent!.split(o.description).length - 1, o.value).toBe(1);
    controlsAreSound(el);
    vi.spyOn(assistantApi, 'setAiMode').mockResolvedValue({} as never);
    await press(button(/^Live$/, el.querySelector('[aria-label="Assistant mode for ZZ TEST quiet"]')!));
    expect(dialog()?.textContent).toContain('Put the assistant live on this number?');
    expect(dialog()?.textContent).toContain('Yes, customers hear it');
  });
});

describe('SCRUM-1044: Knowledge offers what it did', () => {
  const draft = entry({ status: 'draft', question: 'ZZ TEST draft?', key: 'faq.zz-draft', needsTranslation: true, language: 'th' });
  const live = entry({ question: 'ZZ TEST live?', topic: 'about_oto', branchId: CENTRAL });
  const notMine = entry({ question: 'ZZ TEST not mine?', canManage: false });
  const old = entry({ question: 'ZZ TEST old?', status: 'archived' });

  it('a section per topic; Edit, Approve and Archive where they were, none where they were not', async () => {
    vi.spyOn(assistantApi, 'kb').mockResolvedValue({ entries: [draft, live, notMine, old] });
    const el = await page('knowledge');
    expect(el.textContent).toContain(KNOWLEDGE_NOTE);
    expect(button(/^New entry$/, el)).toBeTruthy();
    expect(labels(el)).toContain('Show archived');
    expect(el.textContent).toContain(countWords(4, 'entry', 'entries', 1));
    expect([...el.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['About OTO', 'FAQ']);
    const name = (e: KbEntry, lang: string) => `${quoteFor(e.question)}, ${lang}`;
    expect(controls(row(draft.question))).toEqual([`Edit: ${name(draft, 'Thai')}`, `Approve: ${name(draft, 'Thai')}`, `Archive: ${name(draft, 'Thai')}`, `Actions: ${name(draft, 'Thai')}`]);
    expect(controls(row(live.question))).toEqual([`Edit: ${name(live, 'English')}`, `Archive: ${name(live, 'English')}`, `Actions: ${name(live, 'English')}`]);
    expect(controls(row(notMine.question))).toEqual([]);
    expect(controls(row(old.question))).toEqual([]);
    // One badge a row, the rest as meta; the answer keeps its line breaks.
    expect(row(draft.question).textContent).toContain('Draft');
    expect(row(draft.question).textContent).toContain('English source, to translate');
    expect(row(draft.question).textContent).toContain('faq.zz-draft');
    expect(row(live.question).textContent).toContain('Central Floresta');
    expect(row(live.question).querySelector('p.whitespace-pre-line')?.textContent).toBe(live.body);
    controlsAreSound(el);
  });

  it('the phone menu holds the same actions; the editor keeps every field', async () => {
    vi.spyOn(assistantApi, 'kb').mockResolvedValue({ entries: [draft] });
    await page('knowledge');
    await press(button(/^Actions: /, row(draft.question)));
    expect([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent)).toEqual(['Edit', 'Approve', 'Archive']);
    await press([...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Edit'));
    const form = dialog()!;
    expect(form.querySelector('h2')?.textContent).toBe('Edit entry');
    const fieldLabels = labels(form).join(' | ');
    for (const words of ['The question, as a customer would ask it', 'The answer', 'Topic', 'Key', 'Language', 'Park', 'English source, to translate']) expect(fieldLabels).toContain(words);
    expect(form.querySelector('textarea')?.value).toBe(draft.body);
    controlsAreSound(form);
  });
});

describe('SCRUM-1044: Examples offers what it did', () => {
  it('the three queues; Review on a proposed example, Withdraw on an approved one; the reply and who proposed it', async () => {
    const proposed = example({});
    const approved = example({ status: 'approved', customerText: 'ZZ TEST socks?', intent: 'faq', verdict: 'should_answer' });
    vi.spyOn(assistantApi, 'examples').mockImplementation(async (s) => ({ examples: s === 'approved' ? [approved] : s === 'proposed' ? [proposed] : [], intents: [] }));
    const el = await page('examples');
    expect(el.textContent).toContain(EXAMPLES_NOTE);
    const group = el.querySelector('[role="group"][aria-label="Examples to show"]')!;
    expect([...group.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['To review', 'true'],
      ['Approved', 'false'],
      ['Rejected', 'false'],
    ]);
    const r = row(proposed.customerText);
    expect(r.querySelector('div.text-body')?.textContent).toBe(intentTitle('ticket_prices'));
    for (const words of [proposed.goodReply!, 'Should hand over', 'English', 'by ZZ TEST Anya']) expect(r.textContent).toContain(words);
    expect(controls(r)).toEqual([`Review: ${quoteFor(proposed.customerText)}`, `Actions: ${quoteFor(proposed.customerText)}`]);
    controlsAreSound(el);
    await press(button(/^Approved$/, group));
    expect(controls(row(approved.customerText))).toEqual([`Withdraw: ${quoteFor(approved.customerText)}`, `Actions: ${quoteFor(approved.customerText)}`]);
    await press(button(/^Rejected$/, group));
    expect(document.body.textContent).toContain('Nothing here.');
  });

  it('the review keeps every field, the tick and its four actions', async () => {
    const proposed = example({});
    vi.spyOn(assistantApi, 'examples').mockResolvedValue({ examples: [proposed], intents: [] });
    await page('examples');
    await press(button(/^Review: /, row(proposed.customerText)));
    const form = dialog()!;
    const fieldLabels = labels(form).join(' | ');
    for (const words of ['What should it have done?', 'The customer asked', 'The good reply', 'Topic of the question', 'Language', 'Contains no personal data.']) expect(fieldLabels).toContain(words);
    expect([...form.querySelectorAll('button')].map((b) => b.textContent?.trim()).slice(-4)).toEqual(['Reject', 'Delete', 'Save', 'Approve']);
    controlsAreSound(form);
  });
});

describe('SCRUM-1044: Rules offers what it did', () => {
  it('the three statuses, New rule, and a row per rule with its ask-first question and the words it was taught from', async () => {
    const asks = rule({ askFirst: { condition: 'branch_unknown', question: { en: 'ZZ TEST which park?' } }, taughtFrom: 'ZZ TEST taught words' });
    const mine = rule({ intent: 'any', instruction: 'ZZ TEST greet warmly.', canManage: false });
    vi.spyOn(assistantApi, 'rules').mockResolvedValue({ rules: [asks, mine] });
    const el = await page('rules');
    expect(el.textContent).toContain(RULES_NOTE);
    expect(button(/^New rule$/, el)).toBeTruthy();
    expect([...el.querySelectorAll('[aria-label="Rules to show"] button')].map((b) => b.textContent)).toEqual(['Drafts', 'Approved', 'Archived']);
    const r = row(asks.instruction);
    for (const words of ['Lost item', 'Ask first', 'When the park is not known yet', 'ZZ TEST which park?', 'Taught from: “ZZ TEST taught words”', 'Draft', 'Both parks'])
      expect(r.textContent).toContain(words);
    expect(controls(r).map((n) => n.split(':')[0])).toEqual(['Approve', 'Edit', 'Archive', 'Actions']);
    expect(controls(row(mine.instruction))).toEqual([]);
    expect(row(mine.instruction).textContent).toContain('Any message');
    controlsAreSound(el);
  });

  it('the editor keeps every field; the "never asks first" line under the picker; a refusal above the first field', async () => {
    vi.spyOn(assistantApi, 'rules').mockResolvedValue({ rules: [] });
    vi.spyOn(assistantApi, 'createRule').mockRejectedValue(new (await import('@/api/client')).ApiError(400, 'RULE_UNSAFE', 'ZZ TEST refused as said'));
    await page('rules');
    await press(button(/^New rule$/));
    const form = dialog()!;
    const select = form.querySelector('select')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'complaint_onsite');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(form.textContent).toContain(ASK_FIRST_IGNORED_LINE);
    const area = form.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'ZZ TEST thank them.');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press([...form.querySelectorAll('label')].find((l) => l.textContent?.includes('Ask one question first'))!.querySelector('input'));
    const fieldLabels = labels(form).join(' | ');
    for (const words of ['Kind of message', 'Park', 'What the assistant should do', 'Ask one question first', 'When', 'The question, in English', 'In Thai (optional)', 'In Russian (optional)'])
      expect(fieldLabels).toContain(words);
    const english = [...form.querySelectorAll('label')].find((l) => l.textContent?.startsWith('The question, in English'))!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(english, 'ZZ TEST which park?');
      english.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(form.querySelector('button[type="submit"]'));
    const alert = form.querySelector('form [role="alert"]')!;
    expect(alert.textContent).toBe('ZZ TEST refused as said');
    // The refusal is the form's first thing, above the kind of message.
    expect(alert.compareDocumentPosition(form.querySelector('select')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    controlsAreSound(form);
  });
});

describe('SCRUM-1044: Teach is a chat whose message box is always on the page', () => {
  const frame = () => mount(createElement(SettingsFrame, { me, page: 'assistant', section: 'teach', accessKey: '', onOpen: noop, onBack: noop }));
  /** The class tokens that would take a thing off a phone's screen. */
  const HIDING = /(?:^|\s)(?:hidden|max-md:hidden|max-sm:hidden|invisible|sr-only)(?:\s|$)/;
  function onPage(el: Element) {
    for (let at: Element | null = el; at && at !== host; at = at.parentElement) expect(at.className.toString(), at.tagName).not.toMatch(HIDING);
  }

  it('on a phone layout, before a word is said: the briefing, the example, and the message box at the foot', async () => {
    const el = await frame();
    const box = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the assistant"]')!;
    expect(box).toBeTruthy();
    onPage(box);
    expect(box.getAttribute('placeholder')).toBe(TEACH_PLACEHOLDER);
    const bar = el.querySelector('[data-teach-composer]')!;
    expect(bar.className).toMatch(/(?:^|\s)sticky(?:\s|$)/);
    expect(bar.className).toMatch(/(?:^|\s)bottom-0(?:\s|$)/);
    expect(bar.textContent).toContain(TEACH_KEYS_HINT);
    // The page area gives the chat its whole height, so the bar stands at the foot even with no lines.
    expect(el.querySelector('section[data-pane="settings"] > div')!.className).toMatch(/min-h-full/);
    expect(el.textContent).toContain(TEACH_INTRO);
    expect(el.textContent).toContain(TEACH_EXAMPLE);
    expect(button(/^Send$/, bar)).toBeTruthy();
    controlsAreSound(el.querySelector('[data-teach-thread]')!);
  });

  it('with a conversation open, the box stays on the page after the thread, and the lines are in the Inbox’s bubbles', async () => {
    vi.spyOn(assistantApi, 'teach').mockResolvedValue({ reply: 'ZZ TEST noted as a draft.', cards: [], dryRun: null });
    const el = await frame();
    const box = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the assistant"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'ZZ TEST a fact');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(button(/^Send$/));
    const mine = [...el.querySelectorAll('p')].find((p) => p.textContent === 'ZZ TEST a fact')!;
    const theirs = [...el.querySelectorAll('p')].find((p) => p.textContent === 'ZZ TEST noted as a draft.')!;
    expect(mine.className).toContain('bg-staff');
    expect(mine.className).toContain('text-on-staff');
    expect(theirs.className).toContain('bg-mint');
    expect(theirs.className).toContain('text-teal');
    const stillThere = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the assistant"]')!;
    expect(stillThere).toBe(box);
    onPage(stillThere);
    expect(theirs.compareDocumentPosition(el.querySelector('[data-teach-composer]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The briefing stays at the top of the thread; the example steps aside once something is said.
    expect(el.textContent).toContain(TEACH_INTRO);
    expect(el.textContent).not.toContain(TEACH_EXAMPLE);
  });
});

// --- Tokens ----------------------------------------------------------------------------------

const css = readFileSync(path.resolve(import.meta.dirname, '..', 'src/index.css'), 'utf8');
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--oto-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
}
const contrast = (theme: Record<string, string>, a: string, b: string) => {
  const x = luminance(theme[a]!), y = luminance(theme[b]!);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Every pair of words and ground the assistant's pages put on screen that the frame's own test does not hold. */
const ASSISTANT_TEXT: Array<[string, string]> = [
  // The pages' mint notes, a rule's ask-first question, the curator's label over its lines on the ground.
  ['teal', 'mint-soft'], ['teal', 'ground'],
  // The curator's bubbles, a good reply, a dry run's lines; the chosen Live segment (mint words on teal).
  ['teal', 'mint'], ['mint', 'teal'],
  // The person's own bubbles.
  ['on-staff', 'staff'],
  // The briefing and its example on the band; a dry run's "A rule fired" on the card.
  ['ink-soft', 'band'], ['ink-muted', 'band'], ['teal', 'card'],
  // The badges: a draft, an approval, a verdict, Off.
  ['ask-ink', 'ask'], ['money-ink', 'money-badge'], ['ink-soft', 'band'],
  // The "never asks first" line and a translation still to do, in amber, on a dialog's ground and the card.
  ['ask-ink', 'ground'], ['ask-ink', 'card'],
  // The disabled Send: muted words on the band.
  ['ink-muted', 'band'],
];

describe('SCRUM-1044: the assistant pages’ words read at 4.5 : 1', () => {
  it.each([['light', block(':root')], ['dark', block('html.dark')]] as const)('every pair (%s)', (_, theme) => {
    for (const [ink, ground] of ASSISTANT_TEXT) expect(contrast(theme, ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
  });
});
