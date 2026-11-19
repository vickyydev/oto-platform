import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INBOX_NEXT_ACTIONS } from '@oto/shared';
import type { ConversationRow, InboxMe } from '@/api/inbox';
import { ConversationList } from '@/components/ConversationList';
import { conversationRowColour, DEPOSIT_SIGNAL_COLOURS, NEXT_ACTION_COLOURS, NEXT_ACTION_LABELS } from '@/lib/list-state';
import { EMPTY_FILTERS } from '@/lib/query';

const me: InboxMe = { accountId: 'viewer', name: 'ZZ TEST viewer', roles: ['owner'], tabs: ['team', 'handled'],
  teams: [], people: [], defaultReceptionBranchId: null,
  capabilities: { writes: true, dashboard: false, assign: false, move: false, reopen: false, templates: false, kb: false, ai: false }, simulator: null };
const row: ConversationRow = { id: 'conversation', channel: 'whatsapp', channelAccountId: 'line',
  channelAccountName: 'ZZ TEST line', canReply: true,
  contact: { id: 'contact', channel: 'whatsapp', handle: 'ZZ TEST', displayName: 'ZZ TEST guest', phone: null, language: 'en', erased: false },
  category: 'general', intent: null, language: 'en', branchId: null, teamId: null, status: 'active',
  handledAt: null, handledByKind: null, lastMessageAt: '2026-11-16T12:00:00Z', lastMessagePreview: 'ZZ TEST question',
  unanswered: true, unread: 2, mine: false, assignments: [], createdAt: '2026-11-16T12:00:00Z' };
const noop = () => undefined;
function render(over: Partial<ConversationRow> = {}, selected = false) {
  return renderToStaticMarkup(createElement(ConversationList, { me, tab: 'team', page: null, rows: [{ ...row, ...over }],
    loading: false, loadingMore: false, error: null, filters: EMPTY_FILTERS, selectedId: selected ? row.id : null,
    now: new Date('2026-11-16T12:00:00Z'), onFilters: noop, onTab: noop, onOpenFilters: noop,
    onSelect: noop, onMore: noop }));
}
/** The row's own `<button …>` tag. */
const rowTag = (html: string) => /<button type="button"[^>]*data-next-action="[^"]*"[^>]*>/.exec(html)?.[0] ?? '';

describe('SCRUM-992: unread and next action remain separate in the actual list markup', () => {
  it.each(INBOX_NEXT_ACTIONS)('%s is labelled in words, independent of unread or unanswered', nextAction => {
    const html = render({ nextAction, status: nextAction === 'handled' ? 'handled' : 'active' });
    expect(html).toContain(NEXT_ACTION_LABELS[nextAction]);
    expect(html).toContain('2 unread messages for you');
    expect(render({ nextAction, unread: 0 })).not.toContain('unread messages for you');
    expect(render({ nextAction, unread: 0 })).toContain(NEXT_ACTION_LABELS[nextAction]);
  });
  // SCRUM-1016: the shorter words (owner choice 1, approved as drawn).
  it('says what happens next in the shorter words', () => {
    expect(NEXT_ACTION_LABELS).toEqual({
      staff_reply_needed: 'Needs reply',
      staff_action_needed: 'Needs action',
      ai_replying: 'Assistant replying',
      ai_previewing: 'Assistant preview · not sent',
      shadow_preview: 'Assistant preview · not sent',
      ai_sent: 'Assistant answered',
      waiting_customer: 'Waiting for customer',
      handled: 'Handled',
    });
  });
  it('HIGH: an AI sent badge cannot be replaced by the older unanswered flag', () => {
    const html = render({ nextAction: 'ai_sent', unanswered: true });
    expect(html).toContain('>Assistant answered<');
    expect(html).not.toContain('Needs reply');
    expect(html).not.toContain('>Unanswered<');
  });
  // SCRUM-1016: selection is the band's ground inside a 2 px ink ring (no bar
  // at the edge); unread is the heavier name and the coral count, never a ground.
  it('selection, keyboard focus and unread retain separate theme-aware markers', () => {
    const selected = rowTag(render({ nextAction: 'ai_replying' }, true));
    expect(selected).toContain('aria-current="true"');
    expect(selected).toContain('focus-visible:outline-2');
    expect(selected).toContain('focus-visible:outline-coral');
    expect(selected).toContain('ring-2 ring-inset ring-ink');
    expect(selected).toContain('bg-band');
    expect(selected).not.toMatch(/border-l-\d|border-l-indigo/);
    const unread = render({ nextAction: 'ai_replying' });
    expect(rowTag(unread)).not.toContain('ring-ink');
    expect(rowTag(unread)).not.toContain('bg-band');
    // SCRUM-1016 (review): the name sits at a tight leading, as Main.dc.html sets it.
    expect(unread).toMatch(/text-\[15px\] leading-tight text-ink font-extrabold">ZZ TEST guest</);
    expect(unread).toMatch(/aria-label="2 unread messages for you" class="[^"]*bg-coral[^"]*text-on-coral/);
    expect(render({ unread: 0 })).toMatch(/text-\[15px\] leading-tight text-ink font-semibold">ZZ TEST guest</);
    expect(conversationRowColour(false)).not.toContain('ring');
  });
  it('an unread handled conversation retains its personal unread count', () => {
    expect(render({ status: 'handled', nextAction: 'handled' })).toContain('2 unread messages for you');
  });
});

// The OTO tokens themselves, read from src/index.css (as tokens-1016.test.ts
// does): no hand-copied colour can stay green after a token changes.
const css = readFileSync(path.resolve(import.meta.dirname, '..', 'src/index.css'), 'utf8');
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--oto-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const themes = { light: block(':root'), dark: block('html.dark') };
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
}
/** The token a class names (`bg-needs` → `needs`), from a set of classes. */
function token(classes: string, prefix: 'bg' | 'text' | 'ring'): string {
  const found = classes.split(' ').find((c) => c.startsWith(`${prefix}-`) && !/^(?:text|ring)-\[|^ring-\d|^ring-inset/.test(c));
  if (!found) throw new Error(`Missing ${prefix} token in "${classes}"`);
  return found.slice(prefix.length + 1);
}
function contrast(theme: Record<string, string>, a: string, b: string): number {
  if (!theme[a] || !theme[b]) throw new Error(`Not a token: ${a} or ${b}`);
  const x = luminance(theme[a]!), y = luminance(theme[b]!);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe('SCRUM-992: the OTO palette’s contrast in both themes', () => {
  it.each(['light', 'dark'] as const)('every next-action, deposit and unread text meets 4.5:1 (%s)', name => {
    const theme = themes[name];
    // SCRUM-996: the deposit's labels stand beside these, held to the same contrast.
    for (const classes of [...Object.values(NEXT_ACTION_COLOURS), ...Object.values(DEPOSIT_SIGNAL_COLOURS)]) {
      expect(contrast(theme, token(classes, 'text'), token(classes, 'bg')), classes).toBeGreaterThanOrEqual(4.5);
    }
    const badgeClasses = render().match(/aria-label="2 unread messages for you" class="([^"]+)"/)![1]!;
    expect(contrast(theme, token(badgeClasses, 'text'), token(badgeClasses, 'bg'))).toBeGreaterThanOrEqual(4.5);
    // The selected ring stands out from its ground, and from a Ready to book row's.
    for (const ready of [false, true]) {
      const selected = conversationRowColour(true, ready);
      expect(contrast(theme, 'ink', token(selected, 'bg'))).toBeGreaterThanOrEqual(3);
    }
  });
});
