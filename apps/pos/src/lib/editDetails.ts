import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { slotPatchFromSavedChild } from '@/lib/savedChildren';
import type { CartLine, SavedChild } from '@/types';

/**
 * SCRUM-1020 — "EDIT DETAILS" AT RECEPTION, IN THE MIDDLE OF A CHECK-IN.
 *
 * The owner's answer of 19 November: reception adds a child or changes
 * details in the middle of a check-in without clearing the ticks already
 * made. Until now a child was added by going Back to the cart, raising the
 * kids on the ticket and pressing Pay again, which built the drop-off form
 * afresh (`handleSupervisionBack`, then `openSupervisionGate`): every place,
 * the family's agreement ticks, their consent and the photos were cleared.
 *
 * "Edit details" adds the child where the form stands: one more place on the
 * open form and one more kid on the ticket line it came from, priced as the
 * ticket grid prices it. Nothing else on the form moves. The family's ticks
 * stay; their Done is asked again, because the form they finished no longer
 * holds every child (it is a different form). A friend's child added this way
 * is saved on this family's record with the others, as today.
 *
 * The child added is one of the family's saved children not on the form yet
 * (only the family identified at this till), or a new child, typed by the
 * family on the display or by staff.
 */

/**
 * The ticket lines a child may be added to: the lines the form's places came
 * from, children playing alone. A Golden Ticket's gift line is the gift's
 * child alone, and a line with an adult on it is not on this form.
 */
export function gateTicketLines<Line extends Pick<CartLine, 'id' | 'dropOff' | 'voucherGift' | 'adults' | 'kids'>>(
  lines: readonly Line[],
  slots: readonly Pick<SupervisedSlot, 'sourceLineId'>[],
): Line[] {
  return lines.filter((line) => !line.dropOff && !line.voucherGift && line.adults === 0 && line.kids > 0
    && slots.some((slot) => slot.sourceLineId === line.id));
}

/** The family's saved children who are not on the form yet. */
export function savedChildrenOffForm(
  saved: readonly SavedChild[],
  slots: readonly Pick<SupervisedSlot, 'savedChildId'>[],
): SavedChild[] {
  const onForm = new Set(slots.flatMap((slot) => (slot.savedChildId ? [slot.savedChildId] : [])));
  return saved.filter((child) => !onForm.has(child.id));
}

/**
 * An empty place on the drop-off form for one kid of a ticket line: the
 * place `openSupervisionGate` makes for each kid when the form opens.
 */
export function emptyGatePlace(
  line: Pick<CartLine, 'id' | 'ticketType'>,
  options: { id?: string; age?: string } = {},
): SupervisedSlot {
  return {
    id: options.id ?? `slot-${Math.random().toString(36).substring(2, 9)}`,
    sourceLineId: line.id,
    ticketType: line.ticketType,
    name: '',
    age: options.age ?? '',
    waived: false,
    // Unaccompanied kids always run the full drop-off safety flow. For a
    // no-fee ('none') child this auto-enrolls them at ฿0 (no opt-in
    // button) so the "Tell us about your child" consent form appears
    // automatically; nanny/drop_off ignore this, waived-down kids stay
    // plain (resolveSupervisionOutcome keys opt-in off the BASE 'none').
    optIn: true,
    allergiesMedical: '',
    foodRestrictions: '',
    // Default: food not authorized until the parent explicitly chooses a
    // prepaid mode. The ConsentCapture picker enforces this on the customer
    // screen; mayOrderFood is derived from foodProvision.mode at registration.
    mayOrderFood: false,
    foodProvision: { mode: 'none', paidTHB: 0 },
    childPhotoUrl: undefined,
  };
}

/** The place "Edit details" adds: empty for a new child, or filled from a saved child of this family. */
export function addedGatePlace(
  line: Pick<CartLine, 'id' | 'ticketType'>,
  saved?: SavedChild,
  id?: string,
): SupervisedSlot {
  const place = emptyGatePlace(line, { id });
  return saved ? { ...place, ...slotPatchFromSavedChild(saved) } : place;
}
