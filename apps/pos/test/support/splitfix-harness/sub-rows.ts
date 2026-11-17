/**
 * SCRUM-994 — what `test/s994-fnb-sub-rows-measured.test.ts` reads off the
 * F&B menu's sub-categories, run in the browser (`main.ts` hangs it on
 * `window.__readSubRows`). Pure DOM, as `measure.ts`: the boxes and line boxes
 * the browser laid out, nothing inferred from class names. The chips are found
 * by their names (the buttons under the menu that carry a sub-category's name,
 * outside the top-level tab row), so the reading means the same on the base
 * commit's scrolling row and on the rows that replace it, wherever in the menu
 * the rows stand. `revealInMenu` scrolls the menu as staff would.
 */
/**
 * Staging's menu grouped on 13 November: three tabs and their sub-categories
 * in order (the owner's picture: Coffee, Iced Coffee, … on one row that
 * scrolled sideways). The harness's `fnb-menu-grouped` screen seeds it.
 */
export const GROUPED_MENU: Record<string, string[]> = {
  Food: ['Breakfast', 'Sides', 'Sharing', 'Salads', 'Pasta', 'Pizza', 'Mains', 'Asian Food', 'Kids', 'Desserts'],
  Drinks: ['Coffee', 'Iced Coffee', 'Chocolate', 'Soda', 'Smoothies', 'Juice', 'Tea pot', 'Soft drinks', 'Kids juice', 'Wine', 'Beer', 'Free Drinks Menu'],
  Special: ['Specials', 'Soup'],
};
/** The three dishes the screen puts in each sub-category, named after it so a test finds them. */
export const groupedDishes = (sub: string): string[] => [1, 2, 3].map((n) => `${sub} ${n}`);
/**
 * A sub-category name as long as the platform takes (40 characters,
 * `MenuCategoryBodySchema` in `packages/shared/src/menu-shapes.ts`): with
 * `long=1` the screen puts it third under Drinks (`withLongName`).
 */
export const LONG_SUB_NAME = 'Fresh Seasonal Fruit Smoothies and Juice';
export const withLongName = (names: string[]): string[] => [...names.slice(0, 2), LONG_SUB_NAME, ...names.slice(2)];

export interface ChipReading {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Lines its label is drawn on. */
  lines: number;
  /** Every line of the label inside the chip's padding box. */
  labelInside: boolean;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** The whole chip on screen, inside every box that clips it. */
  inView: boolean;
  /** Its `aria-pressed`, as written (null with none). */
  pressed: string | null;
}

export interface SubRowsReading {
  /** The menu column: `MenuGrid`'s own root (`@container/menu`). */
  column: { left: number; right: number; width: number };
  /** The chips' block: the nearest box that holds every chip (null with no chip). */
  block: { testId: string | null; overflowX: string; scrollWidth: number; clientWidth: number } | null;
  /**
   * Each element from a chip's parent up to the menu root that scrolls
   * sideways (`overflow-x` auto or scroll) or is wider than it shows. A box
   * that scrolls up and down only (the dishes' scroll, `overflow-x` hidden)
   * is not one, unless something in it is wider than it.
   */
  sideways: string[];
  chips: ChipReading[];
  /**
   * The dish tiles in order: name, top, height, its own `min-height` (a dish
   * whose name takes one line is that tall), how much of it is on screen
   * inside every box that clips it, and whether the whole tile is.
   */
  tiles: { name: string; top: number; height: number; minHeight: number; visible: number; inView: boolean }[];
  /** The box that scrolls the first dish up and down (`revealInMenu`'s), null with none. */
  dishScroll: { top: number; height: number; scrollTop: number; scrollHeight: number } | null;
}

const EPS = 1;
const round = (n: number) => Math.round(n * 10) / 10;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

type R = { left: number; top: number; right: number; bottom: number };

function onScreen(rect: R, el: Element): boolean {
  if (rect.left < -EPS || rect.top < -EPS || rect.right > window.innerWidth + EPS || rect.bottom > window.innerHeight + EPS) return false;
  for (let at = el.parentElement; at; at = at.parentElement) {
    const style = getComputedStyle(at);
    const box = at.getBoundingClientRect();
    if (style.overflowX !== 'visible' && (rect.left < box.left - EPS || rect.right > box.right + EPS)) return false;
    if (style.overflowY !== 'visible' && (rect.top < box.top - EPS || rect.bottom > box.bottom + EPS)) return false;
  }
  return true;
}

/** How much of an element's height is on screen, inside the window and every box around it that clips up and down. */
function visibleHeight(rect: R, el: Element): number {
  let top = Math.max(rect.top, 0);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (getComputedStyle(at).overflowY === 'visible') continue;
    const box = at.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  return Math.max(0, bottom - top);
}

function paddingBox(el: Element): R {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return {
    left: r.left + parseFloat(s.borderLeftWidth),
    right: r.right - parseFloat(s.borderRightWidth),
    top: r.top + parseFloat(s.borderTopWidth),
    bottom: r.bottom - parseFloat(s.borderBottomWidth),
  };
}

