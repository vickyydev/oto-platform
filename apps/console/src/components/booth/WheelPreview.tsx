import type { BoothPrizeDraft } from './boothApi';
import { chanceBpOf, formatBp, weightVerdict } from './odds';

/**
 * The wheel as the television will draw it — and, more importantly, as it will
 * NOT be read.
 *
 * **Every slice is the same size, whatever its odds.** That is not a
 * simplification for the preview: `apps/booth/src/components/Wheel.tsx`
 * computes `360 / slices.length` and draws equal wedges, so on the television
 * in the mall the 2.5% grand prize is exactly as wide as the 27.5% sticker.
 * The weights drive which slice the box picks; they do not change the picture.
 *
 * Drawing proportional wedges here would be the prettier chart and the wrong
 * one twice over: it would not be what the booth shows, and it would let a
 * manager check the odds by eye on a picture that no longer matches the
 * arithmetic the moment a prize is switched off. So the geometry is copied
 * from the booth, the odds are printed as numbers beside each label, and the
 * panel says which of the two is which.
 *
 * Copied deliberately and stated so it can be found again: slice order,
 * clockwise from twelve o'clock; labels at 0.62 of the radius, rotated
 * radially; the same font-size steps for long and multi-line labels. If the
 * booth's wheel changes shape, this is the other half of that change.
 */
export function WheelPreview({
  prizes,
  className,
}: {
  /** In slice order — the order the wheel draws, which is `sortOrder`. */
  prizes: readonly BoothPrizeDraft[];
  className?: string;
}) {
  // The wheel the box would draw from: the active prizes, in slice order. A
  // switched-off prize is not a blank wedge on the television, it is absent.
  const slices = prizes.filter((p) => p.active);
  const verdict = weightVerdict(prizes);

  if (slices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        Every prize is switched off, so there is no wheel to draw. The booth would refuse each
        press with “Booth not ready — please call staff”.
      </div>
    );
  }

  const size = 400;
  const c = size / 2;
  const r = size / 2 - 1;
  const step = 360 / slices.length;
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[22rem] mx-auto block" role="img"
        aria-label={`Wheel preview: ${slices.length} slices in order — ${slices.map((s) => labelOf(s)).join(', ')}`}
      >
        {slices.map((prize, i) => {
          const start = i * step;
          const end = (i + 1) * step;
          const x1 = c + r * Math.cos(toRad(start));
          const y1 = c + r * Math.sin(toRad(start));
          const x2 = c + r * Math.cos(toRad(end));
          const y2 = c + r * Math.sin(toRad(end));
          const largeArc = step > 180 ? 1 : 0;
          const d = `M ${c} ${c} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;

          const labelAngle = start + step / 2;
          const labelR = r * 0.62;
          const lx = c + labelR * Math.cos(toRad(labelAngle));
          const ly = c + labelR * Math.sin(toRad(labelAngle));
          const lines = labelOf(prize).split('\n');
          const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
          const fontSize =
            lines.length > 1 ? (longest <= 5 ? 19 : 16) : longest <= 5 ? 24 : longest <= 7 ? 19 : 16;
          const lineHeight = fontSize + 2;
          const firstY = ly - ((lines.length - 1) * lineHeight) / 2;

          return (
            <g key={prize.id}>
              <path
                d={d}
                fill={prize.sliceColor ?? placeholderInk(i, slices.length)}
                stroke="#111111"
                strokeWidth={2}
              />
              <text
                transform={`rotate(${labelAngle} ${lx} ${ly})`}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={fontSize}
                fontWeight={600}
                fill={prize.textColor ?? '#111111'}
              >
                {lines.map((line, idx) => (
                  <tspan key={idx} x={lx} y={firstY + idx * lineHeight}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>

      <ol className="mt-4 flex flex-col gap-1.5">
        {slices.map((prize, i) => (
          <li key={prize.id} className="flex items-center gap-2.5 text-sm">
            <span
              className="h-3.5 w-3.5 rounded-sm border shrink-0"
              style={{ backgroundColor: prize.sliceColor ?? placeholderInk(i, slices.length) }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 break-words">{prize.nameEn}</span>
            <span className="tabular-nums font-semibold shrink-0">
              {formatBp(chanceBpOf(prize, verdict))}
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-3 text-xs text-muted-foreground">
        Every wedge is the same width on the television — the odds decide which slice the box
        lands on, not how big it looks. The percentage beside each prize is its real chance.
      </p>
      {slices.some((p) => p.sliceColor === null) && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Slices with no colour of their own take the layout’s palette. This preview draws those in
          a placeholder ramp: the layout’s own colours live in its design document, which this
          page does not read yet.
        </p>
      )}
    </div>
  );
}

/** What goes on the wedge: the short label, or the English name where there is none. */
function labelOf(prize: BoothPrizeDraft): string {
  return prize.wheelLabel?.trim() || prize.nameEn;
}

/**
 * A neutral ramp for slices that have no colour of their own.
 *
 * Deliberately not a guess at the park's palette: it steps hue evenly so
 * neighbouring wedges stay distinguishable at any slice count, and it is
 * labelled as a placeholder wherever it is used. A convincing imitation of the
 * real design would be worse than an obvious stand-in — somebody would sign it
 * off as the booth's colours.
 */
function placeholderInk(index: number, total: number): string {
  const hue = Math.round((360 / Math.max(total, 1)) * index);
  return `hsl(${hue} 45% 62%)`;
}
