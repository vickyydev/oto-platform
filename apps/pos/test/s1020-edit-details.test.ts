import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { addedGatePlace, emptyGatePlace, gateTicketLines, savedChildrenOffForm } from '@/lib/editDetails';
import { agreementsOnlyForm } from '@/lib/returningFamily';
import type { CartLine, SavedChild } from '@/types';

/**
 * SCRUM-1020 — "EDIT DETAILS" AT RECEPTION (the owner's answer of 19
 * November: reception adds a child or changes details in the middle of a
 * check-in without clearing the ticks already made; a friend's child added to
 * the same order stays saved on this family's record, as today).
 *
 * Until now the only way to add a child was Back to the cart, one more kid on
 * the ticket and Pay again, which built the drop-off form afresh: every
 * place, the family's agreement ticks, their consent and the photos cleared
 * (`handleSupervisionBack`, then `openSupervisionGate`). These tests pin, in
 * order:
 *
 * 1. what "Edit details" may add a child to, and which children it offers;
 * 2. the place it adds is the one the form makes for each kid, or the saved
 *    child's own details (never a photo);
 * 3. the till adds it where the form stands: one more kid on the ticket, one
 *    more place, and nothing it clears; the button is there with a display
 *    paired or not, and the dialog never ticks for the family.
 */

const ticket = { id: 'zz-play', name: 'ZZ TEST Play 2h' } as CartLine['ticketType'];
const line = (extra: Partial<CartLine> = {}): CartLine => ({ id: 'zz-line-1', ticketType: ticket, kids: 2, adults: 0,
  socks: 0, addOns: [], lineTotal: 0, ...extra } as CartLine);
