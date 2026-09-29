import { useEffect, useRef } from 'react';
import { boothSpinDurationSeconds } from '@oto/shared';
import { playSfx } from '../sound';

/**
 * One slice, reduced to what drawing needs.
 *
 * The wheel is a pure renderer of a decision made elsewhere — the outgoing
 * game's best structural idea, and the one this ticket depends on, because the
 * decision now happens on a box and arrives over the wire. It is given an
 * index to land on and it lands on it; it does not know what a prize is worth,
 * what a voucher is, or that a booth exists.
 */
export interface WheelSlice {
  id: string;
  /** Already resolved from `wheelLabel` / `nameEn`. May contain newlines. */
  label: string;
  color: string;
  textColor: string;
}

interface Props {
  slices: WheelSlice[];
  /** The slice to land on, or null when the wheel is at rest. */
  targetIndex: number | null;
  /** Fired when the animation finishes. The caller already knows what was won. */
  onSpinEnd?: () => void;
  isSpinning: boolean;
  spinDurationSeconds?: number;
}

const FULL_SPINS = 6;

// Must match the CSS transition timing function used for the spin below — the
// tick scheduler samples this same curve to fire clicks exactly when a slice
// divider passes the pointer.
const BEZ = [0.16, 1, 0.3, 1] as const;

// 20 dot-lights evenly spaced around the rim.
const DOT_ANGLES = Array.from({ length: 20 }, (_, i) => i * 18);

// Evaluate progress of cubic-bezier(x1,y1,x2,y2) at time fraction x (0..1).
// Standard bisection on the x-polynomial — runs once per spin, not per frame.
function bezierProgress(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = BEZ;
  const cx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const cy = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cx(mid) < x) lo = mid;
    else hi = mid;
  }
  return cy((lo + hi) / 2);
}

/**
 * The spin is a plain CSS transition on `transform`, driven imperatively, and
 * completion is a `setTimeout` — not an animation-library callback. A timeout
 * always fires, so the flow always advances to the result even if the
 * transition never runs.
 */
