import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const parkA = { id: '01900000-0000-7000-8000-000000000001', name: 'ZZ TEST Central', timezone: 'Asia/Bangkok' };
const parkB = { ...parkA, id: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST Riverside' };
const answer = { branches: [parkA, parkB], selectedBranchId: parkA.id, marker: 'ZZ TEST current source' };
const initialSession = () => ({
  state: 'signed-in', locked: false,
  me: { account: { id: 'zz-actor-a', operatorId: 'zz-operator', status: 'active', mustChangePassword: false }, branch: parkA },
  permissions: ['app:oto_app:access', 'admin:account:read'].map(permission => ({ permission, scopeType: 'branch', scopeId: parkA.id })),
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
type Node = { type: unknown; props: Record<string, unknown> };
type NativeContent = {
  data: unknown; error: string | null; openingSource: string | null;
  onRetry: () => void; onOpenSource: (source: string) => void;
};

/** Executes the entire native Staff function and its actual callbacks with inert JSX/hook adapters. */
function staffHarness(options: { read?: (branchId: string | null) => Promise<unknown>; handoff?: () => Promise<string> } = {}) {
  const path = new URL('../src/pages/Staff.tsx', import.meta.url), source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'Staff');
  if (!page?.body) throw new Error('Native Staff function missing');
  const slots: unknown[] = [], effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [], pending: Array<() => void> = [];
  let cursor = 0, session = initialSession();
  const useState = (initial: unknown) => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
    return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
  };
  const useRef = (initial: unknown) => { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; };
  const useEffect = (effect: () => (() => void) | undefined, deps?: unknown[]) => {
    const slot = cursor++, previous = effects[slot];
    if (!previous || !deps || deps.some((value, index) => !Object.is(value, previous.deps?.[index]))) pending.push(() => {
      previous?.cleanup?.(); effects[slot] = { deps, cleanup: effect() };
    });
  };
  const read = vi.fn(options.read ?? (async () => answer));
  const handoff = vi.fn(options.handoff ?? (async () => 'https://oto.test/#handoff=zz-local-placeholder'));
  const assign = vi.fn();
  const component = Symbol('StaffContent'), button = Symbol('Button');
  const exports: { Staff?: () => Node } = {};
  const jsx = (type: unknown, props: Record<string, unknown>): Node => ({ type, props });
  runInNewContext(ts.transpileModule(page.getText(ast), { fileName: 'Staff.tsx', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    exports, require: (name: string) => { if (name !== 'react/jsx-runtime') throw new Error('Unexpected native dependency'); return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }; },
    useSession: () => ({ ...session, has: (permission: string) => session.permissions.some(row => row.permission === permission) }),
    useState, useRef, useEffect, staffApi: { read, sourceDestination: handoff }, window: { location: { assign } },
    StaffContent: component, CommandBar: Symbol('CommandBar'), PermissionRequired: Symbol('PermissionRequired'),
    ErrorNote: Symbol('ErrorNote'), RefreshCw: Symbol('RefreshCw'), Button: button,
  });
  const find = (value: unknown, predicate: (node: Node) => boolean): Node | null => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) return value.map(child => find(child, predicate)).find(Boolean) ?? null;
    const node = value as Node;
    if (node.type !== undefined && predicate(node)) return node;
    return Object.values(node.props ?? value).map(child => find(child, predicate)).find(Boolean) ?? null;
  };
  return {
    read, handoff, assign,
    render(next = session, flush = true) {
      session = next; cursor = 0;
      const tree = exports.Staff!();
      if (flush) while (pending.length) pending.shift()?.();
      return {
        content: find(tree, node => node.type === component)?.props as NativeContent | undefined,
        selectPark: (value: string) => (find(tree, node => node.type === 'select')?.props.onChange as ((event: unknown) => void) | undefined)?.({ target: { value } }),
        refresh: () => (find(tree, node => node.type === button)?.props.onClick as (() => void) | undefined)?.(),
      };
    },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
  };
}
async function settled() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('Staff native authority and source request lifetimes', () => {
  it.each(['app:oto_app:access', 'admin:account:read'])('does not read without %s', permission => {
    const view = staffHarness(), session = initialSession();
    session.permissions = session.permissions.filter(row => row.permission !== permission);
    expect(view.render(session).content).toBeUndefined();
    expect(view.read).not.toHaveBeenCalled();
    expect(view.handoff).not.toHaveBeenCalled();
  });

  it('discards the first read after actor A to B to A, including the old park directory', async () => {
    const pending = deferred<unknown>();
    let reads = 0;
    const view = staffHarness({ read: () => ++reads === 1 ? pending.promise : new Promise(() => {}) });
    const first = initialSession(), other = initialSession(); other.me.account.id = 'zz-actor-b';
    view.render(first); view.render(other); view.render(first);
    pending.resolve(answer); await settled();
    expect(view.render().content?.data).toBeNull();
    expect(view.read).toHaveBeenCalledTimes(3);
  });

  it('drops an explicit park filter when authority narrows and reads the remaining reachable default', async () => {
    let reduced = false;
    const currentAnswer = { ...answer, branches: [parkA] };
    const view = staffHarness({ read: async branchId => {
      if (reduced && branchId === parkB.id) throw new Error('ZZ TEST selected park no longer reachable');
      return reduced ? currentAnswer : answer;
    } });
    const wider = initialSession();
    wider.permissions = wider.permissions.map(row => ({ ...row, scopeType: 'operator', scopeId: 'zz-operator' }));
    view.render(wider); await settled();
    view.render().selectPark(parkB.id); view.render(); await settled();
    expect(view.read.mock.calls.at(-1)).toEqual([parkB.id]);
    reduced = true;
    expect(view.render(initialSession()).content?.data).toBeNull();
    expect(view.read.mock.calls.at(-1)).toEqual([null]);
    await settled();
    expect(view.render().content?.data).toEqual(currentAnswer);
    view.render().refresh(); view.render(); await settled();
    expect(view.read.mock.calls.at(-1)).toEqual([null]);
    expect(view.render().content?.error).toBeNull();
  });

  for (const change of ['actor', 'grant', 'lock', 'seat', 'filter', 'refresh', 'unmount'] as const) {
    it(`prevents a retained source action and pending navigation after ${change}, including ABA returns`, async () => {
      const destination = deferred<string>(), view = staffHarness({ handoff: () => destination.promise });
      const initial = initialSession(); view.render(initial); await settled();
      const shown = view.render(), oldAction = shown.content!.onOpenSource;
      oldAction('working');
      expect(view.handoff).toHaveBeenCalledTimes(1);
      if (change === 'filter') { shown.selectPark(parkB.id); view.render(); view.render().selectPark(parkA.id); view.render(); }
      if (change === 'refresh') { shown.refresh(); view.render(); }
      if (change === 'unmount') view.unmount();
      if (['actor', 'grant', 'lock', 'seat'].includes(change)) {
        const other = initialSession();
        if (change === 'actor') other.me.account.id = 'zz-actor-b';
        if (change === 'grant') other.permissions = [];
        if (change === 'lock') other.locked = true;
        if (change === 'seat') other.me.branch = parkB;
        // Render changes authority before effect cleanup or the next response.
        const changed = view.render(other, false);
        expect(changed.content?.data ?? null).toBeNull();
        oldAction('payroll');
        expect(view.handoff).toHaveBeenCalledTimes(1);
        view.render(initial);
      }
      oldAction('payroll');
      expect(view.handoff).toHaveBeenCalledTimes(1);
      destination.resolve('https://oto.test/#handoff=zz-local-placeholder'); await settled();
      expect(view.assign).not.toHaveBeenCalled();
    });
  }

  it('allows one current source issue at a time and a fresh explicit retry after a refusal', async () => {
    const first = deferred<string>(), view = staffHarness({ handoff: () => first.promise });
    view.render(); await settled();
    const shown = view.render();
    shown.content!.onOpenSource('working'); shown.content!.onOpenSource('payroll');
    expect(view.handoff).toHaveBeenCalledTimes(1);
    first.reject(new Error('ZZ TEST handoff unavailable')); await settled(); await settled();
    const retry = view.render(); expect(retry.content?.openingSource).toBeNull();
    view.handoff.mockResolvedValueOnce('https://oto.test/#handoff=zz-local-placeholder');
    retry.content!.onOpenSource('working'); await settled();
    expect(view.handoff).toHaveBeenCalledTimes(2);
    expect(view.assign).toHaveBeenCalledTimes(1);
  });
});
