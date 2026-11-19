// @vitest-environment jsdom
// SCRUM-1045 — the divider between the list and the chat, in a DOM: its
// separator role and values, the keyboard (16 px a press, Home and End,
// Enter back to the default), a drag with a mouse, a finger or a pen (live
// widths while moving, one commit on release, the pointer captured, no text
// selected on the way), and a double click or a double tap back to the
// default. A press that does not move is a tap, never a drag.
//
// FICTIONAL TEST DATA: no people, only widths.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DIVIDER_LABEL, PaneDivider } from '@/components/PaneDivider';
import { LIST_MIN, listMax } from '@/lib/panes';

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
  document.body.removeAttribute('style');
});

const ROOM = 768;
async function mount(width = 276) {
  const onLive = vi.fn();
  const onCommit = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(PaneDivider, { width, room: ROOM, max: listMax(ROOM), left: 'var(--list-w)', controls: 'inbox-list', onLive, onCommit }),
    ),
  );
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  // jsdom has no pointer capture: record what the divider asks for.
  const captured: number[] = [];
  handle.setPointerCapture = (id: number) => void captured.push(id);
  handle.releasePointerCapture = () => undefined;
  return { handle, onLive, onCommit, captured };
}

const key = async (el: HTMLElement, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  await act(async () => void el.dispatchEvent(e));
  return e.defaultPrevented;
};

// jsdom lacks PointerEvent: a MouseEvent carrying the pointer's fields is what React reads.
function pointer(type: string, init: { x: number; id?: number; kind?: string; button?: number; t?: number }) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x, button: init.button ?? 0 });
  Object.defineProperties(e, {
    pointerId: { value: init.id ?? 1 },
    pointerType: { value: init.kind ?? 'mouse' },
    ...(init.t !== undefined ? { timeStamp: { value: init.t } } : {}),
  });
  return e;
}
const fire = async (el: HTMLElement, e: Event) => {
  await act(async () => void el.dispatchEvent(e));
  return e;
};

describe('SCRUM-1045: the divider is a separator a person can find and read', () => {
  it('names itself, says its orientation and its value in px, and the list it resizes', async () => {
    const { handle } = await mount(300);
    expect(handle.getAttribute('aria-label')).toBe(DIVIDER_LABEL);
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
    expect(handle.getAttribute('aria-valuemin')).toBe(String(LIST_MIN));
    expect(handle.getAttribute('aria-valuemax')).toBe(String(listMax(ROOM)));
    expect(handle.getAttribute('aria-controls')).toBe('inbox-list');
    expect(handle.tabIndex).toBe(0);
    // A wide grab area (16 px, 24 px to a finger) over the 1 px edge, the col-resize cursor, no scrolling under a finger.
    expect(handle.className).toContain('w-4');
    expect(handle.className).toContain('[@media(any-pointer:coarse)]:w-6');
    expect(handle.className).toContain('cursor-col-resize');
    expect(handle.className).toContain('touch-none');
    expect(handle.className).toContain('select-none');
  });
});

