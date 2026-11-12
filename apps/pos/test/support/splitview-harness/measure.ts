/**
 * SCRUM-884 — what the split view measurement reads off the page, run in the
 * browser (`main.ts` hangs it on `window.__readSplitView`). Pure DOM: boxes
 * and line boxes as the browser laid them out, nothing inferred from class
 * names. The region read is the element with id `region` — the staff till's
 * wizard column on a till screen, the card on a board screen.
 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type FaultKind =
  /** The text is wider than the box that clips it (an ellipsis, or cut off). */
  | 'clipped'
  /** One word drawn on two lines: "Ca / sh", "Pro / mpt". */
  | 'brokenWord'
  /** Text drawn outside the button it labels. */
  | 'outsideButton';

export interface TextFault {
  kind: FaultKind;
  text: string;
  detail: string;
}

export interface ControlReading {
  /** The visible name: its text, or its aria-label when it has no text. */
  name: string;
  box: Box;
  disabled: boolean;
  /** Its whole box is on screen, inside every box that clips it, as the page stands (not scrolled). */
  inView: boolean;
}

export interface Reading {
  viewport: { width: number; height: number };
  /** The region's box (the wizard column, or the card). */
  region: Box;
  faults: TextFault[];
  controls: ControlReading[];
  /**
   * Every control and every element that draws text of its own in the
   * region, keyed by tag, text and occurrence, with its box: the full-width
   * pin compares these to the boxes recorded before SCRUM-884.
   */
  layout: { key: string; box: Box }[];
  /**
   * Each text's middle is on screen (in view, as for controls; the middle
   * half of its line height, as a glyph's ascent may rise above a tight line
   * box), for "fits in the window" checks.
   */
  textInView: Record<string, boolean>;
  /** The most lines any one occurrence of each text is drawn on. */
  textLines: Record<string, number>;
  /**
   * Every query container (`@container`) in the region, the region's own
   * included, with the inline size its queries are answered against (its
   * content box, less any scrollbar): the full-width pin reads that none is
   * under 36rem, so no `@max-xl` variant can be in effect there.
   */
  containers: { key: string; width: number }[];
}

