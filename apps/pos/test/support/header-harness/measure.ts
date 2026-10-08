/**
 * SCRUM-505 — what the header measurement test reads off the page, run in the
 * browser (`main.ts` hangs it on `window.__readHeader`). Pure DOM: boxes as
 * the browser laid them out, nothing inferred from class names.
 */
export interface ControlBox {
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Overlap {
  a: string;
  b: string;
  /** Width of the shared strip, in px. */
  x: number;
  /** Height of the shared strip, in px. */
  y: number;
}

export interface HeaderReading {
  layout: 'till' | 'phone';
  viewport: number;
  /** The header row's box and how wide its content wants to be. */
  row: { width: number; height: number; scrollWidth: number };
  controls: ControlBox[];
  /** Every pair of controls whose boxes share more than half a pixel each way. */
  overlaps: Overlap[];
  /** Controls drawn (even partly) outside the window. */
  outside: string[];
  logo: { width: number; natural: number };
  /** The tab band (till header only). */
  nav: {
    /** The band's box: what is on screen. */
    width: number;
    /** The tabs' total width; more than `width` means the band scrolls. */
    scrollWidth: number;
    tabs: number;
    /** Tabs whose whole box is inside the band as it stands (not scrolled). */
    wholeTabsVisible: number;
    widestTab: number;
    /** Distinct rows the tabs sit on. */
    rows: number;
    /** Every tab's label sits on one line inside its own box. */
    labelsWhole: boolean;
    /** The band's `overflow-x`: what makes the tabs past its edge reachable. */
    overflowX: string;
  } | null;
  chip: {
    text: string;
    width: number;
    /** Line boxes the park's name takes. */
    lines: number;
    /** The name's text is wider or taller than its box shows. */
    clipped: boolean;
  };
}

const EPS = 0.5;

function nameOf(el: Element): string {
  const labelled = [el, ...Array.from(el.querySelectorAll('*'))].find(
    (e) => e.getAttribute('aria-label') || e.getAttribute('title'),
  );
  const label = labelled?.getAttribute('aria-label') || labelled?.getAttribute('title') || '';
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return (label || text || el.tagName.toLowerCase()).slice(0, 40);
}

/** The box an element paints: its own, grown by any descendant that spills out of it. */
function paintedBox(el: Element, name: string): ControlBox {
  const rects = [el, ...Array.from(el.querySelectorAll('*'))]
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  return {
    name,
    left: Math.min(...rects.map((r) => r.left)),
    right: Math.max(...rects.map((r) => r.right)),
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

function ownBox(el: Element, name: string): ControlBox {
  const r = el.getBoundingClientRect();
  return { name, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Line boxes taken by an element's own text (its direct text nodes; icons and badges are not text). */
function lineCount(el: Element): number {
  const tops = new Set<number>();
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE || !(node.textContent ?? '').trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) if (r.width > 0) tops.add(Math.round(r.top));
  }
  return tops.size;
}

export function readHeader(): HeaderReading {
  const layout = document.querySelector('#till') ? 'till' : 'phone';
  const row =
    layout === 'till'
      ? document.querySelector('#till > div')
      : document.querySelector('#phone > div > div');
  if (!(row instanceof HTMLElement)) throw new Error(`no header row in the ${layout} layout`);

  const controls: ControlBox[] = [];
  let navReading: HeaderReading['nav'] = null;

  if (layout === 'till') {
    const [left, band, right] = Array.from(row.children);
    if (!left || !band || !right) throw new Error('the till header has lost its three parts');
    for (const el of Array.from(left.children)) if (visible(el)) controls.push(paintedBox(el, nameOf(el)));
    const nav = band.querySelector('nav');
    if (!nav) throw new Error('no tab band');
    controls.push(ownBox(nav, 'tab band'));
    for (const el of Array.from(right.children)) if (visible(el)) controls.push(paintedBox(el, nameOf(el)));

    const navRect = nav.getBoundingClientRect();
    const tabs = Array.from(nav.children).map((t) => t.getBoundingClientRect());
    const labels = Array.from(nav.children).map((t) => t.querySelector('button') ?? t);
    navReading = {
      width: navRect.width,
      scrollWidth: nav.scrollWidth,
      tabs: tabs.length,
      wholeTabsVisible: tabs.filter((t) => t.left >= navRect.left - EPS && t.right <= navRect.right + EPS).length,
      widestTab: Math.max(...tabs.map((t) => t.width)),
      rows: new Set(tabs.map((t) => Math.round(t.top))).size,
      labelsWhole: labels.every((l) => lineCount(l) === 1 && l.scrollWidth <= l.clientWidth + EPS),
      overflowX: getComputedStyle(nav).overflowX,
    };
  } else {
    for (const el of Array.from(row.children)) {
      // The bar's spacer is an empty flex-1 div, not a control.
      if (el.children.length === 0 && (el.textContent ?? '').trim() === '') continue;
      if (visible(el)) controls.push(paintedBox(el, nameOf(el)));
    }
  }

  const overlaps: Overlap[] = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!;
      const b = controls[j]!;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > EPS && y > EPS) overlaps.push({ a: a.name, b: b.name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    }
  }

  const viewport = document.documentElement.clientWidth;
  const outside = controls.filter((c) => c.left < -EPS || c.right > viewport + EPS).map((c) => c.name);

  const img = row.querySelector('img');
  if (!(img instanceof HTMLImageElement)) throw new Error('no logo');
  const imgRect = img.getBoundingClientRect();
  const natural = img.naturalHeight > 0 ? (img.naturalWidth * imgRect.height) / img.naturalHeight : 0;

  const name = row.querySelector('span[title]');
  if (!(name instanceof HTMLElement)) throw new Error('no park name in the chip');
  const chip = name.closest('button') ?? name.parentElement ?? name;

  const rowRect = row.getBoundingClientRect();
  return {
    layout,
    viewport,
    row: { width: rowRect.width, height: rowRect.height, scrollWidth: row.scrollWidth },
    controls,
    overlaps,
    outside,
    logo: { width: imgRect.width, natural },
    nav: navReading,
    chip: {
      text: name.textContent ?? '',
      width: chip.getBoundingClientRect().width,
      lines: lineCount(name),
      clipped: name.scrollWidth > name.clientWidth + EPS || name.scrollHeight > name.clientHeight + EPS,
    },
  };
}
