import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { hashTokens } from '../flags';
import {
  BUILD_TAG,
  isPerfLite,
  ROTATE_LANDSCAPE,
  STAGE_WIDTH,
  stageState,
  type RotateMode,
} from '../stageState';

/**
 * The television frame, lifted from the outgoing wheel (D21).
 *
 * The game is drawn once, portrait, at STAGE_WIDTH logical pixels — every size
 * in kiosk.css is a plain pixel measured against that width. This frame is what
 * makes that one drawing fill ANY screen, and it does two separate things:
 *
 * 1. Rotate. The booth televisions are hung portrait but still output
 *    landscape, so a page that did nothing would draw a portrait column lying
 *    on its side. When the viewport is wider than it is tall the whole stage is
 *    turned 90°, so it stands upright for whoever is standing in front of it.
 * 2. Scale. The stage is then zoomed so its logical width exactly fills the
 *    (possibly rotated) screen width. Without this a 55-inch television shows
 *    the wheel at phone size in the middle of a field of cream.
 *
 * Both transforms live on the stage element, which makes it the containing
 * block for everything inside — so the prize card, which is `position: fixed`,
 * is fixed to the STAGE and not to the physical screen. That is the difference
 * between a card centred in front of the guest and a card lying on its side in
 * the corner of the panel, and it is why the card is rendered inside the frame
 * rather than beside it. Anything added later that falls or flies — confetti,
 * a drifting mascot — has to be drawn inside here for the same reason: "down"
 * must mean the viewer's down, not the panel's.
 */

// Overrides are saved per build, so a rotation typed on the television during
// one afternoon's diagnosis cannot survive into the next version.
const ROTATE_KEY = 'oto-booth:rotate-override:' + BUILD_TAG;
const SCALE_KEY = 'oto-booth:scale-override:' + BUILD_TAG;

interface StageOverrides {
  rotate: RotateMode | null;
  noScale: boolean;
  debug: boolean;
}

/**
 * What the URL and the device say about this screen.
 *
 * A booth television has no keyboard and nobody standing at it with a laptop.
 * The way it is adjusted is by appending to the URL once from a phone on the
 * same network and reloading; the choice is then remembered on that device, so
 * the next power cut does not undo it. No republish, no rebuild, no visit.
 *
 *   #cw / #ccw  turn the other way on a sideways screen
 *   #off        never turn
 *   #noscale    turn but do not zoom to fit (the stage at its natural size)
 *   #scale      zoom to fit again
 *   #clear      forget every saved choice on this device
 *   #debug      keep the geometry box on screen
 *
 * `#lite` / `#full` are read in stageState.isPerfLite, and `#clear` forgets
 * that one too.
 */
function readOverrides(): StageOverrides {
  const tokens = hashTokens(typeof window === 'undefined' ? '' : window.location.hash);
  const has = (name: string) => tokens.includes(name);

  let rotate: RotateMode | null = null;
  if (has('ccw')) rotate = 'ccw';
  else if (has('cw')) rotate = 'cw';
  else if (has('off')) rotate = 'off';

  let noScale = false;
  try {
    if (has('clear')) {
      window.localStorage.removeItem(ROTATE_KEY);
      window.localStorage.removeItem(SCALE_KEY);
    } else {
      if (rotate !== null) {
        window.localStorage.setItem(ROTATE_KEY, rotate);
      } else {
        const saved = window.localStorage.getItem(ROTATE_KEY);
        if (saved === 'cw' || saved === 'ccw' || saved === 'off') rotate = saved;
      }

      if (has('noscale')) {
        window.localStorage.setItem(SCALE_KEY, 'off');
        noScale = true;
      } else if (has('scale')) {
        window.localStorage.removeItem(SCALE_KEY);
      } else {
        noScale = window.localStorage.getItem(SCALE_KEY) === 'off';
      }
    }
  } catch {
    // Storage refused. The hash still works for this load — it just is not
    // remembered, which is the right way round: a booth that cannot save its
    // rotation is better than a booth that cannot be rotated.
    noScale = has('noscale');
  }

  return { rotate, noScale, debug: has('debug') };
}

/**
 * The real CSS viewport, measured rather than asked for.
 *
 * Television browsers lie. `window.innerWidth` can report physical panel pixels
 * (1920×1080) while the page actually lays out in a smaller CSS viewport, and
 * `documentElement.clientHeight` can report the page's CONTENT height instead
 * of the screen's. Either lie breaks the landscape test and makes the zoom
 * factor wildly wrong. Dropping a real `100vw × 100vh` element into the page
 * and measuring it is the one answer no engine has got wrong yet.
 */
function viewportSize(): { w: number; h: number } {
  let probe: HTMLDivElement | null = null;
  try {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
    const w = probe.offsetWidth;
    const h = probe.offsetHeight;
    if (w > 0 && h > 0) return { w, h };
  } catch {
    // fall through to the numbers the window will admit to
  } finally {
    if (probe?.parentNode) probe.parentNode.removeChild(probe);
  }
  return { w: window.innerWidth, h: window.innerHeight };
}