const EPS = 1;
const round = (n: number) => Math.round(n * 10) / 10;
const boxOf = (r: DOMRect): Box => ({
  left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
  width: round(r.width), height: round(r.height),
});
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function shown(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * The boxes (up to the document) whose overflow clips `el`, each way: its
 * ancestors, and `el` itself for the text it draws (an ellipsis is the text's
 * own box clipping it).
 */
function clippers(el: Element, self = false): { el: Element; x: boolean; y: boolean }[] {
  const out: { el: Element; x: boolean; y: boolean }[] = [];
  for (let at = self ? el : el.parentElement; at; at = at.parentElement) {
    const style = getComputedStyle(at);
    const x = style.overflowX !== 'visible';
    const y = style.overflowY !== 'visible';
    if (x || y) out.push({ el: at, x, y });
  }
  return out;
}

/** Whether a rect is wholly inside the window and every box that clips it. */
function inView(rect: { left: number; top: number; right: number; bottom: number }, el: Element): boolean {
  if (rect.left < -EPS || rect.top < -EPS) return false;
  if (rect.right > window.innerWidth + EPS || rect.bottom > window.innerHeight + EPS) return false;
  for (const c of clippers(el)) {
    const box = c.el.getBoundingClientRect();
    if (c.x && (rect.left < box.left - EPS || rect.right > box.right + EPS)) return false;
    if (c.y && (rect.top < box.top - EPS || rect.bottom > box.bottom + EPS)) return false;
  }
  return true;
}

function controlName(el: Element): string {
  const text = squash(el.textContent ?? '');
  return (text || el.getAttribute('aria-label') || el.tagName.toLowerCase()).slice(0, 80);
}

export function readSplitView(): Reading {
  const region = document.getElementById('region');
  if (!region) throw new Error('no #region on the page');
  const faults: TextFault[] = [];
  const textInView: Record<string, boolean> = {};
  const textLines: Record<string, number> = {};

  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (!text.trim()) continue;
    const parent = node.parentElement;
    if (!parent || !shown(parent)) continue;
    const label = squash(text).slice(0, 60);
    const range = document.createRange();
    range.selectNodeContents(node);
    const whole = range.getBoundingClientRect();
    if (whole.width === 0 && whole.height === 0) continue;
    const inset = whole.height / 4;
    const middle = { left: whole.left, right: whole.right, top: whole.top + inset, bottom: whole.bottom - inset };
    textInView[label] = (textInView[label] ?? true) && inView(middle, parent);
    const lines = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    textLines[label] = Math.max(textLines[label] ?? 0, lines);

    // Clipped sideways: wider than a box that cuts it (an ellipsis, a fixed width).
    for (const c of clippers(parent, true)) {
      if (!c.x) continue;
      // Only the region's own boxes: the window's edge is the in-view check's.
      if (!region.contains(c.el)) break;
      const box = c.el.getBoundingClientRect();
      if (whole.left < box.left - EPS || whole.right > box.right + EPS) {
        faults.push({ kind: 'clipped', text: label, detail: `text ${round(whole.left)}..${round(whole.right)} in a box ${round(box.left)}..${round(box.right)}` });
        break;
      }
    }
    // One word on two lines.
    const re = /\S+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const word = document.createRange();
      word.setStart(node, m.index);
      word.setEnd(node, m.index + m[0].length);
      const tops = new Set(Array.from(word.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      if (tops.size > 1) faults.push({ kind: 'brokenWord', text: label, detail: `"${m[0]}" is drawn on ${tops.size} lines` });
    }
    // Outside the button it labels.
    const button = parent.closest('button, [role="button"]');
    if (button && region.contains(button)) {
      const b = button.getBoundingClientRect();
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0) continue;
        // Two px up and down: a glyph's ascent may rise above a tight line box.
        if (r.left < b.left - EPS || r.right > b.right + EPS || r.top < b.top - 2 || r.bottom > b.bottom + 2) {
          faults.push({
            kind: 'outsideButton', text: label,
            detail: `line ${round(r.left)},${round(r.top)}..${round(r.right)},${round(r.bottom)} in a button ${round(b.left)},${round(b.top)}..${round(b.right)},${round(b.bottom)}`,
          });
          break;
        }
      }
    }
  }

  const controls: ControlReading[] = Array.from(region.querySelectorAll('button, [role="button"], input'))
    .filter(shown)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        name: controlName(el),
        box: boxOf(rect),
        disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true',
        inView: inView(rect, el),
      };
    });

  const seen = new Map<string, number>();
  const layout: { key: string; box: Box }[] = [];
  for (const el of Array.from(region.querySelectorAll('*'))) {
    if (!shown(el)) continue;
    const control = el.matches('button, [role="button"], input');
    const own = squash(Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join(' '));
    if (!control && !own) continue;
    const base = `${el.tagName.toLowerCase()}|${(control ? controlName(el) : own).slice(0, 50)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    layout.push({ key: `${base}|${n}`, box: boxOf(el.getBoundingClientRect()) });
  }

  const containers: { key: string; width: number }[] = [];
  for (const el of [region, ...Array.from(region.querySelectorAll('*'))]) {
    if (!shown(el)) continue;
    const style = getComputedStyle(el);
    if (!style.containerType || style.containerType === 'normal') continue;
    const name = style.containerName && style.containerName !== 'none' ? style.containerName : '(unnamed)';
    const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    containers.push({ key: `${el.tagName.toLowerCase()}|${name}|${containers.length + 1}`, width: round(width) });
  }

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    region: boxOf(region.getBoundingClientRect()),
    faults,
    controls,
    layout,
    textInView,
    textLines,
    containers,
  };
}

declare global {
  interface Window {
    __readSplitView?: typeof readSplitView;
  }
}
