/**
 * S2-20 E4 — drawn beside the charge press while a party charge waits for its
 * answer: the order is held exactly as it was sent, and the press sends that
 * order again. In the party screens' own note style (PartyDetail's staff note).
 */
export function PartyChargeHeldNote() {
  return (
    <div className="rounded-lg bg-amber-500/10 text-amber-300 p-3 text-xs">
      <span className="font-semibold">Not confirmed: </span>
      this order is held as it was sent. Press charge again to confirm it — it is never charged twice.
    </div>
  );
}