export function Wheel({ slices, targetIndex, onSpinEnd, isSpinning, spinDurationSeconds }: Props) {
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<HTMLDivElement | null>(null);
  const flashRef = useRef<HTMLDivElement | null>(null);
  const rotationRef = useRef(0);
  const durationRef = useRef(boothSpinDurationSeconds({ spinDurationSeconds }));
  useEffect(() => {
    durationRef.current = boothSpinDurationSeconds({ spinDurationSeconds });
  });

  // Keep the latest callback in a ref so the spin effect never re-runs mid-spin.
  const onSpinEndRef = useRef(onSpinEnd);
  useEffect(() => {
    onSpinEndRef.current = onSpinEnd;
  });

  /**
   * The slices the CURRENT spin is turning through, held in a ref.
   *
   * This is D22, and it is the whole reason this component differs from the
   * one it was lifted from. There, the spin effect listed `prizes` in its
   * dependency array; a config picked up while the wheel was turning gave that
   * array a new identity, React tore the effect down and ran it again, and the
   * cleanup cancelled the landing timer while the replacement recomputed the
   * angle from wherever the wheel had got to — a wheel that visibly jumps and
   * then stops on the wrong slice.
   *
   * The caller applies configuration only in `ready` for the same reason, so
   * in practice this array does not change mid-spin. Both guards are kept
   * because they fail differently: one is a rule somebody has to keep, and
   * this one is structural.
   *
   * **This effect must stay above the spin effect.** Effects run in the order
   * their hooks are declared, so a spin started in the same commit that
   * delivered a new array reads the new one — which is what the press path
   * depends on when it reloads a stale bundle and then animates. Moved below,
   * that spin would turn to an index in an array that is no longer on screen.
   */
  const slicesRef = useRef(slices);
  useEffect(() => {
    slicesRef.current = slices;
  });

  // After each spin, snap the stored rotation back into 0–360 (the same visual
  // angle) with the transition disabled. Without this the angle grows by
  // ~2400° every replay, and after a long day the huge numbers make transform
  // interpolation jitter mid-spin.
  useEffect(() => {
    if (isSpinning) return;
    const el = wheelRef.current;
    if (!el) return;
    const norm = ((rotationRef.current % 360) + 360) % 360;
    if (norm === rotationRef.current) return;
    rotationRef.current = norm;
    el.style.transition = 'none';
    // translateZ(0) forces the wheel onto its own layer, so rotating it spins
    // a cached texture instead of repainting the SVG every frame.
    el.style.transform = 'rotate(' + norm + 'deg) translateZ(0)';
  }, [isSpinning]);

  useEffect(() => {
    if (targetIndex === null || !isSpinning) return;
    const spinSlices = slicesRef.current;
    if (spinSlices.length === 0) return;
    // One snapshot drives the animation, ticks and landing timer for this spin.
    const durationSeconds = durationRef.current;
    const slice = 360 / spinSlices.length;

    // The pointer is at 12 o'clock. Slice i is centred at i*slice + slice/2
    // measured clockwise from the top; to bring that centre under the pointer
    // the wheel rotates counter to it.
    const sliceCenter = targetIndex * slice + slice / 2;
    // A little jitter inside the slice so it never stops dead centre. Kept
    // inside 60% of the wedge, so the landing is always unambiguously within
    // the slice that was drawn.
    const jitter = (Math.random() - 0.5) * (slice * 0.6);
    const targetAngle = -(sliceCenter + jitter);

    const current = rotationRef.current;
    const currentMod = ((current % 360) + 360) % 360;
    const targetMod = ((targetAngle % 360) + 360) % 360;
    let delta = targetMod - currentMod;
    if (delta <= 0) delta += 360;
    const final = current + FULL_SPINS * 360 + delta;
    rotationRef.current = final;

    const el = wheelRef.current;
    // Clear any winning-slice flash left over from the previous round.
    if (flashRef.current) {
      flashRef.current.className = 'k-wheel-flash';
      flashRef.current.style.opacity = '0';
    }
    if (el) {
      // Pin the starting angle with no transition, force a style flush, then
      // enable the transition and set the final angle.
      el.style.transition = 'none';
      el.style.transform = 'rotate(' + current + 'deg) translateZ(0)';
      void el.getBoundingClientRect();
      el.style.transition =
        'transform ' + durationSeconds + 's cubic-bezier(' + BEZ.join(', ') + ')';
      el.style.transform = 'rotate(' + final + 'deg) translateZ(0)';
    }

    // ---- Tick schedule: one click + pointer flick per slice divider ----
    // Precompute the exact times the wheel crosses each divider by sampling the
    // same easing curve the CSS transition uses. All cheap setTimeouts — no rAF
    // loop competing with the spin animation for frames.
    const totalDeg = final - current;
    const startOffset = ((-current % slice) + slice) % slice; // deg to first divider
    // Every timer, the flick resets included, is tracked here and cleared on
    // cleanup so nothing can fire after an unmount or a phase change.
    const tickTimers: number[] = [];
    // During the fast opening of the spin the dividers pass faster than the eye
    // separates them; skip any tick closer than this to the previous one.
    const MIN_TICK_GAP_MS = 90;
    let lastTickMs = -Infinity;
    for (let deg = startOffset; deg <= totalDeg; deg += slice) {
      const frac = deg / totalDeg; // progress at which this divider passes
      // Invert progress -> time by bisection on bezierProgress.
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (bezierProgress(mid) < frac) lo = mid;
        else hi = mid;
      }
      const tMs = ((lo + hi) / 2) * durationSeconds * 1000;
      if (tMs < 40 || tMs > durationSeconds * 1000 - 60) continue;
      if (tMs - lastTickMs < MIN_TICK_GAP_MS) continue;
      lastTickMs = tMs;
      tickTimers.push(
        window.setTimeout(() => {
          playSfx('tick');
          // Pointer micro-flick + slice flash, kept subtle so the arrow's
          // motion does not distract from the wheel.
          const p = pointerRef.current;
          const f = flashRef.current;
          if (p) p.style.transform = 'rotate(-7deg)';
          if (f) f.style.opacity = '0.3';
          tickTimers.push(
            window.setTimeout(() => {
              if (pointerRef.current) pointerRef.current.style.transform = 'rotate(0deg)';
              if (flashRef.current) flashRef.current.style.opacity = '0';
            }, 70),
          );
        }, tMs),
      );
    }

    const endTimer = window.setTimeout(() => {
      // One satisfying pointer bounce on landing.
      const p = pointerRef.current;
      if (p) {
        p.style.transform = 'rotate(-20deg)';
        window.setTimeout(() => {
          if (pointerRef.current) pointerRef.current.style.transform = 'rotate(0deg)';
        }, 140);
      }
      // Highlight the winning slice: the flash wedge sits exactly under the
      // pointer, so a triple blink there marks the winner while the reveal
      // delay holds the prize card back. Safe — the wheel has stopped.
      const f = flashRef.current;
      if (f) {
        f.style.opacity = '0';
        f.className = 'k-wheel-flash k-wheel-flash--won';
      }
      playSfx('win');
      onSpinEndRef.current?.();
    }, durationSeconds * 1000);

    return () => {
      window.clearTimeout(endTimer);
      tickTimers.forEach((t) => window.clearTimeout(t));
    };
    // `slices` is deliberately absent — see slicesRef above. `targetIndex` and
    // `isSpinning` are the only two inputs that may start or stop a spin.
  }, [targetIndex, isSpinning]);

  const svg = buildWheelSvg(slices);

  return (
    <div className="k-wheel">
      {/* Soft breathing glow behind the wheel — part of the attract, and the
          reason an idle booth never looks switched off. */}
      <div className="k-wheel-glow" aria-hidden />

      {/* Outer ring (black border + cream gap) with carnival dot-lights.
          Idle: two alternating dot groups blink. Spinning: frozen all-lit by
          the .k-screen--spinning guard. */}
      <div className="k-wheel-ring">
        <svg className="k-wheel-dots" viewBox="0 0 400 400" aria-hidden>
          {/* Two animated groups instead of 20 animated circles. */}
          {[0, 1].map((group) => (
            <g key={group} className={group === 0 ? 'k-dot-a' : 'k-dot-b'}>
              {DOT_ANGLES.filter((_, i) => i % 2 === group).map((deg) => {
                const rad = (deg * Math.PI) / 180;
                return (
                  <circle
                    key={deg}
                    cx={200 + 193 * Math.cos(rad)}
                    cy={200 + 193 * Math.sin(rad)}
                    r={4}
                    fill="#FFE72E"
                  />
                );
              })}
            </g>
          ))}
        </svg>
        <div className="k-wheel-ring-inner">
          {/* The settle wobble runs on the FACE wrapper, not the spin div, so
              it can never clobber the imperative rotation transform. */}
          <div className={isSpinning ? 'k-wheel-face' : 'k-wheel-face k-wheel-face--settle'}>
            {/* Spinning wheel — transform driven imperatively (see effect). */}
            <div
              ref={wheelRef}
              className="k-wheel-spin"
              style={{ transformOrigin: '50% 50%' }}
              // The SVG is built from configuration that has been through the
              // bundle schema, and every value interpolated into it goes
              // through escapeXml or a colour test first (src/booth/design.ts).
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            {/* Tick flash: a wedge-shaped brightener fixed under the pointer. */}
            <div ref={flashRef} className="k-wheel-flash" aria-hidden />
          </div>

          <div className="k-wheel-hub">
            <div className="k-wheel-hub-dot" />
          </div>
        </div>
      </div>

      {/* Pointer at top — the inner div is flicked by the tick scheduler. */}
      <div className="k-wheel-pointer">
        <div ref={pointerRef} className="k-wheel-pointer-flex">
          <svg width="34" height="44" viewBox="0 0 34 44" fill="none">
            <path d="M17 42 L3 6 Q17 0 31 6 Z" fill="#111111" />
            <path d="M17 38 L6 8 Q17 4 28 8 Z" fill="#FF8A3D" />
          </svg>
        </div>
      </div>
      {/* An empty wheel is a booth whose every prize was archived. It cannot
          happen from a published bundle — publishing refuses an empty active
          list — but the renderer says so rather than drawing a blank disc. */}
      {slices.length === 0 && <div className="k-wheel-empty">—</div>}
    </div>
  );
}

