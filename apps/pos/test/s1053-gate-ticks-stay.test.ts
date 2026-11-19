import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { addedGatePlace, emptyGatePlace, gateTicketLines } from '@/lib/editDetails';
import { prefillGate, profileGuardianName } from '@/lib/returningFamily';
import { resolveGroupRequirements } from '@/lib/supervision';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine, SavedChild, SupervisionPolicy } from '@/types';

/**
 * SCRUM-1053 — THE TICKS STAY, DRIVEN THROUGH THE TILL'S OWN HANDLERS.
 *
 * The owner's answers of 19 November: the children staff tick as visiting
 * become the form's children (SCRUM-1018), and "Edit details" adds a child or
 * changes details in the middle of a check-in without clearing the ticks
 * already made (SCRUM-1020). Until now this was held by source pins alone.
 *
 * Here the till's own `openSupervisionGate`, `handleAddGateChild` and
 * `handleUpdateSlot` are taken from `pages/Till.tsx` as written, compiled,
 * and run against a small model of the page's state: each `set…` call
 * updates it, as a render would, and each read sees the latest value. The
 * gate opens on the ticked children; the family ticks the agreements and
 * gives the photo; staff add a saved child, then a new child, then correct a
 * detail; every tick, the consent, the confirmed children and the photo stay.
 */

const policy: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'confirm-15min', text: 'ZZ TEST within 15 minutes', required: true, order: 0 }],
};
const saved = (id: string, childName: string, childAge: number): SavedChild => ({ id, childName, childAge }) as SavedChild;
const MAI = saved('zz-child-mai', 'ZZ TEST Mai', 6);
const TOM = saved('zz-child-tom', 'ZZ TEST Tom', 10);
const BEN = saved('zz-child-ben', 'ZZ TEST Ben', 3);

/** The handlers as `pages/Till.tsx` writes them, compiled once. */
function tillHandlers(): string {
  const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
  const cut = (from: string, to: string) => {
    const start = till.indexOf(from);
    const end = till.indexOf(to, start);
    expect(start, from).toBeGreaterThan(-1);
    expect(end, to).toBeGreaterThan(start);
    return till.slice(start, end);
  };
  const source = [
    cut('const openSupervisionGate = ', 'const readLastPhotos = '),
    cut('const handleUpdateSlot = ', 'const handleToggleWaiver = '),
    cut('const handleAddGateChild = ', 'const handleSupervisionBack = '),
  ].join('\n');
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

type State = Record<string, unknown>;

/** The page's state as the handlers see it: `set…` updates it, `…Ref` is a ref, anything else is given. */
function page(given: Record<string, unknown>, state: State) {
  const refs: Record<string, { current: unknown }> = {};
  const calls: { name: string; args: unknown[] }[] = [];
  const scope = new Proxy(given, {
    has: (target, key) => typeof key === 'string'
      && (key in target || key in state || /^set[A-Z]/.test(key) || /Ref$/.test(key)),
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (/^set[A-Z]/.test(key)) {
        const field = key[3]!.toLowerCase() + key.slice(4);
        return (value: unknown) => {
          calls.push({ name: key, args: [value] });
          state[field] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(state[field]) : value;
        };
      }
      if (/Ref$/.test(key)) return (refs[key] ??= { current: key === 'gateRunningRef' ? false : null });
      return state[key];
    },
  });
  const run = new Function('scope', `with (scope) { ${tillHandlers()}; return { openSupervisionGate, handleUpdateSlot, handleAddGateChild }; }`);
  return { ...(run(scope) as {
    openSupervisionGate: () => void;
    handleUpdateSlot: (id: string, patch: Partial<SupervisedSlot>) => void;
    handleAddGateChild: (lineId: string, child?: SavedChild) => void;
  }), calls };
}

