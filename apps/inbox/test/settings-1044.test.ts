// @vitest-environment jsdom
//
// SCRUM-1044 — the settings frame and the Templates page in it
// (docs/progress/plans/inbox-redesign/SETTINGS.md): every page reachable by
// the people who may open it and by nobody else, the address bar's contract
// kept, every action the Templates page had still offered with its
// confirmation and the same request, and the shared parts on the one scale
// with tested token pairs. Rendered to markup, and in a DOM for the presses.
//
// FICTIONAL TEST DATA: every name and text is "ZZ TEST".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileText } from 'lucide-react';
import { ApiError } from '@/api/client';
import { inboxApi, type InboxMe, type ManagedTemplate } from '@/api/inbox';
import { BACK_TO_INBOX, SettingsFrame, settingsCurrent, settingsNav, type SettingsKey } from '@/components/SettingsFrame';
import {
  ActionBar,
  EmptyNote,
  Field,
  InlineError,
  InlineNote,
  LoadingNote,
  MENU_ITEM,
  NOTE_TONE,
  PageHeader,
  RowMenuItems,
  SETTINGS_ROW,
  SectionCard,
  SettingsRow,
} from '@/components/settings-parts';
import {
  APPROVAL_LABEL,
  ArchiveTemplateConfirm,
  TEMPLATE_ARCHIVED,
  TEMPLATE_SAVED,
  TEMPLATES_HELP,
  TemplateEditor,
  TemplateGroups,
  TemplateSettings,
  keyTitle,
  templateCount,
  templateGroups,
} from '@/components/TemplateSettings';
import { BTN_MAIN, INPUT } from '@/components/ui';
import { inboxSearch, viewFromUrl } from '@/lib/url';
import { settingsTemplates } from './settings-fixture';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const noop = () => undefined;

function viewer(over: Partial<InboxMe['capabilities']>): InboxMe {
  return {
    accountId: '00000000-0000-7000-8000-00000000009a',
    name: 'ZZ TEST viewer',
    roles: ['owner'],
    tabs: ['team', 'handled'],
    teams: [{ id: '00000000-0000-7000-8000-0000000000c1', kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false }],
    people: [],
    defaultReceptionBranchId: CENTRAL,
    capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: false, ai: false, ...over },
    simulator: null,
  };
}

/** Who may open what, by today's grants (INVENTORY §1.1): the GM, a knowledge holder, a numbers holder, an admin, an agent. */
const PEOPLE: Array<[string, InboxMe, SettingsKey[]]> = [
  ['a manager with templates only (the GM)', viewer({ templates: true }), ['templates']],
  ['a holder of inbox:kb:manage', viewer({ kb: true }), ['knowledge', 'examples', 'rules', 'teach']],
  ['a holder of inbox:ai:manage', viewer({ ai: true }), ['numbers']],
  ['an inbox admin', viewer({ templates: true, kb: true, ai: true }), ['templates', 'numbers', 'knowledge', 'examples', 'rules', 'teach']],
  ['an agent', viewer({}), []],
];

const frame = (me: InboxMe, page: 'templates' | 'assistant', section: SettingsKey | null = null) =>
  renderToStaticMarkup(
    createElement(SettingsFrame, {
      me,
      page,
      section: section === 'templates' ? null : section,
      accessKey: '',
      onOpen: noop,
      onBack: noop,
    }),
  );

/** The pages the frame offers, each time it offers one (the column, then the band), by key. */
const offered = (html: string) => [...html.matchAll(/data-settings-page="([a-z]+)"/g)].map((m) => m[1]!);
/** The pages marked as the one open, by key. */
const current = (html: string) =>
  new Set([...html.matchAll(/<button[^>]*data-settings-page="([a-z]+)"[^>]*aria-current="page"/g)].map((m) => m[1]!));

