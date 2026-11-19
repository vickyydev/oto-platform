import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { keyedWidth, listWidth, LIST_MIN } from '@/lib/panes';

export const DIVIDER_LABEL = 'Resize the conversation list';
export const DIVIDER_HINT = 'Drag to resize. Double-click to go back to the default.';
/** Two taps this close together, without a drag, reset the width. */
const DOUBLE_TAP_MS = 350;
/** A press that moves less than this is a tap, not a drag. */
const TAP_SLOP = 4;

/**
 * The divider between the list and the chat (SCRUM-1045): the list's 1 px
 * edge with an invisible grab area over it, the col-resize cursor, and a
 * grip. With a mouse the area is 16 px wide and the grip shows on hover, on
 * focus and while dragging. On a touch screen, which has no hover, the grip
 * is always drawn, a small pill on the edge at mid-height, and it is the
 * finger's target: 44 px wide and 64 px tall, centred on the edge. The full
 * height strip there is 16 px, centred on the edge, so it reaches no further
 * into the chat than 8 px: clear of the composer's Templates button and the
 * chat header, whose own targets start 13 px in. A mouse, a finger or a pen
 * drags it (pointer events with the pointer captured, no scrolling or text
 * selection on the way); the keyboard moves it 16 px a press, Home and End
 * go to the limits; Enter, a double click or a double tap go back to the
 * default.
 *
 * While dragging only `onLive` runs, on every move: the workspace sets a CSS
 * variable on the shell, so the panes follow the pointer without React
 * drawing the message list again. The width is committed once, on release.
 */
export function PaneDivider({
  width,
  room,
  max,
  left,
  controls,
  onLive,
  onCommit,
}: {
  /** The list's width now, in px. */
  width: number;
  /** Room for the list and the chat together, in px. */
  room: number;
  /** The widest the list may be in this room. */
  max: number;
  /** Where the list's edge is, as CSS (`calc(224px + var(--list-w))`). */
  left: string;
  /** The id of the list's region, for `aria-controls`. */
  controls: string;
  onLive: (width: number) => void;
  /** A width chosen, or 'default' to forget the choice. */
  onCommit: (width: number | 'default') => void;
}) {
  const drag = useRef<{ id: number; x: number; from: number; at: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const [dragging, setDragging] = useState(false);

  const settle = () => {
    setDragging(false);
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that cannot be captured still drags while it stays over the handle.
    }
    drag.current = { id: e.pointerId, x: e.clientX, from: width, at: width, moved: false };
    setDragging(true);
    document.body.style.setProperty('user-select', 'none');
    document.body.style.setProperty('cursor', 'col-resize');
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) >= TAP_SLOP) d.moved = true;
    if (!d.moved) return;
    const next = listWidth(d.from + dx, room);
    if (next === d.at) return;
    d.at = next;
    onLive(next);
    // Said as it moves, without a render: the committed value follows on release.
    e.currentTarget.setAttribute('aria-valuenow', String(next));
  };

  const finish = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    settle();
    if (d.moved) {
      lastTap.current = 0;
      onCommit(d.at);
      return;
    }
    if (cancelled) return;
    // A tap: the second within the window resets.
    if (e.timeStamp - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      onCommit('default');
    } else lastTap.current = e.timeStamp;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyedWidth(e.key, width, room);
    if (next === null) return;
    e.preventDefault();
    onCommit(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={DIVIDER_LABEL}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={LIST_MIN}
      aria-valuemax={max}
      title={DIVIDER_HINT}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onLostPointerCapture={(e) => finish(e, true)}
      onDoubleClick={() => onCommit('default')}
      onKeyDown={onKeyDown}
      style={{ left }}
      className="group absolute inset-y-0 z-20 -ml-1 w-4 cursor-col-resize touch-none select-none focus-visible:outline-none [@media(any-pointer:coarse)]:-ml-2"
    >
      {/* The edge itself, over the list's 1 px border, darkened while it is held or hovered. */}
      <span
        aria-hidden
        data-divider-line
        className="absolute inset-y-0 left-[3px] w-px bg-transparent transition-colors group-hover:bg-edge group-focus-visible:bg-coral group-data-[dragging=true]:bg-coral [@media(any-pointer:coarse)]:left-[7px]"
      />
      {/* The grip, centred on the edge: with a mouse shown on hover, on focus and while dragging; on a
          touch screen always, in the muted ink (5 : 1 on the card and the ground, tokens-1016), a little larger. */}
      <span
        aria-hidden
        data-divider-grip
        className="absolute left-[1.5px] top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-edge opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:bg-coral group-focus-visible:opacity-100 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-coral group-data-[dragging=true]:bg-coral group-data-[dragging=true]:opacity-100 [@media(any-pointer:coarse)]:left-[4.5px] [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-1.5 [@media(any-pointer:coarse)]:bg-ink-muted [@media(any-pointer:coarse)]:opacity-100"
      />
      {/* A finger's target around the grip: 44 px wide and 64 px tall, centred on the edge (touch screens only). */}
      <span
        aria-hidden
        data-divider-target
        className="absolute left-1/2 top-1/2 hidden h-16 w-[var(--ui-touch-min)] -translate-x-1/2 -translate-y-1/2 [@media(any-pointer:coarse)]:block"
      />
    </div>
  );
}
