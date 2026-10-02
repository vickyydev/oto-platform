import type { CashMovementView } from '@oto/shared';

/**
 * S2-15a round 1 — UI ADDITION. The day's paid-outs and safe drops, shown
 * inside the Cash count card only when there are any, because "Expected cash ·
 * from POS" already has them taken off and the count would not otherwise
 * explain itself. Same muted rows as the card's own captions.
 */
export function CashMovementList({ movements }: { movements: readonly CashMovementView[] }) {
  if (movements.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-1.5" aria-label="Paid-outs and safe drops">
      {movements.map((m) => {
        const second = m.kind === 'paid_out' ? m.approver : m.witness;
        const secondWord = m.kind === 'paid_out' ? 'approved by' : 'witnessed by';
        return (
          <div key={m.id} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <span className="font-medium text-foreground">{m.kind === 'paid_out' ? 'Paid out' : 'Safe drop'}</span>
              {' · '}
              {m.reason}
              <span className="opacity-80">
                {' '}
                — {m.actor.name ?? 'Unknown'}, {secondWord} {second?.name ?? 'Unknown'}
              </span>
            </span>
            <span className="shrink-0 tabular-nums font-semibold text-foreground">−฿{(m.amountSatang / 100).toLocaleString()}</span>
          </div>
        );
      })}
      <div>taken off expected cash</div>
    </div>
  );
}