function reading(read: () => number): string {
  try {
    const value = read();
    return typeof value === 'number' && isFinite(value)
      ? String(Math.round(value * 100) / 100)
      : '?';
  } catch {
    return '?';
  }
}

export default function OrientationFrame({ children }: { children: ReactNode }) {
  const [{ w, h }, setSize] = useState(viewportSize);
  const [overrides, setOverrides] = useState(readOverrides);

  useEffect(() => {
    const onResize = () => setSize(viewportSize());
    const onHashChange = () => setOverrides(readOverrides());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const rotateMode: RotateMode = overrides.rotate ?? ROTATE_LANDSCAPE;
  const rotated = rotateMode !== 'off' && w > h;

  // Published BEFORE the children render, so anything inside the stage can read
  // the active rotation in its own first render without measuring the DOM.
  stageState.rotateMode = rotateMode;
  stageState.rotated = rotated;

  // The screen the game has to fill, in the stage's own axes.
  const stageW = rotated ? h : w;
  const stageH = rotated ? w : h;

  // One uniform zoom, so the logical width fills the screen width exactly.
  // `#noscale` renders the stage 1:1 at the real screen size instead.
  const scale = overrides.noScale ? 1 : stageW / STAGE_WIDTH;
  const designW = overrides.noScale ? stageW : STAGE_WIDTH;
  const designH = stageH / scale;

  stageState.designW = designW;
  stageState.designH = designH;

  const outerStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    width: stageW,
    height: stageH,
    overflow: 'hidden',
    ...(rotated
      ? {
          transformOrigin: 'top left',
          // Turning about the top-left corner leaves the stage off-screen; the
          // translate brings it back over the viewport. `cw` sends the
          // portrait top to the right-hand edge of the landscape signal.
          transform:
            rotateMode === 'ccw'
              ? 'rotate(-90deg) translateX(-100%)'
              : 'rotate(90deg) translateY(-100%)',
        }
      : null),
  };

  const stageStyle: CSSProperties = {
    width: designW,
    height: designH,
    overflow: 'hidden',
    transformOrigin: 'top left',
    transform: `scale(${scale})`,
    // Inside the stage, "the whole height" is the stage's logical height, not
    // the panel's: a `100dvh` in here would measure the physical screen and
    // overflow the stage by the scale factor. Anything that needs the full
    // height uses var(--app-h) instead. Today every container in kiosk.css
    // chains plain percentages off this element, so nothing reads it yet — it
    // is published so that the first one that needs it has a right answer to
    // reach for.
    ['--app-h' as string]: `${designH}px`,
  };

  /**
   * The geometry box (`#debug` only).
   *
   * Rendered in raw viewport space, OUTSIDE both transforms, which is the
   * entire point: it is readable in a photograph exactly when the stage maths
   * has gone wrong, and that is precisely when the staff diagnostics overlay —
   * which lives inside the stage — cannot be read. It carries nothing but this
   * build's tag and the screen's own measurements: no booth name, no address,
   * no prize, nothing about a guest (D15).
   */
  const debugStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    maxWidth: '95vw',
    zIndex: 9999,
    background: 'rgba(0,0,0,0.85)',
    color: '#ffffff',
    fontFamily: 'monospace',
    fontSize: 18,
    lineHeight: '26px',
    padding: '12px 16px',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
  };

  const debugText = [
    `booth stage ${BUILD_TAG}`,
    `probe ${w} x ${h}`,
    `inner ${reading(() => window.innerWidth)} x ${reading(() => window.innerHeight)}`,
    `client ${reading(() => document.documentElement.clientWidth)} x ${reading(
      () => document.documentElement.clientHeight,
    )}`,
    `screen ${reading(() => window.screen.width)} x ${reading(
      () => window.screen.height,
    )}  dpr ${reading(() => window.devicePixelRatio)}`,
    `rotate ${rotateMode}${overrides.rotate ? ' (saved)' : ''} -> ${rotated ? 'ON' : 'off'}`,
    `zoom-fit ${overrides.noScale ? 'OFF (#noscale)' : 'on'}  scale ${scale.toFixed(3)}`,
    `perf-lite ${isPerfLite() ? 'ON' : 'off'} (#lite / #full)`,
    `stage ${Math.round(designW)} x ${Math.round(designH)}`,
  ].join('\n');

  return (
    <>
      <div style={outerStyle} data-booth-frame="1" data-rotated={rotated ? '1' : '0'}>
        <div style={stageStyle} data-booth-stage="1">
          {children}
        </div>
      </div>
      {overrides.debug ? (
        <div style={debugStyle} data-booth-stage-debug="1">
          {debugText}
        </div>
      ) : null}
    </>
  );
}