// Build the wheel as inline SVG so slice colours and labels stay crisp.
function buildWheelSvg(slices: WheelSlice[]): string {
  if (slices.length === 0) return '';
  const size = 400;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;
  const slice = 360 / slices.length;

  // Slices are drawn clockwise starting from the top (-90 deg in SVG coords).
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;

  const paths = slices
    .map((entry, i) => {
      const startAngle = i * slice;
      const endAngle = (i + 1) * slice;
      const x1 = cx + r * Math.cos(toRad(startAngle));
      const y1 = cy + r * Math.sin(toRad(startAngle));
      const x2 = cx + r * Math.cos(toRad(endAngle));
      const y2 = cy + r * Math.sin(toRad(endAngle));
      const largeArc = slice > 180 ? 1 : 0;
      const d = [
        `M ${cx} ${cy}`,
        `L ${x1} ${y1}`,
        `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
        'Z',
      ].join(' ');

      const labelAngle = startAngle + slice / 2;
      const labelR = r * 0.62;
      const lx = cx + labelR * Math.cos(toRad(labelAngle));
      const ly = cy + labelR * Math.sin(toRad(labelAngle));

      const lines = entry.label.split('\n');
      // Narrow wedges need smaller type for long words, and a multi-line label
      // sits deeper in the wedge where it is narrower still, so it gets a
      // smaller cap again.
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      const fontSize =
        lines.length > 1 ? (longest <= 5 ? 19 : 16) : longest <= 5 ? 24 : longest <= 7 ? 19 : 16;
      const lineHeight = fontSize + 2;
      const startY = ly - ((lines.length - 1) * lineHeight) / 2;

      const tspans = lines
        .map(
          (line, idx) =>
            `<tspan x="${lx}" y="${startY + idx * lineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join('');

      // Every label points the same way (radially, top of text toward the rim)
      // so the wheel reads consistently all the way round.
      return `
        <g>
          <path d="${d}" fill="${entry.color}" stroke="#111111" stroke-width="2" />
          <text
            transform="rotate(${labelAngle} ${lx} ${ly})"
            text-anchor="middle"
            dominant-baseline="middle"
            font-family="'Climate Crisis', 'Benzin', 'Noto Sans Thai', 'Booth Thai', system-ui, sans-serif"
            font-weight="500"
            font-size="${fontSize}"
            fill="${entry.textColor}"
            style="letter-spacing: -0.01em"
          >${tspans}</text>
        </g>`;
    })
    .join('');

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%">
      <defs>
        <radialGradient id="sheen" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stop-color="white" stop-opacity="0.35" />
          <stop offset="60%" stop-color="white" stop-opacity="0" />
        </radialGradient>
      </defs>
      ${paths}
      <circle cx="${cx}" cy="${cy}" r="${r - 1}" fill="url(#sheen)" pointer-events="none" />
    </svg>`;
}

/**
 * Escape the three characters that can close a tag or open an entity.
 *
 * The label is configuration, not guest input, and it has been through the
 * bundle schema — but it is being interpolated into markup that is then
 * assigned to `innerHTML`, and "an administrator typed it" is not a property
 * this function can check. Quotes are not escaped because a label is only ever
 * placed in element content here, never in an attribute.
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
