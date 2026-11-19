// @vitest-environment jsdom
//
// SCRUM-1016 — the house Dialog (inventory §7 item 18: "focus goes to ✕ on
// open, but there is no focus trap and focus is not returned"): the title
// names the dialog and the subtitle describes it, focus goes in on opening,
// Tab and Shift+Tab wrap inside, a focus that lands outside is brought back,
// Escape closes, and on closing focus goes back to the control that opened
// it. One dialog over another: only the top one answers. On a phone a dialog
// is a full-height sheet (BookDate.dc.html); from 768 px the centred card.
//
// FICTIONAL TEST DATA: no customer, no account.
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Calendar } from 'lucide-react';
import { Dialog } from '@/components/Dialog';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
}

const tab = async (shiftKey = false) => {
  // jsdom moves no focus on a key: the trap's own move is what is measured,
  // and when it lets the key through, the test steps as a browser would.
  const before = document.activeElement;
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(e);
  });
  return { prevented: e.defaultPrevented, moved: document.activeElement !== before };
};
const escape = async () => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
};
const byText = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;

/** A page with an opener, the dialog it opens, and a second dialog over the first. */
function Page({ onFirstClose }: { onFirstClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Open'),
    createElement('button', { type: 'button' }, 'Behind'),
    createElement(
      Dialog,
      {
        open,
        onClose: () => {
          onFirstClose?.();
          setOpen(false);
        },
        icon: Calendar,
        title: 'ZZ TEST dialog',
        subtitle: 'What it is for',
        footer: createElement('button', { type: 'button', onClick: () => setOver(true) }, 'Ask over it'),
      },
      createElement('input', { 'aria-label': 'First field' }),
      createElement('button', { type: 'button', disabled: true }, 'Off'),
      createElement('select', { 'aria-label': 'A choice' }, createElement('option', null, 'one')),
    ),
    createElement(
      Dialog,
      { open: over, onClose: () => setOver(false), title: 'ZZ TEST confirmation' },
      createElement('button', { type: 'button' }, 'Inner'),
    ),
  );
}

describe('SCRUM-1016: the house Dialog holds focus and gives it back', () => {
  it('is named by its title and described by its subtitle; focus starts on the close control', async () => {
    await mount(createElement(Page));
    const opener = byText('Open');
    opener.focus();
    await act(async () => opener.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('ZZ TEST dialog');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('What it is for');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.tagName).toBe('H2');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
  });

  it('Tab from the last control wraps to the first, Shift+Tab from the first to the last; a disabled one is skipped', async () => {
    await mount(createElement(Page));
    byText('Open').focus();
    await act(async () => byText('Open').click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const last = byText('Ask over it');
    last.focus();
    expect(await tab()).toEqual({ prevented: true, moved: true });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    expect(await tab(true)).toEqual({ prevented: true, moved: true });
    expect(document.activeElement).toBe(last);
    // Inside, between the first and the last, the browser's own Tab is left alone.
    dialog.querySelector<HTMLInputElement>('input')!.focus();
    expect((await tab()).prevented).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('a focus that lands outside the open dialog is brought back in', async () => {
    await mount(createElement(Page));
    byText('Open').focus();
    await act(async () => byText('Open').click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => byText('Behind').focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Escape closes it and focus goes back to the control that opened it', async () => {
    const closed = vi.fn();
    await mount(createElement(Page, { onFirstClose: closed }));
    const opener = byText('Open');
    opener.focus();
    await act(async () => opener.click());
    expect(document.activeElement).not.toBe(opener);
    await escape();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closing with its own close control also gives focus back', async () => {
    await mount(createElement(Page));
    const opener = byText('Open');
    opener.focus();
    await act(async () => opener.click());
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('one dialog over another: only the top one holds Tab and answers Escape, then focus steps back down', async () => {
    const closed = vi.fn();
    await mount(createElement(Page, { onFirstClose: closed }));
    const opener = byText('Open');
    opener.focus();
    await act(async () => opener.click());
    const ask = byText('Ask over it');
    ask.focus();
    await act(async () => ask.click());
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    const top = dialogs[1]!;
    expect(top.contains(document.activeElement)).toBe(true);
    await tab();
    expect(top.contains(document.activeElement)).toBe(true);
    await escape();
    expect(closed).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(ask);
    await escape();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });
});

describe('SCRUM-1016: a phone gets a full-height sheet, a wider screen the centred card', () => {
  const html = renderToStaticMarkup(
    createElement(Dialog, { open: true, onClose: () => undefined, icon: Calendar, title: 'ZZ TEST', footer: 'f', children: 'b' }),
  );
  const panel = /<div role="dialog"[^>]*class="([^"]*)"/.exec(html)![1]!;

  it('below 768 px the panel fills the screen under the view-as banner, on the cream ground', () => {
    expect(panel.split(' ')).toEqual(expect.arrayContaining(['h-full', 'w-full', 'bg-ground']));
    expect(html).toContain('top-[var(--view-as-offset,0px)]');
    // The icon waits for the wider card; the close control is 44 px.
    expect(html).toMatch(/class="hidden h-10 w-10[^"]*md:flex/);
    expect(html).toMatch(/aria-label="Close" class="flex h-11 w-11/);
    // The footer's last control, its main one, takes the footer's width.
    expect(html).toContain('max-md:[&amp;&gt;*:last-child]:flex-1');
  });

  it('from 768 px it is the centred card it was, capped to the window', () => {
    expect(panel.split(' ')).toEqual(expect.arrayContaining(['md:h-auto', 'md:max-h-full', 'md:rounded-2xl', 'md:bg-card', 'md:max-w-md']));
    expect(html).toContain('md:items-center md:justify-center md:p-4');
  });
});
