/**
 * THE TILL'S HOOKS, RUN WITHOUT A BROWSER (SCRUM-408).
 *
 * The rules the unit tests pin — a scan poll's cursor, a voucher held for one
 * cart, a sale id kept across two presses of Pay, a quote dropped because the
 * cart moved on — live inside React hooks (`useStationScans`, `useTillVoucher`,
 * `useSaleWriter`, `useCartQuote`). They are refs, closures and effects with no
 * markup, but React only runs a hook inside a renderer, and the renderer React
 * ships for this (react-dom) needs a DOM the libraries themselves never touch.
 *
 * So a test file puts this module in place of `react`:
 *
 *   vi.mock('react', () => import('./support/hooks'));
 *
 * and drives the hook with `renderHook`. It implements the five primitives
 * those hooks import, to React's documented contract and no further:
 *
 *   - `useState`   a value kept between renders; setting a different value
 *                  (by `Object.is`) renders again. Updater functions work.
 *   - `useRef`     one object for the life of the component.
 *   - `useMemo`,   recomputed only when a dependency changes (by `Object.is`).
 *     `useCallback`
 *   - `useEffect`  run after a render whose dependencies changed, or after
 *                  every render with none; the effect's previous cleanup runs
 *                  first, and every cleanup runs on unmount.
 *
 * Renders are synchronous. A state change made while rendering or while the
 * effects run renders again once they have finished — React's batching, at
 * the granularity these hooks can observe. A hook importing anything else
 * from `react` finds it missing and fails at once, which is the point: the
 * harness grows only when a test needs it to, and never guesses.
 */

type Deps = readonly unknown[] | undefined;
type EffectCallback = () => void | (() => void);

interface StateSlot {
  kind: 'state';
  value: unknown;
  set: (next: unknown) => void;
}
interface RefSlot {
  kind: 'ref';
  ref: { current: unknown };
}
interface MemoSlot {
  kind: 'memo';
  deps: Deps;
  value: unknown;
}
interface EffectSlot {
  kind: 'effect';
  deps: Deps;
  cleanup: (() => void) | null;
}
type Slot = StateSlot | RefSlot | MemoSlot | EffectSlot;

/** Did a dependency list change? No list at all means "every render". */
function depsChanged(previous: Deps, next: Deps): boolean {
  if (previous === undefined || next === undefined) return true;
  if (previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}

class HookInstance {
  private readonly slots: Slot[] = [];
  private cursor = 0;
  private pending: { slot: EffectSlot; effect: EffectCallback }[] = [];
  /** Rendering, or running the effects of a render. */
  private busy = false;
  /** A state change arrived while busy: render again when done. */
  private dirty = false;
  mounted = true;

  constructor(private readonly body: () => void) {}

  /** Render, run the effects that render scheduled, and repeat while state changed meanwhile. */
  render(): void {
    if (!this.mounted) return;
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.dirty = false;
        this.cursor = 0;
        within(this, this.body);
        const effects = this.pending;
        this.pending = [];
        // React's commit order: every changed effect's cleanup, then every effect.
        for (const { slot } of effects) {
          const cleanup = slot.cleanup;
          slot.cleanup = null;
          cleanup?.();
        }
        for (const { slot, effect } of effects) {
          if (!this.mounted) break;
          const cleanup = effect();
          slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
        }
      } while (this.dirty && this.mounted);
    } finally {
      this.busy = false;
    }
  }

  slot<S extends Slot>(kind: S['kind'], create: () => S): S {
    const index = this.cursor;
    this.cursor += 1;
    const existing = this.slots[index];
    if (!existing) {
      const created = create();
      this.slots[index] = created;
      return created;
    }
    if (existing.kind !== kind) {
      throw new Error(`hook ${index} was a ${existing.kind} and is now a ${kind}: hooks called conditionally`);
    }
    return existing as S;
  }

  schedule(slot: EffectSlot, effect: EffectCallback): void {
    this.pending.push({ slot, effect });
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const slot of this.slots) {
      if (slot.kind !== 'effect' || !slot.cleanup) continue;
      const cleanup = slot.cleanup;
      slot.cleanup = null;
      cleanup();
    }
  }
}

/** The component rendering right now: the one a hook call belongs to. */
let active: HookInstance | null = null;

/** Run `body` as `owner`'s render, so the hooks it calls attach to `owner`. */
function within(owner: HookInstance, body: () => void): void {
  const outer = active;
  active = owner;
  try {
    body();
  } finally {
    active = outer;
  }
}

function instance(hook: string): HookInstance {
  if (!active) throw new Error(`${hook} was called outside renderHook`);
  return active;
}

export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void] {
  const owner = instance('useState');
  const slot = owner.slot<StateSlot>('state', () => {
    const created: StateSlot = {
      kind: 'state',
      value: typeof initial === 'function' ? (initial as () => S)() : initial,
      set: () => undefined,
    };
    created.set = (next) => {
      const value =
        typeof next === 'function' ? (next as (previous: unknown) => unknown)(created.value) : next;
      if (Object.is(value, created.value)) return;
      created.value = value;
      owner.render();
    };
    return created;
  });
  return [slot.value as S, slot.set as (next: S | ((previous: S) => S)) => void];
}

export function useRef<T>(initial: T): { current: T } {
  const slot = instance('useRef').slot<RefSlot>('ref', () => ({ kind: 'ref', ref: { current: initial } }));
  return slot.ref as { current: T };
}

export function useMemo<T>(factory: () => T, deps: Deps): T {
  // A new slot has no dependencies recorded, so the first render computes.
  const slot = instance('useMemo').slot<MemoSlot>('memo', () => ({
    kind: 'memo',
    deps: undefined,
    value: undefined,
  }));
  if (depsChanged(slot.deps, deps)) {
    slot.value = factory();
    slot.deps = deps;
  }
  return slot.value as T;
}

export function useCallback<T>(callback: T, deps: Deps): T {
  return useMemo(() => callback, deps);
}

export function useEffect(effect: EffectCallback, deps?: Deps): void {
  const owner = instance('useEffect');
  // A new slot has no dependencies recorded, so a first render always runs it.
  const slot = owner.slot<EffectSlot>('effect', () => ({ kind: 'effect', deps: undefined, cleanup: null }));
  if (!depsChanged(slot.deps, deps)) return;
  slot.deps = deps;
  owner.schedule(slot, effect);
}

export interface RenderedHook<P, R> {
  /** What the hook returned on its latest render. */
  readonly result: { readonly current: R };
  /** Render again with new arguments, as a parent re-rendering would. */
  rerender: (props: P) => void;
  /** Run every effect's cleanup, as React does when the screen goes away. */
  unmount: () => void;
}

/** Mount a hook: render it once and run its effects. */
export function renderHook<R>(hook: () => R): RenderedHook<void, R>;
export function renderHook<P, R>(hook: (props: P) => R, initialProps: P): RenderedHook<P, R>;
export function renderHook<P, R>(hook: (props: P) => R, initialProps?: P): RenderedHook<P, R> {
  let props = initialProps as P;
  let latest: { value: R } | null = null;
  const owner = new HookInstance(() => {
    latest = { value: hook(props) };
  });
  owner.render();
  return {
    result: {
      get current(): R {
        if (!latest) throw new Error('the hook has not rendered');
        return latest.value;
      },
    },
    rerender: (next: P) => {
      props = next;
      owner.render();
    },
    unmount: () => owner.unmount(),
  };
}
