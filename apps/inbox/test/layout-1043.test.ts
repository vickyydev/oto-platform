// SCRUM-1043 — the small layout repairs a sweep of every screen at real
// device sizes found after the redesign (phones 360 to 430 px, tablets 744 to
// 1366 px, desktops 1280 to 1920 px, both themes). Read from the source and
// rendered markup, as the other layout pins of this app are.
//
// FICTIONAL TEST DATA: every name is "ZZ TEST".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PersonRow } from '@/components/ChatActions';
import { BTN_MAIN, INPUT } from '@/components/ui';

const src = (file: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', file), 'utf8');
const chip = { initials: 'ZV', name: 'ZZ TEST Vera', tint: 'bg-band text-ink-soft' } as Parameters<typeof PersonRow>[0]['chip'];

describe('SCRUM-1043: layout repairs', () => {
  it('a person’s words keep together and step under the name when the card is narrow, the face beside the name', () => {
    const html = renderToStaticMarkup(
      createElement(PersonRow, { chip, role: 'Support · 1 of 2' }, createElement('button', { type: 'button' }, 'Change'), createElement('button', { type: 'button' }, 'Remove')),
    );
    // The name keeps 10 rem; the two words wrap as one group, right-aligned.
    expect(html).toContain('flex min-w-0 flex-1 flex-wrap items-center justify-end');
    expect(html).toContain('flex min-w-0 flex-1 basis-40 flex-col');
    expect(html).toMatch(/<span class="flex shrink-0 items-center"><button type="button">Change<\/button><button type="button">Remove<\/button><\/span>/);
    expect(html).toContain('flex min-h-14 items-start gap-3');
    expect(html).toContain('>ZZ TEST Vera<');
  });

  it('a line’s time and its delivery word stay on one line together', () => {
    expect(src('components/MessageBubble.tsx')).toMatch(
      /<span className="inline-flex items-center gap-x-2 whitespace-nowrap">\s*<span>\{bubbleTime\(m\.sentAt \?\? m\.createdAt, now\)\}<\/span>\s*\{m\.direction === 'outbound' && <Delivery status=\{m\.providerStatus\} \/>\}\s*<\/span>/,
    );
  });

  it('a main button too long for one line breaks into even lines; a field is 44 px at least on a touch screen', () => {
    expect(BTN_MAIN).toContain('text-balance text-center');
    expect(INPUT.startsWith('min-h-field ')).toBe(true);
  });

  it('the paid deposit’s card keeps 12 px of ground under it, and the thread fades out below it', () => {
    const chat = src('components/ChatPanel.tsx');
    expect(chat).toContain('card(false, `mx-pane mb-3 mt-3 shrink-0 ${panelOff}`)');
    expect(chat).toContain("showCard ? '[mask-image:linear-gradient(to_bottom,transparent,black_0.875rem)]' : ''");
    // In the desktop panel the card stands at the top: no Party heading over nothing.
    expect(chat).toContain("conv.category === 'birthdays' && !(panel && showCard && !removedEvent) && (");
    expect(src('components/ChatActions.tsx')).toContain('<span className="text-pretty text-note">{card.detail}</span>');
    // The card's buttons are the scale's large control with a touch target, not a height of their own.
    expect(src('components/ChatActions.tsx')).not.toContain('h-[46px]');
  });

  it('the app bar’s figures keep room inside the pressed edge and a 44 px target; the sheet’s Mark as handled too', () => {
    const stats = src('components/StatsRow.tsx');
    expect(stats).toContain("bar ? 'min-h-ctl-lg rounded-xl px-3 py-1'");
    expect(stats).toContain('className={`hit flex min-w-0 items-stretch transition hover:bg-wash');
    expect(src('components/ChatPanel.tsx').match(/\$\{SECONDARY_BUTTON\} hit min-h-ctl-lg w-full border-ink/g)).toHaveLength(2);
  });

  it('the people on the assistant’s line overlap by 4 px, so each pair of initials reads whole', () => {
    expect(src('components/ChatPanel.tsx')).toContain("${i > 0 ? '-ml-1' : ''}");
  });
});
