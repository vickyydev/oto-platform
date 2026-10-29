import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultTier, getTicketTypes } from '@/mockApi';
import { AddOnsGrid } from '@/components/till/AddOnsGrid';
import { StepAddTicket } from '@/components/till/StepAddTicket';
import { TicketCard } from '@/components/till/TicketCard';
import type { CartLine } from '@/types';
import { renderHook } from './support/hooks';

/**
 * SCRUM-690 — the configure step's footer covered the last add-on row on a
 * tablet in portrait.
 *
 * The step is a column its host clips at its own height. Its middle section
 * had no scroll area, so an add-on list taller than the screen overflowed the
 * section and was drawn under the "Add Another Ticket" / "Continue" row: the
 * last row's steppers sat beneath the two buttons and could not be pressed.
 * The middle section is now the step's scroll area and the footer is pinned
 * under it, outside the scroll.
 *
 * Pinned on the element tree the step builds, without a browser: the scroll
 * area takes the height left over and may shrink to it, it wraps the
 * participants and the add-on grid, the footer sits right after it in the
 * column, and the first step's ticket grid scrolls the same way.
 */

Object.assign(globalThis, { React });

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const harness = await import('./support/hooks');
  const hooks = {
    useState: harness.useState,
    useRef: harness.useRef,
    useMemo: harness.useMemo,
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
  };
  return { ...real, ...hooks, default: { ...real, ...hooks } };
});

// --- Reading the element tree ---------------------------------------------------------

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'type' in n && 'props' in n;

function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isEl(node)) return;
  yield node;
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value) || isEl(value)) yield* walk(value);
  }
}
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isEl(node)) return ` ${textOf(node.props.children)} `;
  return '';
};
const classesOf = (el: El): string[] => String(el.props.className ?? '').split(/\s+/).filter(Boolean);
const hasClasses = (el: El, ...names: string[]): boolean => names.every((n) => classesOf(el).includes(n));
/** The first element in the tree carrying every one of these classes. */
const withClasses = (tree: unknown, ...names: string[]): El | null => {
  for (const el of walk(tree)) if (hasClasses(el, ...names)) return el;
  return null;
};
const elementsOf = (tree: unknown, type: unknown): El[] => [...walk(tree)].filter((el) => el.type === type);
/** Is `target` somewhere inside `tree` (the element itself counts)? */
const contains = (tree: unknown, target: El): boolean => [...walk(tree)].includes(target);
/** An element's direct element children, however the JSX nested its arrays. */
const childElements = (el: El): El[] => {
  const flat = (n: unknown): unknown[] => (Array.isArray(n) ? n.flatMap(flat) : [n]);
  return flat(el.props.children).filter(isEl);
};
/** The element whose direct children hold `target`. */
const parentOf = (tree: unknown, target: El): El | null => {
  for (const el of walk(tree)) if (childElements(el).includes(target)) return el;
  return null;
};
/** The button staff would press: an element with an onClick whose words are these. */
const buttonIn = (tree: unknown, words: string): El | null => {
  for (const el of walk(tree)) {
    if (typeof el.props.onClick !== 'function') continue;
    if (textOf(el.props.children).replace(/\s+/g, ' ').trim() === words) return el;
  }
  return null;
};

// --- The step, as the till mounts it -----------------------------------------------------

const noop = () => undefined;
const ticket = getTicketTypes()[0]!;
const line: CartLine = {
  id: 'line-1',
  ticketType: ticket,
  tier: getDefaultTier().id,
  kids: 1,
  adults: 1,
  socks: 0,
  addOns: [],
  lineTotal: 0,
};

/** The step's element tree: the configure step for a line, or the ticket grid for none. */
const step = (activeLine: CartLine | null): El => {
  const rendered = renderHook((p: Parameters<typeof StepAddTicket>[0]) => StepAddTicket(p), {
    tier: line.tier,
    activeLine,
    hasLines: activeLine !== null,
    onSelectTicket: noop,
    onUpdateLine: noop,
    onAddDropOff: noop,
    onBackToGrid: noop,
    onDone: noop,
  });
  const tree: unknown = rendered.result.current;
  if (!isEl(tree)) throw new Error('the step rendered nothing');
  return tree;
};

// =============================================================================

describe('SCRUM-690 — the configure step', () => {
  it('has a scroll area of its own that holds the participants and the add-ons', () => {
    const tree = step(line);
    const area = withClasses(tree, 'overflow-y-auto');
    expect(area, 'a scroll area').not.toBeNull();
    // It takes the height left under the heading and may shrink to it, so the
    // list scrolls instead of growing past the step.
    expect(hasClasses(area!, 'flex-1', 'min-h-0')).toBe(true);
    const [grid] = elementsOf(tree, AddOnsGrid);
    expect(grid, 'the add-on grid').toBeDefined();
    expect(contains(area, grid!)).toBe(true);
    expect(textOf(area!.props.children)).toContain('Participants');
    expect(textOf(area!.props.children)).toContain('Extras & Add-ons');
  });

  it('pins the footer right after the scroll area, outside it', () => {
    const tree = step(line);
    const area = withClasses(tree, 'overflow-y-auto')!;
    const next = buttonIn(tree, 'Continue');
    const another = buttonIn(tree, 'Add Another Ticket');
    expect(next, 'Continue').not.toBeNull();
    expect(another, 'Add Another Ticket').not.toBeNull();
    const footer = parentOf(tree, next!);
    expect(footer, 'the footer').not.toBeNull();
    expect(contains(footer, another!)).toBe(true);
    expect(hasClasses(footer!, 'shrink-0')).toBe(true);
    // Not inside the scroll: the buttons stay in view while the list scrolls.
    expect(contains(area, footer!)).toBe(false);
    // The column: the heading, the scroll area, then the footer.
    const column = childElements(tree);
    expect(column.indexOf(area)).toBeGreaterThan(0);
    expect(column.indexOf(footer!)).toBe(column.indexOf(area) + 1);
  });

  it('scrolls the first step’s ticket grid the same way', () => {
    const tree = step(null);
    const area = withClasses(tree, 'overflow-y-auto');
    expect(area, 'a scroll area').not.toBeNull();
    expect(hasClasses(area!, 'flex-1', 'min-h-0')).toBe(true);
    const cards = elementsOf(tree, TicketCard);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(contains(area, card)).toBe(true);
  });
});