describe('SCRUM-1053 — the ticks stay through the gate and "Edit details"', () => {
  it('opens on the ticked children and keeps every tick while children are added and details changed', () => {
    const ticket = getTicketTypes()[0]!;
    const line = { id: 'zz-line-1053', ticketType: ticket, tier: 'tourist', kids: 2, adults: 0, socks: 0, addOns: [], lineTotal: 0 } as CartLine;
    const member = { id: 'zz-member-1053', nickname: 'ZZ TEST Ploy', phone: '+66898020001', savedChildren: [MAI, TOM, BEN] };
    const state: State = {
      lines: [line], superSlots: [], confirmedSavedIds: [], superAcknowledgedConfirmationIds: [], superConsentAck: false,
      step: 3, lastPhotos: {}, member, visitingChildIds: [MAI.id, TOM.id],
    };
    const lineUpdates: unknown[] = [];
    const till = page({
      // The till's own pieces, unchanged.
      emptyGatePlace, prefillGate, profileGuardianName, gateTicketLines, addedGatePlace, resolveGroupRequirements, slotAge,
      getSupervisionPolicy: () => policy,
      // What the page holds around the form.
      createdMemberId: null, customerPhone: '', customerContactChannel: 'whatsapp',
      toast: () => undefined, gateOnline: { reset: () => undefined }, refreshNannyRoster: () => undefined,
      reviewDate: () => '2026-11-19', readLastPhotos: () => undefined, orderFrozen: () => false,
      handleUpdateLine: (id: string, patch: { kids: number }) => {
        lineUpdates.push([id, patch]);
        state.lines = (state.lines as CartLine[]).map((l) => (l.id === id ? { ...l, ...patch } : l));
      },
    }, state);

    // The gate opens on Mai and Tom, the children ticked at the check, already confirmed: no review.
    till.openSupervisionGate();
    const opened = till.calls.length;
    const slots = () => state.superSlots as SupervisedSlot[];
    expect(slots().map((s) => s.savedChildId)).toEqual([MAI.id, TOM.id]);
    expect(state.confirmedSavedIds).toEqual(slots().map((s) => s.id));
    expect(state.step).toBe(7);
    expect(state.superParentName).toBe('ZZ TEST Ploy');

    // The family ticks the agreements and gives the photo with Mai.
    state.superConsentAck = true;
    state.superAcknowledgedConfirmationIds = ['confirm-15min'];
    const mai = slots()[0]!.id;
    state.superSlots = slots().map((s) => (s.id === mai ? { ...s, childPhotoUrl: 'data:image/png;base64,AAAA' } : s));
    const ticked = { confirmed: state.confirmedSavedIds, acks: state.superAcknowledgedConfirmationIds, consent: state.superConsentAck };

    // Edit details: Ben (saved), then a new child; then a detail corrected.
    till.handleAddGateChild(line.id, BEN);
    till.handleAddGateChild(line.id);
    const tom = slots()[1]!.id;
    till.handleUpdateSlot(tom, { allergiesMedical: 'ZZ TEST pollen' });

    expect(slots().map((s) => s.savedChildId ?? 'new')).toEqual([MAI.id, TOM.id, BEN.id, 'new']);
    expect(lineUpdates).toEqual([[line.id, { kids: 3 }], [line.id, { kids: 4 }]]);
    expect(slots().find((s) => s.id === tom)!.allergiesMedical).toBe('ZZ TEST pollen');
    // Every tick, the consent, the confirmed children and the photo stay; the form stays open.
    expect(state.confirmedSavedIds).toBe(ticked.confirmed);
    expect(state.superAcknowledgedConfirmationIds).toBe(ticked.acks);
    expect(state.superConsentAck).toBe(ticked.consent);
    expect(slots()[0]!.childPhotoUrl).toBe('data:image/png;base64,AAAA');
    expect(state.step).toBe(7);
    // SCRUM-1052 — every place joins registered: at no fee for a child who needs no supervision.
    expect(slots().every((s) => s.optIn === true)).toBe(true);
    // Nothing that clears the form ran after it opened.
    const afterOpen = till.calls.slice(opened).map((c) => c.name);
    expect(afterOpen).toContain('setSuperSlots');
    for (const clearing of ['setSuperConsentAck', 'setSuperAcknowledgedConfirmationIds', 'setConfirmedSavedIds', 'setStep', 'setLastPhotos']) {
      expect(afterOpen, clearing).not.toContain(clearing);
    }
  });

  it('a saved child already on the form is not added twice, and only this family’s', () => {
    const ticket = getTicketTypes()[0]!;
    const line = { id: 'zz-line-1053b', ticketType: ticket, tier: 'tourist', kids: 1, adults: 0, socks: 0, addOns: [], lineTotal: 0 } as CartLine;
    const member = { id: 'zz-member-1053b', nickname: 'ZZ TEST Ploy', phone: '+66898020001', savedChildren: [MAI] };
    const state: State = { lines: [line], superSlots: [], confirmedSavedIds: [], step: 3, lastPhotos: {}, member, visitingChildIds: [MAI.id] };
    const till = page({
      emptyGatePlace, prefillGate, profileGuardianName, gateTicketLines, addedGatePlace, resolveGroupRequirements, slotAge,
      getSupervisionPolicy: () => policy, createdMemberId: null, customerPhone: '', customerContactChannel: 'whatsapp',
      toast: () => undefined, gateOnline: { reset: () => undefined }, refreshNannyRoster: () => undefined,
      reviewDate: () => '2026-11-19', readLastPhotos: () => undefined, orderFrozen: () => false,
      handleUpdateLine: () => { throw new Error('the ticket line must not change'); },
    }, state);
    till.openSupervisionGate();
    till.handleAddGateChild(line.id, MAI);
    till.handleAddGateChild(line.id, TOM);
    expect((state.superSlots as SupervisedSlot[]).map((s) => s.savedChildId)).toEqual([MAI.id]);
  });
});