const place = (extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({ ...emptyGatePlace(line()), ...extra });
const SAVED_AT = '2026-11-01T00:00:00.000Z';
const MAI: SavedChild = { id: 'zz-child-mai', childName: 'ZZ TEST Mai', childAge: 6, allergiesMedical: 'ZZ TEST peanuts',
  savedAt: SAVED_AT, updatedAt: SAVED_AT };
const TOM: SavedChild = { id: 'zz-child-tom', childName: 'ZZ TEST Tom', childAge: 4, savedAt: SAVED_AT, updatedAt: SAVED_AT };

describe('SCRUM-1020 (1): what Edit details adds a child to', () => {
  it('the ticket lines the form\'s places came from; never a gift line, a drop-off line or a line with an adult', () => {
    const places = [place({ sourceLineId: 'zz-line-1' }), place({ sourceLineId: 'zz-line-2' })];
    const lines = [line(), line({ id: 'zz-line-2', kids: 1 }), line({ id: 'zz-gift', voucherGift: true } as Partial<CartLine>),
      line({ id: 'zz-drop', dropOff: {} as CartLine['dropOff'] }), line({ id: 'zz-adult', adults: 1 }), line({ id: 'zz-other' })];
    expect(gateTicketLines(lines, places).map((l) => l.id)).toEqual(['zz-line-1', 'zz-line-2']);
    // A Golden Ticket's gift: its child alone, nothing to add to.
    expect(gateTicketLines([line({ id: 'zz-gift', voucherGift: true } as Partial<CartLine>)], [place({ sourceLineId: 'zz-gift' })])).toEqual([]);
  });

  it('offers this family\'s saved children not on the form yet', () => {
    expect(savedChildrenOffForm([MAI, TOM], [place({ savedChildId: MAI.id }), place()])).toEqual([TOM]);
    expect(savedChildrenOffForm([], [place()])).toEqual([]);
  });
});

describe('SCRUM-1020 (2): the place it adds', () => {
  it('an empty place is the one the form makes for each kid: the full safety flow, food not authorised, no photo', () => {
    const empty = addedGatePlace(line(), undefined, 'zz-place');
    expect(empty).toEqual({ id: 'zz-place', sourceLineId: 'zz-line-1', ticketType: ticket, name: '', age: '', waived: false,
      optIn: true, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, foodProvision: { mode: 'none', paidTHB: 0 },
      childPhotoUrl: undefined });
    expect(emptyGatePlace(line(), { age: '7' }).age).toBe('7');
  });

  it('a saved child comes with their saved details and is linked to their record, never with a photo', () => {
    const saved = addedGatePlace(line(), MAI, 'zz-place');
    expect(saved).toMatchObject({ id: 'zz-place', sourceLineId: 'zz-line-1', savedChildId: MAI.id, name: 'ZZ TEST Mai', age: '6',
      allergiesMedical: 'ZZ TEST peanuts', optIn: true });
    expect(saved.childPhotoUrl).toBeUndefined();
    expect(saved.careSource).toBeUndefined();
  });

  it('a new child on a returning family\'s form brings the three steps back for them; a saved one keeps the agreements alone', () => {
    const form = [place({ savedChildId: MAI.id })];
    expect(agreementsOnlyForm({ guardianFromProfile: true, slots: [...form, addedGatePlace(line(), TOM)] })).toBe(true);
    expect(agreementsOnlyForm({ guardianFromProfile: true, slots: [...form, addedGatePlace(line())] })).toBe(false);
  });
});

describe('SCRUM-1020 (3): the till adds it where the form stands', () => {
  const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
  const add = till.slice(till.indexOf('const handleAddGateChild = '), till.indexOf('const handleSupervisionBack = '));

  it('one more kid on the ticket line, priced as the grid prices it, and one more place on the open form', () => {
    expect(add).toContain('const line = gateTicketLines(lines, superSlots).find((l) => l.id === lineId);');
    expect(add).toContain('handleUpdateLine(line.id, { kids: line.kids + 1 });');
    // SCRUM-1052 — the place joins as every place does: registered, at no fee for a child who needs no supervision.
    expect(add).toContain('setSuperSlots((prev) => [...prev, addedGatePlace(line, saved)]);');
  });

  it('clears nothing: the ticks, the consent, the confirmed children, the photos and the step stay', () => {
    for (const cleared of ['setSuperConsentAck', 'setSuperAcknowledgedConfirmationIds', 'setConfirmedSavedIds', 'setStep(',
      'setLastPhotos({})', 'gateChildIdsRef.current = ', 'openSupervisionGate', 'setSuperParentName', 'setReviewVisitorId']) {
      expect(add, cleared).not.toContain(cleared);
    }
  });

  it('only this family\'s saved children, each once; never while the form is being written or on a resumed sale', () => {
    expect(add).toContain('if (gateRunningRef.current || orderFrozen()) return;');
    expect(add).toContain('if (saved && (!member?.savedChildren?.some((c) => c.id === saved.id)');
    expect(add).toContain('|| superSlots.some((s) => s.savedChildId === saved.id))) return;');
    // A saved child added: staff compare the last visit's photo, as for the form's own.
    expect(add).toContain('if (saved) readLastPhotos([saved.id], lastPhotos);');
  });

  it('the form opens with the same place, and Back still returns to the cart as before', () => {
    const open = till.slice(till.indexOf('const openSupervisionGate = '), till.indexOf('const handleUpdateSlot = '));
    expect(open).toContain("slots.push(emptyGatePlace(l, { age: only ? String(only.age) : '' }));");
    const back = till.slice(till.indexOf('const handleSupervisionBack = '), till.indexOf('const handleReviewUpdateSlot'));
    expect(back).toContain('setStep(3);');
  });

  it('"Edit details" is on the form with a display paired or not, beside the private details', () => {
    expect(till.match(/data-testid="edit-details-open"/g)).toHaveLength(2);
    expect(till).toContain('{linkedDisplay.connected.length === 0 && <div className="mb-3 flex justify-end">');
    expect(till).toMatch(/onClick=\{\(\) => setEditDetailsOpen\(true\)\}>Edit details<\/Button>\s*<Button size="sm" className="min-h-11" variant="outline" disabled=\{gateSaving\} onClick=\{\(\) => setConsentPrivateOpen\(true\)\}>Private child details<\/Button>/);
  });

  it('the dialog adds a saved child of this family or a new child, and shows the family\'s ticks without changing them', () => {
    const dialog = till.slice(till.indexOf('<Dialog open={step === 7 && editDetailsOpen}'), till.indexOf('{operator && (\n        <ManualDiscountModal'));
    expect(dialog).toContain('<DialogTitle>Edit details</DialogTitle>');
    expect(dialog).toContain('onClick={() => handleAddGateChild(line.id, child)}>+ {child.childName}</Button>');
    expect(dialog).toContain('onClick={() => handleAddGateChild(line.id)}>+ A new child</Button>');
    expect(dialog).toContain('<ConsentCapture staffScreen ticksReadOnly slots={superSlots}');
    expect(till).toContain('const editSavedOffForm = savedChildrenOffForm(member?.savedChildren ?? [], superSlots);');
    // Closed with the form: a new gate or a new sale starts without it.
    expect(till.match(/setEditDetailsOpen\(false\);/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('a friend\'s child added this way is written to this family\'s record with the others, as today', () => {
    const resolve = till.slice(till.indexOf('const resolveSupervisionGate = async'), till.indexOf('const gateRunningRef'));
    expect(resolve).toContain('const written = await saveGateChildren({');
    expect(resolve).toContain('guardian,');
  });
});
