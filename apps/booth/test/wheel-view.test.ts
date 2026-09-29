import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { boothSpinDurationSeconds } from '../../../packages/shared/src/booth.ts';
import { groupBoothCode, sliceIndexFor, visiblePrizes } from '../src/booth/wheel-view.ts';

/**
 * SCRUM-223 — the television draws only switched-on prizes, and still stops
 * on the prize the box drew.
 */

function prize(id: string, active: boolean) {
  return {
    id,
    nameEn: id,
    nameTh: null,
    wheelLabel: null,
    weightBp: active ? 5000 : 0,
    active,
    dailyCap: null,
    expiryDays: 14,
    costSatang: 0,
    sliceColor: null,
    textColor: null,
    sortOrder: 0,
    voucherDefinitionId: null,
  };
}

const bundle = {
  prizes: [prize('p100', true), prize('mystery', false), prize('p150', true), prize('off2', false)],
};

test('a switched-off prize is never a slice', () => {
  const visible = visiblePrizes(bundle);
  assert.deepEqual(
    visible.map((v) => v.prize.id),
    ['p100', 'p150'],
  );
  assert.equal(visible.some((v) => !v.prize.active), false);
  assert.deepEqual(visiblePrizes(null), []);
});

test('the slice to stop on is found by the prize, not by its place in the bundle', () => {
  const visible = visiblePrizes(bundle);
  // p150 is third in the bundle and second on the wheel.
  assert.equal(sliceIndexFor(visible, { prizeIndex: 2, prizeId: 'p150' }), 1);
  assert.equal(sliceIndexFor(visible, { prizeIndex: 0, prizeId: 'p100' }), 0);
  // A drifted index still lands on the named prize.
  assert.equal(sliceIndexFor(visible, { prizeIndex: 3, prizeId: 'p150' }), 1);
  // A prize the wheel does not show (or does not have) has no slice.
  assert.equal(sliceIndexFor(visible, { prizeIndex: 1, prizeId: 'mystery' }), null);
  assert.equal(sliceIndexFor(visible, { prizeIndex: 0, prizeId: 'nope' }), null);
});

test('a code is shown in groups of 2, 4, 4 and the rest, whatever its length', () => {
  assert.equal(groupBoothCode('B1RT7KMQ4X'), 'B1 RT7K MQ4X');
  assert.equal(groupBoothCode('B1RT7KMQ4XZ'), 'B1 RT7K MQ4X Z');
  assert.equal(groupBoothCode('B1RT7'), 'B1 RT7');
  assert.equal(groupBoothCode('B1 RT7K MQ4X'), 'B1 RT7K MQ4X');
});

/** Run the real wheel's effects and timers without a browser or real waiting. */
function timedWheel() {
  type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
  const refs: Array<{ current: unknown } | undefined> = [];
  const effects: Array<Effect | undefined> = [];
  const pending: Array<() => void> = [];
  const timers = new Map<number, { at: number; fire: () => void }>();
  const sounds: string[] = [];
  let hook = 0;
  let now = 0;
  let nextTimer = 0;
  const element = () => ({ style: {} as Record<string, string>, className: '', getBoundingClientRect: () => ({}) });
  const jsx = (_type: unknown, props: { ref?: { current: unknown } }) => {
    if (props.ref && props.ref.current === null) props.ref.current = element();
    return null;
  };
  const react = {
    useRef(initial: unknown) {
      const index = hook++;
      return refs[index] ??= { current: initial };
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const index = hook++;
      const previous = effects[index];
      const changed = !previous || !deps || !previous.deps ||
        deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps![i]));
      if (!changed) return;
      const slot: Effect = { deps };
      effects[index] = slot;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        if (typeof cleanup === 'function') slot.cleanup = cleanup;
      });
    },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL('../src/components/Wheel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const exports: { Wheel?: (props: {
    slices: Array<{ id: string; label: string; color: string; textColor: string }>;
    targetIndex: number | null; isSpinning: boolean; spinDurationSeconds?: number; onSpinEnd: () => void;
  }) => void } = {};
  runInNewContext(outputText, {
    exports,
    require: (name: string) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === '@oto/shared') return { boothSpinDurationSeconds };
      if (name === '../sound') return { playSfx: (sound: string) => sounds.push(sound) };
      throw new Error(`Unexpected wheel dependency: ${name}`);
    },
    window: {
      setTimeout(fire: () => void, ms: number) {
        const id = ++nextTimer;
        timers.set(id, { at: now + ms, fire });
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  });
  return {
    sounds,
    timers,
    render(seconds: number | undefined, spinning: boolean, onSpinEnd: () => void) {
      hook = 0;
      exports.Wheel!({
        slices: ['one', 'two'].map((id) => ({ id, label: id, color: '#ffffff', textColor: '#000000' })),
        targetIndex: spinning ? 0 : null, isSpinning: spinning, spinDurationSeconds: seconds, onSpinEnd,
      });
      pending.splice(0).forEach((effect) => effect());
    },
    transition: () => (refs[0]!.current as ReturnType<typeof element>).style.transition,
    to(at: number) {
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= at)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fire();
      }
      now = at;
    },
  };
}

test('one duration snapshot drives the spin and landing even when configuration rerenders', () => {
  const wheel = timedWheel();
  let ended = 0;
  const onEnd = () => { ended += 1; };
  wheel.render(12, true, onEnd);
  assert.match(wheel.transition()!, /transform 12s /);
  const scheduled = [...wheel.timers.entries()];
  assert.ok(scheduled.every(([, timer]) => timer.at <= 12_000));
  wheel.render(20, true, onEnd);
  assert.equal(wheel.transition(), 'transform 12s cubic-bezier(0.16, 1, 0.3, 1)');
  assert.deepEqual([...wheel.timers.entries()], scheduled, 'a config rerender neither cancels nor reschedules this spin');
  wheel.to(11_999);
  assert.equal(ended, 0);
  assert.ok(wheel.sounds.includes('tick'));
  wheel.to(12_000);
  assert.equal(ended, 1);
  assert.equal(wheel.sounds.filter((sound) => sound === 'win').length, 1);

  wheel.render(20, false, onEnd);
  wheel.render(20, true, onEnd);
  assert.match(wheel.transition()!, /transform 20s /);
  wheel.to(31_999);
  assert.equal(ended, 1);
  wheel.to(32_000);
  assert.equal(ended, 2);
});

test('a historical wheel without a duration lands at the ten-second default', () => {
  const wheel = timedWheel();
  let ended = 0;
  wheel.render(undefined, true, () => { ended += 1; });
  assert.match(wheel.transition()!, /transform 10s /);
  wheel.to(9_999);
  assert.equal(ended, 0);
  wheel.to(10_000);
  assert.equal(ended, 1);
});