describe('SCRUM-1044: every settings page for the people who may open it, and nobody else', () => {
  it.each(PEOPLE)('%s', (_, me, keys) => {
    expect(settingsNav(me).map((i) => i.key)).toEqual(keys);
    const html = frame(me, keys.includes('templates') ? 'templates' : 'assistant');
    // The column holds each once; the band on a phone holds each once more, when there is more than one.
    const seen = offered(html);
    expect(seen.slice(0, keys.length)).toEqual(keys);
    expect(seen.slice(keys.length)).toEqual(keys.length > 1 ? keys : []);
    for (const key of ['templates', 'numbers', 'knowledge', 'examples', 'rules', 'teach'] as SettingsKey[]) {
      if (!keys.includes(key)) expect(seen, key).not.toContain(key);
    }
  });

  it('draws a page only for a viewer who may open it', () => {
    // A knowledge holder sent to Templates sees no template page; an agent sees neither page.
    for (const me of [viewer({ kb: true }), viewer({})]) {
      const html = frame(me, 'templates');
      expect(html).not.toContain('New template');
      expect(html).not.toMatch(/<h2[^>]*>Templates<\/h2>/);
    }
    expect(frame(viewer({}), 'assistant')).toContain('You do not manage the assistant.');
    expect(frame(viewer({ templates: true }), 'templates')).toContain('New template');
  });

  it('marks the open page in the column and the band, the first assistant section when none or another is named', () => {
    const admin = viewer({ templates: true, kb: true, ai: true });
    for (const item of settingsNav(admin)) {
      expect(current(frame(admin, item.page, item.section)), item.key).toEqual(new Set([item.key]));
    }
    expect(current(frame(admin, 'assistant', null))).toEqual(new Set(['numbers']));
    const kb = viewer({ kb: true });
    expect(current(frame(kb, 'assistant', null))).toEqual(new Set(['knowledge']));
    expect(current(frame(kb, 'assistant', 'numbers'))).toEqual(new Set(['knowledge']));
  });

  it('puts the way back on every page, by its words from 768 px and by its name on a phone', () => {
    const html = frame(viewer({ templates: true }), 'templates');
    expect(html).toContain(`>${BACK_TO_INBOX}</button>`);
    expect(html).toContain(`aria-label="${BACK_TO_INBOX}"`);
    expect(html).toMatch(/<h2[^>]*>Settings<\/h2>/);
  });
});

describe('SCRUM-1044: the address bar contract holds (lib/url.ts, SCRUM-591)', () => {
  const admin = viewer({ templates: true, kb: true, ai: true });
  const items = settingsNav(admin);
  const allowed = { templates: true, assistant: true };

  it('each page of the frame writes the address it always had, and that address lands on the same page', () => {
    const written = items.map((i) => inboxSearch({ tab: 'team', unanswered: false, selectedId: null, settings: i.page, assistantTab: i.section }, 'team'));
    expect(written).toEqual([
      '?settings=templates',
      '?settings=assistant&section=numbers',
      '?settings=assistant&section=knowledge',
      '?settings=assistant&section=examples',
      '?settings=assistant&section=rules',
      '?settings=assistant&section=teach',
    ]);
    items.forEach((item, at) => {
      const view = viewFromUrl(written[at]!, ['team', 'handled'], 'team', allowed);
      expect(view.settings, item.key).not.toBeNull();
      expect(settingsCurrent(items, view.settings!, view.assistantTab), item.key).toBe(item.key);
    });
  });

  it('keeps the old spelling and the plain assistant address, and refuses a page the viewer may not open', () => {
    const legacy = viewFromUrl('?settings=assistant&tab=rules', ['team', 'handled'], 'team', allowed);
    expect(settingsCurrent(items, legacy.settings!, legacy.assistantTab)).toBe('rules');
    const plain = viewFromUrl('?settings=assistant', ['team', 'handled'], 'team', allowed);
    expect(settingsCurrent(items, plain.settings!, plain.assistantTab)).toBe('numbers');
    expect(viewFromUrl('?settings=templates', ['team', 'handled'], 'team', { templates: false, assistant: true }).settings).toBeNull();
    expect(viewFromUrl('?settings=assistant&section=rules', ['team', 'handled'], 'team', { templates: true, assistant: false }).settings).toBeNull();
    // A section belongs to the assistant's page, never to Templates.
    expect(viewFromUrl('?settings=templates&section=rules', ['team', 'handled'], 'team', allowed).assistantTab).toBeNull();
  });

  it('the workspace pushes a history entry for another page and replaces it for another section, as before', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '..', 'src/components/Workspace.tsx'), 'utf8');
    expect(src).toMatch(/const openSettings = \(page: SettingsPage, section: AssistantTab \| null\) => \{\s*if \(page !== settings\) historyMode\.current = 'push';\s*setSettings\(page\);\s*setAssistantTab\(section\);/);
    expect(src).toContain('onOpen={openSettings}');
    expect(src).toContain('onBack={() => chooseSettings(null)}');
  });
});

