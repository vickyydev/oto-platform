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
 * SCRUM-1059 — EXTRA CREDIT STAFF ADDED ON A TICKET THAT THEN GOES THROUGH
 * THE DROP-OFF GATE.
 *
 * "Add food credit" is offered on a ticket with children and no adult; on
 * Continue the gate turns those children into drop-off and nanny children,
 * whose extra credit is the family's to choose on the form. Until now the
 * staff's line was then removed with no word (`followTickets`: the ticket no
 * longer takes extra credit) and the form opened at nothing: the credit was
 * lost. On a ticket where a waived child stayed a plain ticket, the line
 * could even land on the other child, the places having closed up.
 *
 * One source for each child: the amount staff added opens the child's form as
 * the extra credit already chosen (`gateExtraCredit`, the field staff's own
 * "Prepaid credit" on the till sets), where the family keeps or changes it.
 * When the gate writes, the staff line of a child who went into care is
 * removed, the form's amount being the one charged and loaded; the line of a
 * child who stayed a plain ticket stays theirs, at their new place on the
 * ticket (`extraCreditAfterGate`).
 */
export function gateExtraCredit(
  lines: readonly CartLine[],
  ticketLineId: string,
  kidOrdinal: number,
): { foodProvision: { mode: 'prepaid_credit'; creditAmountTHB: number; paidTHB: number }; mayOrderFood: true } | null {
  const credit = lines.find((line) => line.extraCredit?.forLineId === ticketLineId && line.extraCredit.kidOrdinal === kidOrdinal);
  const amount = credit?.extraCredit?.amountTHB ?? 0;
  if (amount <= 0) return null;
  return { foodProvision: { mode: 'prepaid_credit', creditAmountTHB: amount, paidTHB: amount }, mayOrderFood: true };
}

/**
 * The staff extra credit lines once the gate has written: `inCare` lists, for
 * each ticket the gate took children from, whether the child at each place
 * went into care. A care child's line goes (their form carried it); a plain
 * child's line follows them to their place among the ticket's plain children.
 * Lines of other tickets, and places the gate did not draw, are left as they
 * were (`followTickets` keeps them with their ticket as always).
 */
export function extraCreditAfterGate(
  lines: readonly CartLine[],
  inCare: ReadonlyMap<string, readonly boolean[]>,
): CartLine[] {
  return lines.flatMap((line) => {
    const credit = line.extraCredit;
    const places = credit ? inCare.get(credit.forLineId) : undefined;
    if (!credit || !places || places[credit.kidOrdinal] === undefined) return [line];
    if (places[credit.kidOrdinal]) return [];
    const kidOrdinal = places.slice(0, credit.kidOrdinal).filter((cared) => !cared).length;
    return kidOrdinal === credit.kidOrdinal ? [line] : [{ ...line, extraCredit: { ...credit, kidOrdinal } }];
  });
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
