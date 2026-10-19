import type { ReactNode } from 'react';

/**
 * A write control while the write switch is off (plan §4.3): the control
 * Cut B enables, rendered now, disabled, with its reason on hover and to a
 * screen reader. The wrapper carries the tooltip because a disabled button
 * fires no pointer events in every browser. Nothing here does anything when
 * pressed — the wiring is I3b's — and `lib/view.ts` `writeMode` hides these
 * outright if the api turns writes on before that wiring lands.
 */
export function PendingControl({
  reason,
  label,
  className,
  children,
}: {
  reason: string;
  /** What the control would do, for a screen reader. */
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <span title={reason} className="inline-flex">
      <button
        type="button"
        disabled
        aria-label={`${label} — ${reason}`}
        className={`${className} cursor-not-allowed opacity-60`}
      >
        {children}
      </button>
    </span>
  );
}
