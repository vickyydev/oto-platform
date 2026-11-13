import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * SCRUM-963 (points 7 and 8 of SCRUM-969) — THE ONE-ROW CATEGORIES WITH A MOUSE.
 *
 * In the split view (and a desk window under about 1005 pixels) the F&B and
 * Shop categories stand in one row that scrolls sideways (SCRUM-959,
 * `fnb/MenuGrid`, `merch/MerchGrid`). A finger or a trackpad moves it; a plain
 * mouse wheel did not, so at 1440 only the first two categories could be
 * reached, and nothing showed that the row went on (the proof's 05a, 05b).
 *
 * In that one-row state only, this row:
 *   - turns a vertical wheel over it into a sideways move, and leaves the
 *     wheel to the page once the row is at its end that way;
 *   - shows a small arrow at each end, in the category buttons' own style,
 *     only while there is more that way; each moves the row about its width;
 *   - brings the chosen category (`data-chosen` on its button) into view when
 *     the choice changes, or when the row comes back (after a search).
 * A finger and a trackpad's sideways swipe are left to the browser, as now.
 * Where the categories wrap (full width) it is the plain row it was: nothing
 * is drawn and nothing is caught.
 */
export function CategoryRow({ className, chosen, children }: {
  /** The row's own classes, which decide where it is one row (`flex-nowrap`). */
  className: string;
  /** The chosen category's key: a change brings its button into view. */
  chosen: string;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ before: false, after: false });
  /**
   * SCRUM-975 — where the row's own ends are, from this wrapper's: the
   * one-row state reaches 8 pixels past it each side (`-mx-2 px-2`, so a
   * tile's shadow is not cut), and arrows at the wrapper's ends left a sliver
   * of the next tile outside each. They stand at the row's ends instead.
   */
  const [ends, setEnds] = useState({ left: 0, right: 0 });

  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const oneRow = oneRowOf(el);
    const end = el.scrollWidth - el.clientWidth;
    const next = { before: oneRow && el.scrollLeft > 1, after: oneRow && el.scrollLeft < end - 1 };
    setMore((was) => (was.before === next.before && was.after === next.after ? was : next));
    const holder = el.parentElement;
    const at = holder ? { left: el.offsetLeft, right: holder.clientWidth - el.offsetLeft - el.offsetWidth } : { left: 0, right: 0 };
    setEnds((was) => (was.left === at.left && was.right === at.right ? was : at));
  }, []);

  // Read again after every draw (categories added, the column resized), on
  // every move, and whenever the row's own box changes size.
  useEffect(measure);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resized?.observe(el);
    // The wheel: React's own wheel listener is passive, so this one is the row's.
    const wheel = (event: WheelEvent) => {
      if (!oneRowOf(el) || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const end = el.scrollWidth - el.clientWidth;
      const step = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * el.clientWidth : event.deltaY;
      if (end <= 0 || (step > 0 ? el.scrollLeft >= end - 1 : el.scrollLeft <= 1)) return;
      event.preventDefault();
      el.scrollLeft = Math.max(0, Math.min(end, el.scrollLeft + step));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', wheel);
      resized?.disconnect();
    };
  }, [measure]);

  // The chosen category in view, clear of the arrows.
  useEffect(() => {
    const el = row.current;
    const button = el?.querySelector<HTMLElement>('[data-chosen="true"]');
    if (!el || !button || !oneRowOf(el)) return;
    const box = el.getBoundingClientRect();
    const own = button.getBoundingClientRect();
    if (own.left < box.left + ARROW_ROOM) el.scrollBy({ left: own.left - box.left - ARROW_ROOM, behavior: 'smooth' });
    else if (own.right > box.right - ARROW_ROOM) el.scrollBy({ left: own.right - box.right + ARROW_ROOM, behavior: 'smooth' });
  }, [chosen]);

  const move = (way: -1 | 1) => {
    const el = row.current;
    if (el) el.scrollBy({ left: way * Math.max(el.clientWidth / 2, el.clientWidth - 2 * ARROW_ROOM), behavior: 'smooth' });
  };

  return (
    <div className="relative shrink-0">
      <div ref={row} className={className} data-testid="category-row">{children}</div>
      {more.before && <button type="button" className={ARROW} style={{ left: ends.left }} aria-label="Earlier categories" title="Earlier categories"
        onClick={() => move(-1)}><ChevronLeft className="h-5 w-5" /></button>}
      {more.after && <button type="button" className={ARROW} style={{ right: ends.right }} aria-label="More categories" title="More categories"
        onClick={() => move(1)}><ChevronRight className="h-5 w-5" /></button>}
    </div>
  );
}

/** The width an arrow and its gap keep at each end of the row. */
const ARROW_ROOM = 48;
/** The category buttons' own look (`bg-card border`, rounded), small, at the row's height. */
const ARROW = 'absolute top-1 z-10 flex h-10 w-10 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-md '
  + 'transition-all hover:border-primary/50 hover:text-foreground active:scale-95';

/** The row stands on one line (the split view's container query), rather than wrapping. */
function oneRowOf(el: HTMLElement): boolean {
  return getComputedStyle(el).flexWrap === 'nowrap';
}
