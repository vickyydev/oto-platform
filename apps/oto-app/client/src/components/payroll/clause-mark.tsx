/**
 * SCRUM-1075 (the owner's approval message, 26 November 2026): the orange
 * exclamation mark beside every person whose bonus is read from their
 * contract clause, wherever bonuses are seen, so the approver or the
 * accountant sees who it is and how much was calculated.
 */
export function ClauseMark({ title }: { title: string }) {
  return <span title={title} aria-label={title} role="img" data-testid="clause-mark"
    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white">!</span>;
}
