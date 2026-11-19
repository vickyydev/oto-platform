import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PANEL_WIDTH,
  RAIL_WIDTH,
  canSplit,
  layoutFor,
  listMax,
  listWidth,
  readListWidth,
  roomFor,
  writeListWidth,
  type PaneLayout,
  type SplitLayout,
} from '@/lib/panes';

/** The simulator's side panel, shown beside the work from 1280 px. */
const SIMULATOR_WIDTH = 420;

function windowWidth(): number {
  if (typeof window === 'undefined') return 1440;
  if (typeof window.innerWidth === 'number') return window.innerWidth;
  return window.matchMedia?.('(min-width: 1024px)').matches ? 1440 : 390;
}

/** The grid's columns for a layout: the views column, the list at `--list-w`, the chat. */
export function paneColumns(layout: PaneLayout, split: boolean): string {
  const rail = layout === 'desktop' ? `${RAIL_WIDTH}px ` : '';
  return split ? `${rail}var(--list-w) minmax(0,1fr)` : `${rail}minmax(0,1fr)`;
}

export interface Panes {
  /** The work area (`<main>`): measured, and where `--list-w` is set while dragging. */
  shell: { current: HTMLElement | null };
  layout: PaneLayout;
  /** The list and the chat side by side; false is one pane at a time. */
  split: boolean;
  room: number;
  /** The list's width in px (0 when not split). */
  width: number;
  max: number;
  columns: string;
  /** Where the list's edge is, as CSS, for the divider. */
  edge: string;
  live: (width: number) => void;
  commit: (width: number | 'default') => void;
}

/**
 * The panes' sizes (SCRUM-1045, `lib/panes.ts`): the layout from the window,
 * the room from the work area as measured (a ResizeObserver, so the simulator
 * panel, a rotation or a resized window are all seen), the list's width from
 * what this browser chose for this layout, clamped to the room every time.
 */
export function usePanes(simulatorShown: boolean): Panes {
  const shell = useRef<HTMLElement | null>(null);
  const [win, setWin] = useState(windowWidth);
  const [measured, setMeasured] = useState<number | null>(null);
  const [chosen, setChosen] = useState<Record<SplitLayout, number | null>>(() => ({
    tablet: readListWidth('tablet'),
    desktop: readListWidth('desktop'),
  }));

  useEffect(() => {
    const on = () => setWin(windowWidth());
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);

  useEffect(() => {
    const el = shell.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setMeasured(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = layoutFor(win);
  const estimate = win - (simulatorShown && win >= 1280 ? SIMULATOR_WIDTH : 0);
  const room = roomFor(measured ?? estimate, layout);
  const split = canSplit(layout, room);
  // The chat's right panel shows from 1280 px (1760 px beside the simulator's):
  // the default share leaves it out, so the conversation keeps its room.
  const aside = win >= (simulatorShown ? 1760 : 1280) ? PANEL_WIDTH : 0;
  const width = split ? listWidth(chosen[layout as SplitLayout], room, aside) : 0;

  const live = useCallback((w: number) => {
    shell.current?.style.setProperty('--list-w', `${w}px`);
  }, []);
  const commit = useCallback(
    (w: number | 'default') => {
      if (layout === 'phone') return;
      const value = w === 'default' ? null : w;
      writeListWidth(layout, value);
      setChosen((c) => ({ ...c, [layout]: value }));
      // The shell shows the committed width at once: React's style diff may
      // see no change from its last render (a reset to the width it drew).
      shell.current?.style.setProperty('--list-w', `${listWidth(value, room, aside)}px`);
    },
    [layout, room, aside],
  );

  return {
    shell,
    layout,
    split,
    room,
    width,
    max: listMax(room),
    columns: paneColumns(layout, split),
    edge: layout === 'desktop' ? `calc(${RAIL_WIDTH}px + var(--list-w))` : 'var(--list-w)',
    live,
    commit,
  };
}
