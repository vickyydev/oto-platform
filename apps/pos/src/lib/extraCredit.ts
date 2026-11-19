import type { CartLine } from '@/types';

/**
 * SCRUM-1048 — EXTRA FOOD CREDIT ON ANY CHILD TICKET, AS ITS OWN LINE ON THE
 * ORDER (the owner's answer of 19 November 2026).
 *
 * Until now extra prepaid food credit existed only for a dropped-off or nanny
 * child, chosen by the parent on the form. On an ordinary ticket staff now add
 * it on the till: which child on the ticket line, and how much, in the same
 * 50 baht steps the drop-off form offers. It is a line of its own: nobody on
 * it, the child's own ticket package, its total the amount. The platform
 * loads it on that child's band when the sale is paid (`creditFor` on the
 * wire, `grantSaleCredit` on the platform).
 *
 * The line follows its ticket: removing the ticket removes it, fewer children
 * on the ticket than its place removes it, a ticket that becomes a drop-off or
 * nanny child's removes it (their extra credit is on the form), and a new rate
 * restates it with the ticket (`followTickets`).
 */

/** The steps and ceiling the drop-off form's extra credit offers (`PublicConsentCapture`). */
export const EXTRA_CREDIT_STEP_THB = 50;
export const EXTRA_CREDIT_MAX_THB = 100_000;

/** Whether staff may add extra food credit for a child on this line: an ordinary ticket with a child on it. */
export function takesExtraCredit(line: CartLine): boolean {
  return line.kids > 0 && !line.promoItem && !line.dropOff && !line.extraCredit;
}

/** "Kid 1", "Kid 2": the child on a ticket line by place, as the order names them. */
export function kidLabel(kidOrdinal: number): string {
  return `Kid ${kidOrdinal + 1}`;
}

/** An amount the till accepts: whole steps of 50 baht, above nothing, up to the ceiling. */
export function extraCreditAmount(amountTHB: number): number {
  const stepped = Math.round(amountTHB / EXTRA_CREDIT_STEP_THB) * EXTRA_CREDIT_STEP_THB;
  return Math.max(0, Math.min(EXTRA_CREDIT_MAX_THB, stepped));
}

/** The extra credit lines that follow one ticket line, in the order's order. */
export function extraCreditsOf(lines: readonly CartLine[], ticketLineId: string): CartLine[] {
  return lines.filter((line) => line.extraCredit?.forLineId === ticketLineId);
}

/**
 * Add extra food credit for the child at `kidOrdinal` on the ticket line
 * `ticketLineId`: its own line, placed after that ticket and any credit
 * already under it. A child who has some already has it set to this amount
 * instead (one line per child); an amount of nothing takes it off. Returns
 * the lines unchanged when the ticket cannot take it.
 */
export function withExtraCredit(
  lines: readonly CartLine[],
  ticketLineId: string,
  kidOrdinal: number,
  amountTHB: number,
  newLineId: () => string,
): CartLine[] {
  const ticket = lines.find((line) => line.id === ticketLineId);
  if (!ticket || !takesExtraCredit(ticket) || kidOrdinal < 0 || kidOrdinal >= ticket.kids) return [...lines];
  const amount = extraCreditAmount(amountTHB);
  const existing = lines.find(
    (line) => line.extraCredit?.forLineId === ticketLineId && line.extraCredit.kidOrdinal === kidOrdinal,
  );
  if (existing) {
    if (amount <= 0) return lines.filter((line) => line.id !== existing.id);
    return lines.map((line) =>
      line.id === existing.id
        ? { ...line, lineTotal: amount, extraCredit: { forLineId: ticketLineId, kidOrdinal, amountTHB: amount } }
        : line,
    );
  }
  if (amount <= 0) return [...lines];
  const credit: CartLine = {
    id: newLineId(),
    ticketType: ticket.ticketType,
    tier: ticket.tier,
    kids: 0,
    adults: 0,
    socks: 0,
    addOns: [],
    lineTotal: amount,
    extraCredit: { forLineId: ticketLineId, kidOrdinal, amountTHB: amount },
  };
  const after = lines.reduce((at, line, index) => (line.id === ticketLineId || line.extraCredit?.forLineId === ticketLineId ? index : at), -1);
  return [...lines.slice(0, after + 1), credit, ...lines.slice(after + 1)];
}

/**
 * Keep every extra credit line with its ticket: a line whose ticket is gone,
 * has fewer children than its place, or no longer takes extra credit (it
 * became a drop-off or nanny child's) is removed; the rest take their
 * ticket's rate and package. Returns the same array when nothing changed, so
 * a caller can tell.
 */
export function followTickets(lines: CartLine[]): CartLine[] {
  if (!lines.some((line) => line.extraCredit)) return lines;
  const byId = new Map(lines.map((line) => [line.id, line]));
  let changed = false;
  const out: CartLine[] = [];
  for (const line of lines) {
    if (!line.extraCredit) {
      out.push(line);
      continue;
    }
    const ticket = byId.get(line.extraCredit.forLineId);
    if (!ticket || !takesExtraCredit(ticket) || line.extraCredit.kidOrdinal >= ticket.kids) {
      changed = true;
      continue;
    }
    if (ticket.tier !== line.tier || ticket.ticketType !== line.ticketType) {
      changed = true;
      out.push({ ...line, tier: ticket.tier, ticketType: ticket.ticketType });
      continue;
    }
    out.push(line);
  }
  return changed ? out : lines;
}
