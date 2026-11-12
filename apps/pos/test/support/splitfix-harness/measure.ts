import { readSplitView, type Reading } from '../splitview-harness/measure';

/**
 * SCRUM-959 — what the measurement reads off this harness's page, run in the
 * browser (`main.ts` hangs it on `window.__readSplitFix`). SCRUM-884's reading
 * of the region (`../splitview-harness/measure.ts`: clipped text, broken
 * words, labels out of their buttons, controls and texts in view, the boxes the
 * full-width pin compares) plus what the split view's proof found besides:
 * a label drawn past its card, a dish name under its count badge or a price
 * under its plus, a heading run into its count, a heading under the language
 * button, a placeholder cut by its field and a page wider than the phone.
 * Pure DOM, as there: boxes and line boxes as the browser laid them out.
 */
export interface TileReading {
  name: string;
  /** The name's every line inside the tile's padding box. */
  nameInside: boolean;
  /** The name's lines clear of the count badge (true with no badge). */
  nameClearOfBadge: boolean;
  /** The price's text clear of the plus. */
  priceClearOfPlus: boolean;
  /** The plus inside the tile. */
  plusInside: boolean;
  /** The tile's width, px. */
  width: number;
  /** The tile's whole box on screen, in every box that clips it. */
  inView: boolean;
}

export interface SplitFixReading extends Reading {
  /** Texts drawn past the card (`Card`) they sit in. */
  outsideCard: string[];
  /** The menu or shop tiles, in order. */
  tiles: TileReading[];
  /** Distinct rows the category buttons sit on (0 with none). */
  categoryRows: number;
  /** Each heading beside a count in its row (`justify-between`): the room between the two, px. */
  headingGaps: { heading: string; count: string; gap: number }[];
  /** Texts whose box meets the language button's (the customer half). */
  underLanguage: string[];
  /** Each field's placeholder: its width as drawn in the field's font, and the room the field gives it. */
  placeholders: { text: string; needs: number; room: number }[];
  /** How wide the page is drawn, and the window. */
  page: { scrollWidth: number; innerWidth: number };
  /** The rightmost edge any element in the region is drawn to. */
  rightmost: number;
}

const EPS = 1;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const round = (n: number) => Math.round(n * 10) / 10;

type R = { left: number; top: number; right: number; bottom: number };
const meets = (a: R, b: R): boolean =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > EPS && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EPS;
const inside = (a: R, b: R): boolean =>
  a.left >= b.left - EPS && a.right <= b.right + EPS && a.top >= b.top - 2 && a.bottom <= b.bottom + 2;

function lineRects(el: Element): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  return Array.from(range.getClientRects()).filter((r) => r.width > 0);
}

function shown(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Whether a box is wholly on screen and inside every box that clips it. */
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

/** The padding box of an element: where its content may be drawn. */
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

function readTiles(region: Element): TileReading[] {
  // A dish or shop tile: a Card answering a press, with a price and a plus.
  return Array.from(region.querySelectorAll('.text-card-foreground[role="button"]'))
    .filter(shown)
    .map((tile) => {
      const nameEl = tile.querySelector('.text-lg.leading-tight');
      const badge = tile.querySelector(':scope > .absolute');
      const price = tile.querySelector('span.text-primary');
      const plus = tile.querySelector('span.w-9');
      const box = paddingBox(tile);
      const nameLines = nameEl ? lineRects(nameEl) : [];
      const priceLines = price ? lineRects(price) : [];
      const plusBox = plus?.getBoundingClientRect();
      const badgeBox = badge?.getBoundingClientRect();
      const r = tile.getBoundingClientRect();
      return {
        name: squash(nameEl?.textContent ?? ''),
        nameInside: nameLines.every((l) => inside(l, box)),
        nameClearOfBadge: !badgeBox || nameLines.every((l) => !meets(l, badgeBox)),
        priceClearOfPlus: !plusBox || priceLines.every((l) => !meets(l, plusBox)),
        plusInside: !plusBox || inside(plusBox, box),
        width: round(r.width),
        inView: onScreen(r, tile),
      };
    });
}

function readOutsideCard(region: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !(node.textContent ?? '').trim() || !shown(parent)) continue;
    const card = parent.closest('.text-card-foreground');
    if (!card || !region.contains(card)) continue;
    const box = paddingBox(card);
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const l of Array.from(range.getClientRects())) {
      if (l.width === 0) continue;
      if (l.left < box.left - EPS || l.right > box.right + EPS) {
        out.push(`${squash(node.textContent ?? '').slice(0, 40)}: ${round(l.left)}..${round(l.right)} in a card ${round(box.left)}..${round(box.right)}`);
        break;
      }
    }
  }
  return out;
}

function readHeadingGaps(region: Element): SplitFixReading['headingGaps'] {
  const out: SplitFixReading['headingGaps'] = [];
  for (const h of Array.from(region.querySelectorAll('h3'))) {
    // The heading's own group, and the count beside it in the row.
    const row = h.closest('.justify-between');
    if (!row || !region.contains(row)) continue;
    const group = Array.from(row.children).find((c) => c.contains(h));
    const count = group?.nextElementSibling;
    if (!count || !shown(count)) continue;
    const heading = lineRects(h);
    const counted = lineRects(count);
    if (!heading.length || !counted.length) continue;
    out.push({
      heading: squash(h.textContent ?? ''),
      count: squash(count.textContent ?? ''),
      gap: round(Math.min(...counted.map((r) => r.left)) - Math.max(...heading.map((r) => r.right))),
    });
  }
  return out;
}

function readUnderLanguage(region: Element): string[] {
  const button = Array.from(region.querySelectorAll('button')).find((b) => /English|ไทย|中文|Русский|Français/.test(b.textContent ?? ''));
  if (!button) return [];
  const box = button.getBoundingClientRect();
  const out: string[] = [];
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || button.contains(parent) || !(node.textContent ?? '').trim() || !shown(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (Array.from(range.getClientRects()).some((l) => l.width > 0 && meets(l, box))) out.push(squash(node.textContent ?? ''));
  }
  return out;
}

function readPlaceholders(region: Element): SplitFixReading['placeholders'] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  return Array.from(region.querySelectorAll('input[placeholder]'))
    .filter((i): i is HTMLInputElement => i instanceof HTMLInputElement && shown(i) && i.value === '')
    .map((input) => {
      const s = getComputedStyle(input, '::placeholder');
      const own = getComputedStyle(input);
      ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      return {
        text: input.placeholder,
        needs: round(ctx.measureText(input.placeholder).width),
        room: round(input.clientWidth - parseFloat(own.paddingLeft) - parseFloat(own.paddingRight)),
      };
    });
}

export function readSplitFix(): SplitFixReading {
  const region = document.getElementById('region');
  if (!region) throw new Error('no #region on the page');
  const base = readSplitView();
  const buttons = Array.from(region.querySelectorAll('button.h-12')).filter(shown);
  let rightmost = 0;
  for (const el of Array.from(region.querySelectorAll('*'))) {
    if (shown(el)) rightmost = Math.max(rightmost, el.getBoundingClientRect().right);
  }
  return {
    ...base,
    outsideCard: readOutsideCard(region),
    tiles: readTiles(region),
    categoryRows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
    headingGaps: readHeadingGaps(region),
    underLanguage: readUnderLanguage(region),
    placeholders: readPlaceholders(region),
    page: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
    rightmost: round(rightmost),
  };
}

declare global {
  interface Window {
    __readSplitFix?: typeof readSplitFix;
  }
}
