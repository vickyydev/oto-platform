import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * SCRUM-223 — the red button while the staff sign-in form has the keyboard.
 *
 * The button and the keyboard's space bar send the same key, so a press there
 * cannot be told from a space typed into a password: the page lets the field
 * have the key, draws nothing, and says so on screen (`onPressWhileTyping`).
 * Everywhere else the key is a press, as before.
 *
 * There is no DOM under Node's test runner, so the listener is driven the way
 * a browser would drive it: `window` and `HTMLElement` are stood in before the
 * module is loaded, and events are plain objects with the fields it reads.
 */

type Handler = (event: FakeKey) => void;
const handlers = new Map<string, Handler>();

// No parameter properties: this suite runs under Node's strip-only mode.
class FakeElement {
  readonly isContentEditable = false;
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
}

interface FakeKey {
  key: string;
  code: string;
  repeat: boolean;
  target: FakeElement;
  defaultPrevented: boolean;
  preventDefault(): void;
}

Object.assign(globalThis, {
  HTMLElement: FakeElement,
  window: {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    removeEventListener: (type: string) => handlers.delete(type),
  },
});

const { installKeyboardKeeper, installPressListener, KEYBOARD_CHECK_MS, KEYBOARD_RECLAIM_DELAY_MS, registerButtonOverlay } =
  await import('../src/press.ts');

function key(type: 'keydown' | 'keyup', target: FakeElement, repeat = false): FakeKey {
  const event: FakeKey = {
    key: ' ',
    code: 'Space',
    repeat,
    target,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  handlers.get(type)?.(event);
  return event;
}

function listen() {
  const seen = { presses: 0, held: 0 };
  const remove = installPressListener({
    buttonKey: 'Space',
    lockoutMs: () => 0,
    onPress: () => (seen.presses += 1),
    onPressWhileTyping: () => (seen.held += 1),
  });
  return { seen, remove };
}

const body = new FakeElement('BODY');
const password = new FakeElement('INPUT');

test('on the game the button key spins immediately; overlays move, select and repeat', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
  const { seen, remove } = listen();
  const down = key('keydown', body);
  const up = key('keyup', body);
  assert.equal(seen.presses, 1);
  assert.equal(seen.held, 0);
  assert.equal(down.defaultPrevented, true);
  assert.equal(up.defaultPrevented, true);
  let moves = 0;
  let selections = 0;
  const removeOverlay = registerButtonOverlay({
    move: () => moves++,
    select: () => selections++,
    touch: () => {},
  });
  key('keydown', body);
  key('keyup', body);
  t.mock.timers.tick(400);
  assert.equal(moves, 1);
  key('keydown', body);
  key('keyup', body);
  t.mock.timers.tick(200);
  key('keydown', body);
  key('keyup', body);
  assert.equal(selections, 1);
  assert.equal(moves, 1, 'a double press selects the existing highlight');
  t.mock.timers.tick(401);
  key('keydown', body);
  t.mock.timers.tick(600);
  const beforeRepeats = moves;
  t.mock.timers.tick(500);
  assert.equal(moves, beforeRepeats + 2);
  key('keyup', body);
  assert.equal(seen.presses, 1, 'overlay presses never spin');
  removeOverlay();
  remove();
  let opened = 0;
  let spins = 0;
  const stop = installPressListener({
    buttonKey: 'Space',
    lockoutMs: () => 0,
    onPress: () => spins++,
    canOpenStaff: () => true,
    onOpenStaff: () => opened++,
  });
  key('keydown', body);
  assert.equal(spins, 1, 'no delay on the ready wheel');
  t.mock.timers.tick(2_999);
  assert.equal(opened, 0);
  t.mock.timers.tick(1);
  assert.equal(opened, 1);
  key('keyup', body);
  assert.equal(spins, 1);
  stop();
});

test('in a staff field the key is the field’s: nothing is drawn, and the page is told', () => {
  const { seen, remove } = listen();
  const down = key('keydown', password);
  assert.equal(seen.presses, 0, 'no spin — a space in a password would give a prize away');
  assert.equal(seen.held, 1, 'the screen says staff are signing in');
  assert.equal(down.defaultPrevented, false, 'the field keeps the character');
  // Held down, the key repeats: one notice, still no press.
  key('keydown', password, true);
  assert.equal(seen.held, 1);
  // And its release is not a press either, even if the form has gone by then.
  key('keyup', body);
  assert.equal(seen.presses, 0);
  remove();
});

test('a release whose press was swallowed elsewhere is still a press — but not in a field', () => {
  const { seen, remove } = listen();
  key('keyup', body);
  assert.equal(seen.presses, 1, 'a keydown something ate: the release is the press');
  key('keyup', password);
  assert.equal(seen.presses, 1, 'a release in a field is the field’s');
  remove();
});

test('SCRUM-467: a wall clock stepped back does not hold the lockout', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 50_000_000 });
  let presses = 0;
  const remove = installPressListener({ buttonKey: 'Space', lockoutMs: () => 350, onPress: () => presses++ });
  key('keydown', body);
  key('keyup', body);
  assert.equal(presses, 1);
  key('keydown', body);
  key('keyup', body);
  assert.equal(presses, 1, 'a bounce inside the lockout is still ignored');
  // Time sync pulls a clock that ran an hour ahead back into step.
  t.mock.timers.setTime(50_000_000 - 3_600_000);
  key('keydown', body);
  key('keyup', body);
  assert.equal(presses, 2, 'the button answers at once, not an hour later');
  remove();
});

test('SCRUM-467: the kiosk takes the keyboard back when its window loses it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const on = new Map<string, () => void>();
  let focused = true;
  let focusCalls = 0;
  const win = {
    addEventListener: (type: string, h: () => void) => on.set(`win:${type}`, h),
    removeEventListener: (type: string) => on.delete(`win:${type}`),
    focus: () => {
      focusCalls++;
    },
  };
  const doc = {
    addEventListener: (type: string, h: () => void) => on.set(`doc:${type}`, h),
    removeEventListener: (type: string) => on.delete(`doc:${type}`),
    hasFocus: () => focused,
  };
  const log: string[] = [];
  const remove = installKeyboardKeeper({ win, doc, onLost: () => log.push('lost'), onBack: () => log.push('back') });
  t.mock.timers.tick(KEYBOARD_CHECK_MS);
  assert.equal(focusCalls, 0, 'a focused window is left alone');
  focused = false;
  on.get('win:blur')?.();
  t.mock.timers.tick(KEYBOARD_RECLAIM_DELAY_MS);
  assert.equal(focusCalls, 1, 'the blur is answered within a second');
  t.mock.timers.tick(KEYBOARD_CHECK_MS);
  assert.equal(focusCalls, 2, 'and retried while the window stays unfocused');
  on.get('doc:visibilitychange')?.();
  assert.equal(focusCalls, 3, 'the page shown again asks at once');
  assert.deepEqual(log, ['lost'], 'one line per loss, not one per try');
  focused = true;
  on.get('win:focus')?.();
  t.mock.timers.tick(KEYBOARD_CHECK_MS);
  assert.equal(focusCalls, 3);
  assert.deepEqual(log, ['lost', 'back']);
  remove();
  assert.equal(on.size, 0, 'every listener is removed');
});