describe('SCRUM-1044: the Templates page, as rows', () => {
  const me = viewer({ templates: true });
  const templates = settingsTemplates(CENTRAL);
  const rows = () =>
    renderToStaticMarkup(createElement(TemplateGroups, { me, templates, onEdit: noop, onArchive: noop, onChanged: async () => undefined }));

  it('groups by key in the shared order, titled in sentence case with the count of variants', () => {
    expect(templateGroups(templates).map((g) => [g.key, g.rows.length])).toEqual([
      ['welcome', 3],
      ['handover_birthday', 2],
      ['follow_up', 2],
      ['closing_gm', 1],
    ]);
    expect(keyTitle('handover_birthday')).toBe('Handover birthday');
    expect(keyTitle('closing_gm')).toBe('Closing GM');
    const html = rows();
    for (const title of ['Welcome', 'Handover birthday', 'Follow up', 'Closing GM']) expect(html).toMatch(new RegExp(`<h3[^>]*>${title}</h3>`));
    expect(templateCount(templates)).toBe('8 templates, 1 archived');
    expect(templateCount(templates.slice(0, 1))).toBe('1 template');
  });

  it('says every state the old cards said, with at most one badge a row', () => {
    const html = rows();
    for (const label of Object.values(APPROVAL_LABEL)) expect(html).toContain(label);
    for (const words of ['Inactive', 'Archived', 'English source, to translate', 'Every channel', 'Every park', 'WhatsApp', 'Central Floresta']) expect(html).toContain(words);
    const root = document.createElement('div');
    root.innerHTML = html;
    const lis = [...root.querySelectorAll('li')];
    expect(lis).toHaveLength(templates.length);
    for (const li of lis) expect(li.querySelectorAll('span.rounded-lg.font-semibold').length, li.textContent ?? '').toBeLessThanOrEqual(1);
  });

  it('offers Edit and Archive on every live row, at its end and in its phone menu, and none on an archived one', () => {
    const root = document.createElement('div');
    root.innerHTML = rows();
    for (const li of root.querySelectorAll('li')) {
      const archived = li.textContent!.includes('Archived');
      const names = [...li.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
      if (archived) expect(names).toEqual([]);
      else {
        expect(names.filter((n) => /^Edit: /.test(n ?? ''))).toHaveLength(1);
        expect(names.filter((n) => /^Archive: /.test(n ?? ''))).toHaveLength(1);
        expect(names.filter((n) => /^Actions: /.test(n ?? ''))).toHaveLength(1);
      }
    }
  });

  it('keeps the birthday brochure on its rows: what is attached, upload or replace', () => {
    const html = rows();
    expect(html).toContain('Birthday brochure attached (1 file)');
    expect(html).toContain('No birthday brochure yet');
    expect(html).toContain('Replace brochure');
    expect(html).toContain('Upload brochure');
    expect(html).toMatch(/<input type="file" accept="application\/pdf,image\/jpeg,image\/png,image\/webp"/);
  });

  it('the page itself: its title, its help word for word, New template, Show archived, and the skeleton while reading', () => {
    const html = renderToStaticMarkup(createElement(TemplateSettings, { me }));
    expect(html).toMatch(/<h2[^>]*>Templates<\/h2>/);
    expect(html).toContain(TEMPLATES_HELP);
    expect(html).toContain('New template');
    expect(html).toContain('Show archived');
    expect(html).toContain('role="status"');
    expect(html).toContain('Reading the templates');
  });

  it('the editor keeps every field, the values helper and the switches; a new one asks which template', () => {
    const created = renderToStaticMarkup(createElement(TemplateEditor, { me, template: null, onClose: noop, onSaved: async () => undefined }));
    for (const label of ['Template', 'Words', 'Language', 'Channel', 'Park', 'Approval', 'Provider template name (WhatsApp)', 'Offered in the composer', 'English source, to translate', 'Save', 'Cancel', 'New template'])
      expect(created).toContain(label);
    expect(created).toContain('Write {{name}} where a value is filled in when sending.');
    const edited = renderToStaticMarkup(createElement(TemplateEditor, { me, template: templates[0]!, onClose: noop, onSaved: async () => undefined }));
    expect(edited).toContain('Edit template');
    expect(edited).toContain('Values asked for when sending: name');
    expect(edited).not.toMatch(/<span[^>]*>Template<\/span>/);
    // Help is tied to its field for a screen reader.
    expect(edited).toMatch(/<textarea[^>]*aria-describedby="[^"]+"/);
  });

  it('the archive confirmation says what archiving does before the press', () => {
    const html = renderToStaticMarkup(createElement(ArchiveTemplateConfirm, { template: templates[0]!, busy: false, error: 'ZZ TEST refusal', onCancel: noop, onConfirm: noop }));
    for (const words of ['Archive this template?', 'Welcome · English', 'It leaves the composer and this list for good.', 'Yes, archive', 'Cancel', 'ZZ TEST refusal']) expect(html).toContain(words);
  });
});

// --- In a DOM: the presses ---------------------------------------------------------------

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
});

