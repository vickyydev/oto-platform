import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
    loading: false, loadingMore: false, error: null, filters: EMPTY_FILTERS, search: '', selectedId: selected ? row.id : null,
    now: new Date('2026-11-16T12:00:00Z'), onSearch: noop, onFilters: noop, onTab: noop, onOpenFilters: noop,
    onSelect: noop, onAskHandle: noop, onMore: noop }));
}
describe('SCRUM-992: unread and next action remain separate in the actual list markup', () => {
  it.each(INBOX_NEXT_ACTIONS)('%s is labelled in words, independent of unread or unanswered', nextAction => {
    const html = render({ nextAction, status: nextAction === 'handled' ? 'handled' : 'active' });
    expect(html).toContain(NEXT_ACTION_LABELS[nextAction]);
    expect(html).toContain('2 unread messages for you');
    expect(render({ nextAction, unread: 0 })).not.toContain('unread messages for you');
    expect(render({ nextAction, unread: 0 })).toContain(NEXT_ACTION_LABELS[nextAction]);
  });
  it('HIGH: an AI sent badge cannot be replaced by the older unanswered flag', () => {
    const html = render({ nextAction: 'ai_sent', unanswered: true });
    expect(html).toContain('AI sent · waiting for customer');
    expect(html).not.toContain('Staff reply needed');
    expect(html).not.toContain('>Unanswered<');
  });
  it('selection, keyboard focus and unread retain separate theme-aware markers', () => {
    const html = render({ nextAction: 'ai_replying' }, true);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('focus-visible:outline-2');
    expect(html).toContain('ring-emerald-700');
    expect(html).toContain('dark:ring-emerald-300');
    expect(html).toContain('border-l-indigo-600');
    expect(html).toContain('dark:border-l-indigo-400');
    expect(conversationRowColour(false, 0)).not.toContain('bg-indigo-50');
  });
  it('an unread handled conversation retains its personal unread count', () => {
    expect(render({ status: 'handled', nextAction: 'handled' })).toContain('2 unread messages for you');
  });
});

// Read the installed OTO theme palette itself. OKLCH -> linear sRGB -> WCAG
// luminance; no hand-copied colours that could stay green after a theme change.
const theme = readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8');
function luminance(colour: string): number {
  if (colour === 'white') return 1;
  const match = theme.match(new RegExp(`--color-${colour}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`));
  if (!match) throw new Error(`Missing theme colour: ${colour}`);
  const light = Number(match[1]) / 100, chroma = Number(match[2]), angle = Number(match[3]) * Math.PI / 180;
  const a = chroma * Math.cos(angle), b = chroma * Math.sin(angle);
  const l = (light + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (light - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (light - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return 0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
    + 0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
    + 0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}
function themeColour(classes: string, prefix: string, dark: boolean): string {
  const tokens = classes.split(' '), start = `${dark ? 'dark:' : ''}${prefix}-`;
  const value = tokens.find(token => token.startsWith(start) && /^(?:[a-z]+-\d+|white)$/.test(token.slice(start.length)));
  if (!value) throw new Error(`Missing ${start} colour`);
  return value.slice(start.length);
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe('SCRUM-992: actual OTO palette contrast in both themes', () => {
  it.each([false, true])('every next-action and unread text meets4.5:1 (dark=%s)', dark => {
    // SCRUM-996: the deposit's labels stand beside these, held to the same contrast.
    for (const classes of [...Object.values(NEXT_ACTION_COLOURS), ...Object.values(DEPOSIT_SIGNAL_COLOURS)]) {
      expect(contrast(themeColour(classes, 'text', dark), themeColour(classes, 'bg', dark))).toBeGreaterThanOrEqual(4.5);
    }
    const badgeClasses = render().match(/aria-label="2 unread messages for you" class="([^"]+)"/)![1]!;
    expect(contrast(themeColour(badgeClasses, 'text', dark), themeColour(badgeClasses, 'bg', dark))).toBeGreaterThanOrEqual(4.5);
    const selected = conversationRowColour(true, 2);
    expect(contrast(themeColour(selected, 'ring', dark), themeColour(selected, 'bg', dark))).toBeGreaterThanOrEqual(3);
  });
});
