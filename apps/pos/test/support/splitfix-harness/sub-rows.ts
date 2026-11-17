/**
 * SCRUM-994 — what `test/s994-fnb-sub-rows-measured.test.ts` reads off the
 * F&B menu's sub-categories, run in the browser (`main.ts` hangs it on
 * `window.__readSubRows`). Pure DOM, as `measure.ts`: the boxes and line boxes
 * the browser laid out, nothing inferred from class names. The chips are found
 * by their names (the buttons under the menu that carry a sub-category's name,
 * outside the top-level tab row), so the reading means the same on the base
 * commit's scrolling row and on the rows that replace it.
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
  /** The chips' block: the menu root's child that holds them (null with no chip). */
  block: { testId: string | null; overflowX: string; scrollWidth: number; clientWidth: number } | null;
  /** Each element from a chip's parent up to the block that scrolls sideways or is wider than it shows. */
  sideways: string[];
  chips: ChipReading[];
  /** The dish tiles in order: name, top and whether the whole tile is on screen. */
  tiles: { name: string; top: number; inView: boolean }[];
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

export function readSubRows(names: string[]): SubRowsReading {
  const root = document.querySelector('[class*="@container/menu"]');
  if (!root) throw new Error('no menu on the page');
  const rootBox = root.getBoundingClientRect();
  const tabRow = root.querySelector('[data-testid="category-row"]')?.parentElement ?? null;
  const chipEls = Array.from(root.querySelectorAll('button')).filter(
    (b) => names.includes(squash(b.textContent ?? '')) && !(tabRow && tabRow.contains(b)),
  );

  let block: Element | null = null;
  const sideways = new Set<string>();
  for (const chip of chipEls) {
    for (let at = chip.parentElement; at && at !== root; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX !== 'visible' || at.scrollWidth > at.clientWidth) {
        sideways.add(`${at.tagName.toLowerCase()}.${squash(at.className)}: overflow-x ${style.overflowX}, ${at.scrollWidth} of ${at.clientWidth}`);
      }
      if (at.parentElement === root) block = at;
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

  const tiles = Array.from(root.querySelectorAll('.text-card-foreground[role="button"]')).map((tile) => {
    const r = tile.getBoundingClientRect();
    return { name: squash(tile.querySelector('.text-lg.leading-tight')?.textContent ?? ''), top: round(r.top), inView: onScreen(r, tile) };
  });

  const blockStyle = block ? getComputedStyle(block) : null;
  return {
    column: { left: round(rootBox.left), right: round(rootBox.right), width: round(rootBox.width) },
    block: block && blockStyle
      ? { testId: block.getAttribute('data-testid'), overflowX: blockStyle.overflowX, scrollWidth: block.scrollWidth, clientWidth: block.clientWidth }
      : null,
    sideways: [...sideways],
    chips,
    tiles,
  };
}

declare global {
  interface Window {
    __readSubRows?: typeof readSubRows;
  }
}
