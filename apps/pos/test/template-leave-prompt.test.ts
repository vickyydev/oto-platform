import { describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import {
  useUnsavedChangesPrompt,
  type UnloadTarget,
} from '@/components/admin/templates/useUnsavedChangesPrompt';

vi.mock('react', () => import('./support/hooks'));

/**
 * SCRUM-472 fix round — the Print Templates editor asks before a reload or a
 * closed tab drops its unsaved changes.
 *
 * The editor's own "All templates" link already nudged the save bar; nothing
 * covered the browser leaving the page. The prompt is the browser's own, and
 * it is raised only while something is unsaved: an untouched template leaves
 * without a word.
 */

type Listener = (event: BeforeUnloadEvent) => void;

function fakeWindow() {
  const listeners = new Set<Listener>();
  const target: UnloadTarget = {
    addEventListener: ((type: string, listener: Listener) => {
      if (type === 'beforeunload') listeners.add(listener);
    }) as UnloadTarget['addEventListener'],
    removeEventListener: ((type: string, listener: Listener) => {
      if (type === 'beforeunload') listeners.delete(listener);
    }) as UnloadTarget['removeEventListener'],
  };
  /** What a reload does: every listener sees one event. True when one held the page. */
  const unload = () => {
    let prevented = false;
    const event = {
      returnValue: undefined as unknown,
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of listeners) listener(event as unknown as BeforeUnloadEvent);
    return { prevented, returnValue: event.returnValue };
  };
  return { target, listeners, unload };
}

describe('asking before the page is left with unsaved changes', () => {
  it('says nothing while the template is untouched', () => {
    const win = fakeWindow();
    renderHook(() => useUnsavedChangesPrompt(false, win.target));
    expect(win.listeners.size).toBe(0);
    expect(win.unload().prevented).toBe(false);
  });

  it('holds a reload while there are changes, and lets go once they are saved or discarded', () => {
    const win = fakeWindow();
    const hook = renderHook<boolean, void>(
      (dirty) => useUnsavedChangesPrompt(dirty, win.target),
      true,
    );
    const held = win.unload();
    expect(held.prevented).toBe(true);
    // The legacy half older Chrome and Edge read.
    expect(held.returnValue).toBe(true);

    hook.rerender(false);
    expect(win.listeners.size).toBe(0);
    expect(win.unload().prevented).toBe(false);

    hook.rerender(true);
    expect(win.listeners.size).toBe(1);
  });

  it('leaves nothing behind when the editor closes', () => {
    const win = fakeWindow();
    const hook = renderHook(() => useUnsavedChangesPrompt(true, win.target));
    expect(win.listeners.size).toBe(1);
    hook.unmount();
    expect(win.listeners.size).toBe(0);
  });
});
