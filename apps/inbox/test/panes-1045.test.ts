// SCRUM-1045 — the list beside the chat, and the divider between them: the
// arithmetic of `lib/panes.ts` (the default, the limits, a chosen width
// clamped again when the room changes, the width remembered per browser and
// per layout, the reset), and the workspace’s single-pane fallback when the
// room cannot give both panes their minimum.
//
// FICTIONAL TEST DATA: no people, only widths.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paneColumns } from '@/hooks/usePanes';
import {
  CHAT_MIN,
  KEY_STEP,
  LIST_DEFAULT_MAX,
  LIST_MAX,
  LIST_MIN,
  PANEL_WIDTH,
  RAIL_WIDTH,
  canSplit,
  keyedWidth,
  layoutFor,
  listDefault,
  listMax,
  listWidth,
  readListWidth,
  roomFor,
  writeListWidth,
} from '@/lib/panes';

describe('SCRUM-1045: the layouts', () => {
  it('a phone below 704 px, a tablet’s two panes to 1023 px, the desktop’s three from 1024 px', () => {
    expect(layoutFor(390)).toBe('phone');
    expect(layoutFor(703)).toBe('phone');
    expect(layoutFor(704)).toBe('tablet');
    expect(layoutFor(744)).toBe('tablet');
    expect(layoutFor(768)).toBe('tablet');
    expect(layoutFor(1023)).toBe('tablet');
    expect(layoutFor(1024)).toBe('desktop');
    expect(layoutFor(1920)).toBe('desktop');
  });

  it('the room for the list and the chat is the work area less the views column on a desktop', () => {
    expect(roomFor(768, 'tablet')).toBe(768);
    expect(roomFor(1024, 'desktop')).toBe(1024 - RAIL_WIDTH);
    expect(roomFor(100, 'desktop')).toBe(0);
  });
});

describe('SCRUM-1045: the list’s default width', () => {
  it('is about 36 % of the room: the chat is the wider side', () => {
    expect(listDefault(768)).toBe(276); // an iPad mini upright: the chat gets 492 px, not 408
    expect(listDefault(800)).toBe(288); // a 1024 px tablet, beside the views column
    expect(listDefault(909)).toBe(327); // 1133 px across
    for (const room of [768, 800, 909, 1000]) expect(room - listDefault(room)).toBeGreaterThan(listDefault(room));
  });

  it('is never under 264 px and, by default, never over 380 px', () => {
    expect(listDefault(700)).toBe(LIST_MIN);
    expect(listDefault(1216)).toBe(LIST_DEFAULT_MAX); // 1440 px across
    expect(listDefault(3000)).toBe(LIST_DEFAULT_MAX);
  });

  it('from 1280 px, the share leaves out the chat’s right panel, so the conversation beside it keeps its room', () => {
    const room = roomFor(1280, 'desktop');
    expect(listDefault(room, PANEL_WIDTH)).toBe(272);
    expect(room - listDefault(room, PANEL_WIDTH) - PANEL_WIDTH).toBe(484); // was 376 beside a 380 px list
    expect(listDefault(roomFor(1440, 'desktop'), PANEL_WIDTH)).toBe(330);
    expect(listDefault(roomFor(1920, 'desktop'), PANEL_WIDTH)).toBe(LIST_DEFAULT_MAX);
    expect(listWidth(null, room, PANEL_WIDTH)).toBe(272);
    // A chosen width is the person’s, panel or not.
    expect(listWidth(350, room, PANEL_WIDTH)).toBe(350);
  });

  it('always leaves the chat its 360 px', () => {
    for (const room of [LIST_MIN + CHAT_MIN, 640, 700, 768, 1000]) expect(room - listDefault(room)).toBeGreaterThanOrEqual(CHAT_MIN);
  });
});

describe('SCRUM-1045: the limits of a drag', () => {
  it('the list goes no narrower than 264 px and no wider than the room less the chat’s 360 px', () => {
    expect(listWidth(100, 768)).toBe(LIST_MIN);
    expect(listWidth(600, 768)).toBe(768 - CHAT_MIN);
    expect(listMax(768)).toBe(408);
  });

  it('a drag may pass the default’s 380 px, but never 560 px', () => {
    expect(listWidth(450, 1696)).toBe(450);
    expect(listWidth(900, 1696)).toBe(LIST_MAX);
    expect(listMax(1696)).toBe(LIST_MAX);
  });

  it('a chosen width is clamped again when the room changes: a rotation, a narrower window', () => {
    // 400 px chosen on a 1366 px tablet held sideways …
    expect(listWidth(400, roomFor(1366, 'desktop'))).toBe(400);
    expect(listWidth(500, roomFor(1366, 'desktop'))).toBe(500);
    // … the same choices on a 1024 px window: the chat keeps its 360 px.
    expect(listWidth(400, roomFor(1024, 'desktop'))).toBe(400);
    expect(listWidth(500, roomFor(1024, 'desktop'))).toBe(roomFor(1024, 'desktop') - CHAT_MIN);
    // None chosen: the default for each room.
    expect(listWidth(null, 768)).toBe(listDefault(768));
    expect(listWidth(Number.NaN, 768)).toBe(listDefault(768));
  });
});