/** Let the reads a render or a press started come back (the api is a resolved mock). */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function mount(el: ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  await settle();
  return host;
}
async function unmount() {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}
const press = async (el: Element | null | undefined) => {
  expect(el, 'the control is on the page').toBeTruthy();
  await act(async () => void (el as HTMLElement).click());
  await settle();
};
const byName = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find((b) =>
    typeof name === 'string' ? (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name : name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );
function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SCRUM-1044: the frame in a DOM', () => {
  it('opens each page by its page and section, and goes back to the inbox from the column and from a phone', async () => {
    vi.spyOn(inboxApi, 'manageTemplates').mockResolvedValue({ templates: [] });
    const onOpen = vi.fn();
    const onBack = vi.fn();
    const admin = viewer({ templates: true, kb: true, ai: true });
    const el = await mount(createElement(SettingsFrame, { me: admin, page: 'templates', section: null, accessKey: '', onOpen, onBack }));
    const column = el.querySelectorAll('nav[aria-label="Settings pages"]')[0]!;
    const band = el.querySelectorAll('nav[aria-label="Settings pages"]')[1]!;
    await press(column.querySelector('[data-settings-page="rules"]'));
    await press(band.querySelector('[data-settings-page="numbers"]'));
    await press(column.querySelector('[data-settings-page="templates"]'));
    expect(onOpen.mock.calls).toEqual([
      ['assistant', 'rules'],
      ['assistant', 'numbers'],
      ['templates', null],
    ]);
    await press([...el.querySelectorAll('button')].find((b) => b.textContent === BACK_TO_INBOX));
    await press(el.querySelector(`button[aria-label="${BACK_TO_INBOX}"]`));
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});

describe('SCRUM-1044: the Templates page in a DOM offers every action it had, with the same requests', () => {
  const me = viewer({ templates: true });
  const templates = settingsTemplates(CENTRAL);

  it('reads the list, and again with Show archived', async () => {
    const read = vi.spyOn(inboxApi, 'manageTemplates').mockResolvedValue({ templates });
    const el = await mount(createElement(TemplateSettings, { me }));
    expect(read).toHaveBeenLastCalledWith(false);
    expect(el.textContent).toContain('8 templates, 1 archived');
    expect(el.querySelectorAll('li')).toHaveLength(templates.length);
    const box = [...el.querySelectorAll('label')].find((l) => l.textContent?.includes('Show archived'))!.querySelector('input')!;
    await press(box);
    expect(read).toHaveBeenLastCalledWith(true);
  });

  it('New template: the same request, the same defaults, then a saved note', async () => {
    vi.spyOn(inboxApi, 'manageTemplates').mockResolvedValue({ templates });
    const create = vi.spyOn(inboxApi, 'createTemplate').mockResolvedValue({} as never);
    await mount(createElement(TemplateSettings, { me }));
    await press(byName('New template'));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('New template');
    const words = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
    await act(async () => type(words, 'ZZ TEST Hello {{name}}'));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Values asked for when sending: name');
    await press(document.querySelector('[role="dialog"] button[type="submit"]'));
    expect(create).toHaveBeenCalledWith({
      key: 'welcome',
      language: 'en',
      channel: null,
      branchId: null,
      body: 'ZZ TEST Hello {{name}}',
      providerTemplateName: null,
      approvalStatus: 'not_required',
      active: true,
      needsTranslation: false,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(TEMPLATE_SAVED);
  });

  it('Edit: the editor on that template, and its save is the same patch', async () => {
    vi.spyOn(inboxApi, 'manageTemplates').mockResolvedValue({ templates });
    const update = vi.spyOn(inboxApi, 'updateTemplate').mockResolvedValue({} as never);
    await mount(createElement(TemplateSettings, { me }));
    await press(byName('Edit: Welcome, Thai'));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit template');
    await press(document.querySelector('[role="dialog"] button[type="submit"]'));
    expect(update).toHaveBeenCalledWith(templates[2]!.id, {
      language: 'th',
      channel: 'whatsapp',
      branchId: CENTRAL,
      body: templates[2]!.body,
      providerTemplateName: 'zz_test_welcome',
      approvalStatus: 'pending',
      active: true,
      needsTranslation: false,
    });
  });

  it('Archive, from the phone menu: the confirmation, the request, then an archived note; a refusal is said in the dialog', async () => {
    vi.spyOn(inboxApi, 'manageTemplates').mockResolvedValue({ templates });
    const archive = vi
      .spyOn(inboxApi, 'archiveTemplate')
      .mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'ZZ TEST the server refused'))
      .mockResolvedValue({} as never);
    await mount(createElement(TemplateSettings, { me }));
    const trigger = byName('Actions: Follow up, English')!;
    await press(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent);
    expect(items).toEqual(['Edit', 'Archive']);
    await press(byName('Archive'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Archive this template?');
    await press(byName('Yes, archive'));
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('ZZ TEST the server refused');
    await press(byName('Yes, archive'));
    expect(archive).toHaveBeenLastCalledWith(templates[3]!.id);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(TEMPLATE_ARCHIVED);
  });

  it('the row menu moves with the arrow keys and closes on Escape, focus back on its button', async () => {
    vi.spyOn(inboxApi, 'manageTemplates').mockResolvedValue({ templates });
    await mount(createElement(TemplateSettings, { me }));
    const trigger = byName('Actions: Welcome, English')!;
    await press(trigger);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement?.textContent).toBe('Edit');
    await act(async () => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement?.textContent).toBe('Archive');
    await act(async () => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a list that cannot be read says the server’s words; an empty one says so', async () => {
    vi.spyOn(inboxApi, 'manageTemplates').mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'ZZ TEST not yours'));
    const el = await mount(createElement(TemplateSettings, { me }));
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('ZZ TEST not yours');
    await unmount();
    vi.spyOn(inboxApi, 'manageTemplates').mockResolvedValue({ templates: [] as ManagedTemplate[] });
    const empty = await mount(createElement(TemplateSettings, { me }));
    expect(empty.textContent).toContain('No templates yet.');
  });
});

// --- The shared parts: the scale and the tokens ------------------------------------------

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

/** Every pair of words and ground the frame, the parts and the Templates page put on screen. */
const SETTINGS_TEXT: Array<[string, string]> = [
  // The column and the page area on the ground: titles, help, the group's title, the way back.
  ['ink', 'ground'], ['ink-soft', 'ground'], ['ink-muted', 'ground'],
  // The chosen page (the band), hovered lines (the wash), the band's chosen segment.
  ['ink', 'band'], ['ink-soft', 'band'], ['ink', 'wash'], ['ink', 'segment'],
  // Rows, menus, fields and the action bar on the card; a template still in English in amber words.
  ['ink', 'card'], ['ink-soft', 'card'], ['ink-muted', 'card'], ['ask-ink', 'card'], ['ink-soft', 'wash'],
  // A field's error line, on the dialog's ground (a phone) and its card (wider).
  ['danger-ink', 'card'], ['danger-ink', 'ground'],
  // The notes and the badges.
  ['money-ink', 'money'], ['teal', 'mint-soft'], ['ask-ink', 'ask'], ['danger-ink', 'danger'],
  ['ink-soft', 'band'], ['money-ink', 'money-badge'],
];

describe('SCRUM-1044: the shared parts on the one scale and the tested tokens', () => {
  it.each([['light', block(':root')], ['dark', block('html.dark')]] as const)('every pair of words and ground reads at 4.5 : 1 (%s)', (_, theme) => {
    for (const [ink, ground] of SETTINGS_TEXT) expect(contrast(theme, ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    // The chosen page's icon, coral on the band: a mark, 3 : 1.
    expect(contrast(theme, 'coral-ink', 'band')).toBeGreaterThanOrEqual(3);
  });

  it('the notes wear only tested pairs', () => {
    expect(NOTE_TONE).toEqual({
      success: 'bg-money text-money-ink ring-money-line',
      assistant: 'bg-mint-soft text-teal ring-mint-line',
      ask: 'bg-ask text-ask-ink ring-ask-line',
      danger: 'bg-danger text-danger-ink ring-danger-line',
    });
  });

  it('rows, menus and fields take their sizes from the scale, each control a 44 px target to a finger', () => {
    expect(SETTINGS_ROW).toContain('px-pane py-row');
    expect(MENU_ITEM).toMatch(/(?:^|\s)hit(?:\s|$)/);
    // A menu's items stand one on another: 44 px tall themselves on a touch screen (SCRUM-1045 review).
    expect(MENU_ITEM).toContain('min-h-row-touch-lg');
    const main = createElement('button', { type: 'button', className: BTN_MAIN }, 'Save');
    const parts = [
      createElement(PageHeader, { eyebrow: 'Assistant', title: 'ZZ TEST page', help: 'ZZ TEST help', actions: main }),
      createElement(SectionCard, {
        title: 'ZZ TEST section',
        aside: 2,
        help: 'ZZ TEST help',
        children: createElement('ul', null,
          createElement(SettingsRow, { title: 'ZZ TEST row', name: 'ZZ TEST row', preview: 'ZZ TEST words', meta: 'ZZ TEST meta', actions: [{ label: 'Edit', onSelect: noop }] }),
        ),
      }),
      createElement(Field, { label: 'ZZ TEST field', help: 'ZZ TEST help', error: 'ZZ TEST error', children: createElement('input', { className: INPUT }) }),
      createElement(ActionBar, { status: 'ZZ TEST status', children: main }),
      createElement(EmptyNote, { icon: FileText, title: 'ZZ TEST empty' }),
      createElement(LoadingNote, { label: 'ZZ TEST loading' }),
      createElement(InlineNote, { tone: 'success', children: 'ZZ TEST saved' }),
      createElement(InlineError, { text: 'ZZ TEST refused' }),
      createElement(RowMenuItems, { label: 'ZZ TEST menu', items: [{ label: 'Edit', onSelect: noop }], onChoose: noop }),
    ]
      .map((el: ReactElement) => renderToStaticMarkup(el))
      .join('');
    const doc = document.createElement('div');
    doc.innerHTML = parts;
    for (const b of doc.querySelectorAll('button')) {
      expect(b.className, b.textContent ?? '').toMatch(/(?:^|\s)(?:min-h|h|size)-(?:ctl|ctl-sm|ctl-lg|icon|row-touch|row-touch-lg)(?:\s|$)/);
      expect(b.className, b.textContent ?? '').toMatch(/(?:^|\s)hit(?:\s|$)/);
    }
    // The field: labelled, its help and its error tied to it, marked invalid.
    const input = doc.querySelector('input')!;
    expect(input.closest('label')?.textContent).toContain('ZZ TEST field');
    expect(input.getAttribute('aria-describedby')!.split(' ')).toHaveLength(2);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.className).toContain('min-h-field');
    expect(doc.querySelector('[role="alert"]')?.textContent).toContain('ZZ TEST refused');
    expect(parts).not.toMatch(/\b(?:bg|text|border|ring)-(?:slate|amber|indigo|emerald|violet|rose|sky|orange)-\d/);
  });
});