function lineRects(el: Element): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  return Array.from(range.getClientRects()).filter((r) => r.width > 0);
}

function menuRoot(): Element {
  const root = document.querySelector('[class*="@container/menu"]');
  if (!root) throw new Error('no menu on the page');
  return root;
}

/** The buttons under the menu that carry these names, outside the top-level tab row. */
function chipsNamed(root: Element, names: string[]): HTMLButtonElement[] {
  const tabRow = root.querySelector('[data-testid="category-row"]')?.parentElement ?? null;
  return Array.from(root.querySelectorAll('button')).filter(
    (b) => names.includes(squash(b.textContent ?? '')) && !(tabRow && tabRow.contains(b)),
  );
}

const dishTiles = (root: Element): Element[] => Array.from(root.querySelectorAll('.text-card-foreground[role="button"]'));

/** The nearest box around an element that scrolls up and down (`overflow-y` auto or scroll): what a finger moves. */
function scrollerOf(el: Element): Element | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const overflowY = getComputedStyle(at).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return null;
}

export function readSubRows(names: string[]): SubRowsReading {
  const root = menuRoot();
  const rootBox = root.getBoundingClientRect();
  const chipEls = chipsNamed(root, names);

  let block: Element | null = null;
  for (let at = chipEls[0]?.parentElement ?? null; at && at !== root; at = at.parentElement) {
    const box = at;
    if (chipEls.every((chip) => box.contains(chip))) {
      block = box;
      break;
    }
  }
  const sideways = new Set<string>();
  for (const chip of chipEls) {
    for (let at = chip.parentElement; at && at !== root; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll' || at.scrollWidth > at.clientWidth) {
        sideways.add(`${at.tagName.toLowerCase()}.${squash(at.className)}: overflow-x ${style.overflowX}, ${at.scrollWidth} of ${at.clientWidth}`);
      }
    }
  }

  const chips = chipEls.map((chip): ChipReading => {
    const r = chip.getBoundingClientRect();
    const lines = lineRects(chip);
    const box = paddingBox(chip);
    return {
      name: squash(chip.textContent ?? ''),
      left: round(r.left),
      top: round(r.top),
      width: round(r.width),
      height: round(r.height),
      lines: new Set(lines.map((l) => Math.round(l.top))).size,
      labelInside: lines.every((l) => l.left >= box.left - EPS && l.right <= box.right + EPS && l.top >= box.top - 2 && l.bottom <= box.bottom + 2),
      scrollWidth: chip.scrollWidth,
      clientWidth: chip.clientWidth,
      scrollHeight: chip.scrollHeight,
      clientHeight: chip.clientHeight,
      inView: onScreen(r, chip),
      pressed: chip.getAttribute('aria-pressed'),
    };
  });

  const tileEls = dishTiles(root);
  const tiles = tileEls.map((tile) => {
    const r = tile.getBoundingClientRect();
    return {
      name: squash(tile.querySelector('.text-lg.leading-tight')?.textContent ?? ''),
      top: round(r.top),
      height: round(r.height),
      minHeight: parseFloat(getComputedStyle(tile).minHeight) || 0,
      visible: round(visibleHeight(r, tile)),
      inView: onScreen(r, tile),
    };
  });
  const scroller = tileEls[0] ? scrollerOf(tileEls[0]) : null;
  const scrollerBox = scroller?.getBoundingClientRect();

  const blockStyle = block ? getComputedStyle(block) : null;
  return {
    column: { left: round(rootBox.left), right: round(rootBox.right), width: round(rootBox.width) },
    block: block && blockStyle
      ? { testId: block.getAttribute('data-testid'), overflowX: blockStyle.overflowX, scrollWidth: block.scrollWidth, clientWidth: block.clientWidth }
      : null,
    sideways: [...sideways],
    chips,
    tiles,
    dishScroll: scroller && scrollerBox
      ? { top: round(scrollerBox.top), height: round(scrollerBox.height), scrollTop: round(scroller.scrollTop), scrollHeight: scroller.scrollHeight }
      : null,
  };
}

/**
 * Scrolls what a member of staff can scroll to bring up a chip (by its name)
 * or, with null, the first dish tile: the nearest box around it that scrolls
 * up and down (`overflow-y` auto or scroll), until its top meets that box's
 * top. A box that only clips (`overflow: hidden`) is never moved, as no
 * finger can move it. False when no box around it scrolls.
 */
export function revealInMenu(chip: string | null): boolean {
  const root = menuRoot();
  const el = chip === null ? dishTiles(root)[0] : chipsNamed(root, [chip])[0];
  if (!el) throw new Error(`nothing to bring up: ${chip ?? 'the first dish'}`);
  const scroller = scrollerOf(el);
  if (!scroller) return false;
  scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  return true;
}

declare global {
  interface Window {
    __readSubRows?: typeof readSubRows;
    __revealInMenu?: typeof revealInMenu;
  }
}