describe('SCRUM-1045: the keyboard', () => {
  it('Right and Left move the list 16 px, Home and End go to its limits, Enter back to the default', async () => {
    const { handle, onCommit } = await mount(300);
    expect(await key(handle, 'ArrowRight')).toBe(true);
    expect(onCommit).toHaveBeenLastCalledWith(316);
    await key(handle, 'ArrowLeft');
    expect(onCommit).toHaveBeenLastCalledWith(284);
    await key(handle, 'Home');
    expect(onCommit).toHaveBeenLastCalledWith(LIST_MIN);
    await key(handle, 'End');
    expect(onCommit).toHaveBeenLastCalledWith(listMax(ROOM));
    await key(handle, 'Enter');
    expect(onCommit).toHaveBeenLastCalledWith('default');
  });

  it('leaves every other key alone (Tab still moves on)', async () => {
    const { handle, onCommit } = await mount(300);
    expect(await key(handle, 'Tab')).toBe(false);
    expect(await key(handle, 'ArrowUp')).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('SCRUM-1045: a drag', () => {
  it('follows the pointer live, within the limits, and commits once on release', async () => {
    const { handle, onLive, onCommit, captured } = await mount(276);
    const down = await fire(handle, pointer('pointerdown', { x: 276 }));
    expect(down.defaultPrevented).toBe(true); // no text selection, no native drag
    expect(captured).toEqual([1]);
    expect(handle.getAttribute('data-dragging')).toBe('true');
    expect(document.body.style.getPropertyValue('user-select')).toBe('none');
    expect(document.body.style.getPropertyValue('cursor')).toBe('col-resize');

    await fire(handle, pointer('pointermove', { x: 300 }));
    expect(onLive).toHaveBeenLastCalledWith(300);
    await fire(handle, pointer('pointermove', { x: 20 }));
    expect(onLive).toHaveBeenLastCalledWith(LIST_MIN);
    await fire(handle, pointer('pointermove', { x: 2000 }));
    expect(onLive).toHaveBeenLastCalledWith(listMax(ROOM));
    await fire(handle, pointer('pointermove', { x: 330 }));
    expect(onCommit).not.toHaveBeenCalled();

    await fire(handle, pointer('pointerup', { x: 330 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(330);
    expect(handle.getAttribute('data-dragging')).toBeNull();
    expect(document.body.style.getPropertyValue('user-select')).toBe('');
    // The capture's loss after the release finishes nothing twice.
    await fire(handle, pointer('lostpointercapture', { x: 330 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('works the same for a finger and a pen, and ignores another pointer meanwhile', async () => {
    for (const kind of ['touch', 'pen']) {
      const { handle, onLive, onCommit } = await mount(276);
      await fire(handle, pointer('pointerdown', { x: 276, id: 7, kind }));
      await fire(handle, pointer('pointermove', { x: 320, id: 8, kind }));
      expect(onLive).not.toHaveBeenCalled();
      await fire(handle, pointer('pointermove', { x: 310, id: 7, kind }));
      await fire(handle, pointer('pointerup', { x: 310, id: 7, kind }));
      expect(onCommit).toHaveBeenCalledWith(310);
      await act(async () => root!.unmount());
      root = null;
    }
  });

  it('a cancelled drag keeps where it got to; a right click does nothing', async () => {
    const { handle, onCommit, onLive } = await mount(276);
    await fire(handle, pointer('pointerdown', { x: 276, button: 2 }));
    await fire(handle, pointer('pointermove', { x: 320 }));
    expect(onLive).not.toHaveBeenCalled();
    await fire(handle, pointer('pointerdown', { x: 276 }));
    await fire(handle, pointer('pointermove', { x: 296 }));
    await fire(handle, pointer('pointercancel', { x: 296 }));
    expect(onCommit).toHaveBeenCalledWith(296);
  });

  it('a press that moves less than 4 px is a tap: nothing changes', async () => {
    const { handle, onLive, onCommit } = await mount(276);
    await fire(handle, pointer('pointerdown', { x: 276, kind: 'touch', t: 1000 }));
    await fire(handle, pointer('pointermove', { x: 278, kind: 'touch' }));
    await fire(handle, pointer('pointerup', { x: 278, kind: 'touch', t: 1080 }));
    expect(onLive).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('SCRUM-1045: back to the default', () => {
  it('on a double tap', async () => {
    const { handle, onCommit } = await mount(330);
    for (const t of [1000, 1200]) {
      await fire(handle, pointer('pointerdown', { x: 330, kind: 'touch', t }));
      await fire(handle, pointer('pointerup', { x: 330, kind: 'touch', t: t + 60 }));
    }
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('default');
  });

  it('not on two taps far apart', async () => {
    const { handle, onCommit } = await mount(330);
    for (const t of [1000, 2000]) {
      await fire(handle, pointer('pointerdown', { x: 330, kind: 'touch', t }));
      await fire(handle, pointer('pointerup', { x: 330, kind: 'touch', t: t + 60 }));
    }
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('on a double click', async () => {
    const { handle, onCommit } = await mount(330);
    await fire(handle, new MouseEvent('dblclick', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledWith('default');
  });
});