describe('SCRUM-1045: the keyboard', () => {
  it('Left and Right move 16 px, Home and End go to the limits, Enter back to the default', () => {
    expect(keyedWidth('ArrowRight', 300, 768)).toBe(300 + KEY_STEP);
    expect(keyedWidth('ArrowLeft', 300, 768)).toBe(300 - KEY_STEP);
    expect(keyedWidth('ArrowLeft', LIST_MIN + 4, 768)).toBe(LIST_MIN);
    expect(keyedWidth('ArrowRight', 400, 768)).toBe(listMax(768));
    expect(keyedWidth('Home', 300, 768)).toBe(LIST_MIN);
    expect(keyedWidth('End', 300, 768)).toBe(listMax(768));
    expect(keyedWidth('Enter', 300, 768)).toBe('default');
    expect(keyedWidth('a', 300, 768)).toBeNull();
    expect(keyedWidth('ArrowUp', 300, 768)).toBeNull();
  });
});

describe('SCRUM-1045: the width remembered per browser and per layout', () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => void (stored[k] = v),
      removeItem: (k: string) => void delete stored[k],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('each layout keeps its own: a tablet’s two panes and a desktop’s three', () => {
    writeListWidth('tablet', 300);
    writeListWidth('desktop', 352.4);
    expect(readListWidth('tablet')).toBe(300);
    expect(readListWidth('desktop')).toBe(352);
    expect(Object.keys(stored).sort()).toEqual(['oto.inbox.listWidth.desktop', 'oto.inbox.listWidth.tablet']);
  });

  it('a reset forgets the choice, so the default comes back', () => {
    writeListWidth('tablet', 300);
    writeListWidth('tablet', null);
    expect(readListWidth('tablet')).toBeNull();
    expect(listWidth(readListWidth('tablet'), 768)).toBe(listDefault(768));
  });

  it('nothing stored, or nonsense stored, reads as none', () => {
    expect(readListWidth('tablet')).toBeNull();
    stored['oto.inbox.listWidth.tablet'] = 'wide';
    expect(readListWidth('tablet')).toBeNull();
    stored['oto.inbox.listWidth.tablet'] = '-5';
    expect(readListWidth('tablet')).toBeNull();
  });

  it('a refused storage (a private window) neither throws nor remembers', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => writeListWidth('tablet', 300)).not.toThrow();
    expect(() => writeListWidth('tablet', null)).not.toThrow();
    expect(readListWidth('tablet')).toBeNull();
  });
});

describe('SCRUM-1045: one pane at a time when both minimums do not fit', () => {
  it('a phone is always one pane; a tablet or a desktop splits only with 624 px of room', () => {
    expect(canSplit('phone', 2000)).toBe(false);
    expect(canSplit('tablet', LIST_MIN + CHAT_MIN)).toBe(true);
    expect(canSplit('tablet', LIST_MIN + CHAT_MIN - 1)).toBe(false);
    expect(canSplit('desktop', roomFor(1024, 'desktop'))).toBe(true);
    // A desktop window with the simulator’s 420 px panel beside a narrow work area.
    expect(canSplit('desktop', roomFor(1240 - 420, 'desktop'))).toBe(false);
  });

  it('the grid has a column for the list at its width only when split; the views column stays on a desktop', () => {
    expect(paneColumns('tablet', true)).toBe('var(--list-w) minmax(0,1fr)');
    expect(paneColumns('desktop', true)).toBe(`${RAIL_WIDTH}px var(--list-w) minmax(0,1fr)`);
    expect(paneColumns('tablet', false)).toBe('minmax(0,1fr)');
    expect(paneColumns('desktop', false)).toBe(`${RAIL_WIDTH}px minmax(0,1fr)`);
    expect(paneColumns('phone', false)).toBe('minmax(0,1fr)');
  });
});
