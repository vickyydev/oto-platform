import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Four states, one vocabulary, used by every page here.
 *
 * Each tone has a SHAPE as well as an ink — a disc, a triangle, a barred
 * octagon, a hollow ring. Colour alone fails the two readers this console is
 * built for: someone colour-blind, and someone looking at a laptop screen
 * angled away from them at the counter while something is on fire. The shape
 * survives both.
 */
export type Tone = 'ok' | 'warn' | 'down' | 'idle';

const INK: Record<Tone, string> = {
  ok: 'var(--status-ok)',
  warn: 'var(--status-warn)',
  down: 'var(--status-down)',
  idle: 'var(--status-idle)',
};

const LABEL: Record<Tone, string> = {
  ok: 'Healthy',
  warn: 'Needs attention',
  down: 'Failing',
  idle: 'Not reporting',
};

export function StatusMark({ tone, className }: { tone: Tone; className?: string }) {
  const ink = `hsl(${INK[tone]})`;
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('w-3.5 h-3.5 shrink-0', className)}
      role="img"
      aria-label={LABEL[tone]}
    >
      {tone === 'ok' && <circle cx="8" cy="8" r="5.5" fill={ink} />}
      {tone === 'warn' && <path d="M8 1.5 15 14H1z" fill={ink} />}
      {tone === 'down' && (
        <>
          <path d="M5.2 1h5.6L15 5.2v5.6L10.8 15H5.2L1 10.8V5.2z" fill={ink} />
          <path d="M4.6 7.1h6.8v1.8H4.6z" fill="hsl(var(--card))" />
        </>
      )}
      {tone === 'idle' && <circle cx="8" cy="8" r="5" fill="none" stroke={ink} strokeWidth="2" />}
    </svg>
  );
}

/** A state with its name beside it. The default shape for anything in a list. */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap',
        className,
      )}
      style={{
        color: `hsl(${INK[tone]})`,
        borderColor: `hsl(${INK[tone]} / 0.35)`,
        backgroundColor: `hsl(${INK[tone]} / 0.10)`,
      }}
    >
      <StatusMark tone={tone} className="w-2.5 h-2.5" />
      {children}
    </span>
  );
}

/** A plain label chip for facts that carry no state — a kind, a category, an app. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground whitespace-nowrap',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Health words the API speaks, mapped onto the four tones. */
export function toneForHealth(status: string | null | undefined): Tone {
  switch (status) {
    case 'ok':
    case 'ready':
    case 'healthy':
    case 'up':
      return 'ok';
    case 'warn':
    case 'warning':
    case 'degraded':
    case 'stale':
      return 'warn';
    case 'down':
    case 'failing':
    case 'error':
    case 'not_ready':
      return 'down';
    default:
      return 'idle';
  }
}

/**
 * Run outcomes, likewise. Anything unrecognised is "not reporting", not "fine".
 *
 * A refusal — denied, refused, rejected — takes the middle tone rather than the
 * red one: the platform did exactly what it should. It is never nothing either,
 * which is why it does not take the grey one that means "we have no idea".
 */
export function toneForOutcome(outcome: string | null | undefined): Tone {
  switch (outcome) {
    case 'success':
    case 'ok':
    case 'delivered':
      return 'ok';
    case 'skipped':
    case 'retrying':
    case 'timeout':
    case 'degraded':
    case 'denied':
    case 'refused':
    case 'rejected':
      return 'warn';
    case 'failure':
    case 'failed':
    case 'error':
      return 'down';
    default:
      return 'idle';
  }
}

/** Alert severities. An acknowledged alert is still open — it just has an owner. */
export function toneForSeverity(severity: string | null | undefined): Tone {
  switch (severity) {
    case 'critical':
      return 'down';
    case 'warning':
      return 'warn';
    case 'info':
      return 'idle';
    default:
      return 'warn';
  }
}
