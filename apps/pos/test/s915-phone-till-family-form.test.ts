import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupervisionGate, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { consentMissing } from '@/lib/consentFinish';
import { renderHook } from './support/hooks';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupervisionPolicy } from '@/types';

/**
 * SCRUM-915 — THE PHONE TILL REACHES THE FAMILY'S FORM FOR A CHILD ON THEIR OWN.
 *
 * On the phone till a children-only sale with a child under 9 had no way
 * through: the gate's "Continue to payment" stayed grey until the consent and
 * the photo were given, and that Continue was the only way the phone opened
 * the family's form. The phone has no customer screen, so the same form the
 * counter's customer half shows now opens on the phone itself (handed to the
 * parent): the phone's camera for the photo, the number confirmation tick,
 * the "Still needed" line and Done, which registers the children through the
 * gate staff's Continue runs and moves the sale on. The gate's Continue opens
 * the form while it still needs anything.
 */

vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
beforeEach(() => { vi.stubGlobal('React', React); });

const policy: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'confirm-15min', text: 'ZZ TEST within 15 minutes', required: true, order: 0 }],
};
const slot = (extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id: 'zz-915-slot', sourceLineId: 'zz-915-line', ticketType: {} as SupervisedSlot['ticketType'],
  name: 'ZZ TEST Mai', age: '6', waived: false, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, optIn: true, ...extra,
});

type Node = React.ReactElement<Record<string, unknown>>;
const nodes = (tree: unknown): Node[] => Array.isArray(tree) ? tree.flatMap(nodes)
  : React.isValidElement<Record<string, unknown>>(tree) ? [tree, ...nodes(tree.props.children)] : [];
const text = (tree: unknown): string => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join('') : React.isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children) : '';

function gate(extra: Partial<Parameters<typeof SupervisionGate>[0]> = {}) {
  const pressed: number[] = [];
  const view = renderHook(() => SupervisionGate({ slots: [slot()], parentName: '', consentAck: false, policy,
    acknowledgedConfirmationIds: [], onUpdateSlot: () => undefined, onToggleWaiver: () => undefined, onBack: () => undefined,
    onContinue: () => { pressed.push(1); }, ...extra }));
  const all = () => nodes(view.result.current);
  const proceed = () => all().find((node) => typeof node.props.onClick === 'function' && text(node.props.children).includes('Continue to payment'))!;
  return { view, proceed, pressed, text: () => text(view.result.current) };
}

describe('the gate’s Continue on the phone till', () => {
  it('on the counter stays grey while the family’s form still needs something, as before', () => {
    const counter = gate();
    expect(counter.proceed().props.disabled).toBe(true);
    counter.view.unmount();
  });

  it('on the phone can be pressed while the form still needs something: it is how the form opens', () => {
    const phone = gate({ continueOpensForm: true, contactConfirmed: false, contactPhoneProblem: null });
    expect(phone.proceed().props.disabled).toBe(false);
    (phone.proceed().props.onClick as () => void)();
    expect(phone.pressed).toHaveLength(1);
    // What is still missing is still said, the number confirmation included.
    expect(phone.text()).toContain('needs a photo taken');
    expect(phone.text()).toContain('Parent must confirm that the number is the one for their messaging channel');
    phone.view.unmount();
  });

  it('is parked while the children are being registered', () => {
    const phone = gate({ continueOpensForm: true, busy: true });
    const saving = nodes(phone.view.result.current).find((node) => typeof node.props.onClick === 'function' && text(node.props.children) === 'Saving…');
    expect(saving!.props.disabled).toBe(true);
    phone.view.unmount();
  });
});

describe('what the phone’s form still needs is the counter’s own reading', () => {
  it('nothing left once the children, the name and consent, the confirmations, the number and the photo are given', () => {
    const base = {
      children: [{ name: 'ZZ TEST Mai', ageYears: 6 }], consentRequired: true, guardianName: 'ZZ TEST Ploy', consentAcknowledged: true,
      confirmations: [{ required: true, acknowledged: true }], contact: { confirmed: true, problem: null }, photosTaken: true,
    } as const;
    expect(consentMissing(base)).toEqual([]);
    expect(consentMissing({ ...base, photosTaken: false })).toEqual(['photo']);
    expect(consentMissing({ ...base, contact: { confirmed: false, problem: null } })).toEqual(['contact']);
    expect(consentMissing({ ...base, children: [{ name: '', ageYears: null }] })).toEqual(['children']);
  });
});

describe('the phone till’s wiring', () => {
  // As committed: a Windows checkout may hand the file over with CRLF line ends.
  const phone = readFileSync(path.resolve(import.meta.dirname, '../src/components/mobile/MobileTill.tsx'), 'utf8').replace(/\r\n/g, '\n');

  it('Continue opens the form on the phone while it still needs anything, and resolves the gate once nothing is missing', () => {
    const handler = phone.slice(phone.indexOf('const handleMobileSupervisionContinue = () => {'), phone.indexOf('const handleFamilyDone = () => {'));
    expect(handler).toContain("if (mobileFamilyMissing().length > 0) {\n      setHandoffMode('consent');");
    expect(handler).toContain('void resolveMobileSupervisionGate().finally(() => setGateSaving(false));');
    expect(phone).toContain('continueOpensForm\n');
  });

  it('the form on the phone is the counter’s customer half: the tick, the Still needed line and Done', () => {
    const form = phone.slice(phone.indexOf("case 'consent':"), phone.indexOf("case 'qr':"));
    expect(form).toContain('<ConsentCapture');
    expect(form).toContain('contactConfirmed={mobileContactConfirmed}');
    expect(form).toContain('onContactConfirmedChange={(confirmed) => setMobileContactConfirmation(confirmed');
    expect(form).toContain("by: 'family', phone: consentFormPhone(customerPhone), channel: customerContactChannel");
    expect(form).toContain('onDone={handleFamilyDone}');
    expect(form).toContain('doneReady={mobileFamilyMissing().length === 0 && !gateSaving}');
    expect(form).toContain('doneBusy={gateSaving}');
    expect(form).toContain('doneNotSaved={familyDoneNotSaved}');
    // No photo at reception on the phone: its own camera takes it.
    expect(form).not.toContain('photoAtReception');
  });

  it('the family’s Done registers the children through the same gate and hands the phone back on the next step', () => {
    const done = phone.slice(phone.indexOf('const handleFamilyDone = () => {'), phone.indexOf('const resolveMobileSupervisionGate'));
    expect(done).toContain('if (gateSaving || mobileFamilyMissing().length > 0) return;');
    expect(done).toContain('if (saved) setHandoffMode(null);');
    expect(done).toContain('else setFamilyDoneNotSaved(true);');
    const resolve = phone.slice(phone.indexOf('const resolveMobileSupervisionGate'), phone.indexOf('const handleDoneAdding'));
    expect(resolve).toContain('async (): Promise<boolean> =>');
    expect(resolve).toContain('return true;\n  };');
  });

  it('the registration carries the tick given on the phone, for the number and channel it was given for', () => {
    expect(phone).toContain('contactConfirmation: mobileContactConfirmation && contactConfirmationStands(mobileContactConfirmation, customerPhone, customerContactChannel)');
    // Every gate starts unconfirmed.
    const open = phone.slice(phone.indexOf('const openSupervisionGate = () => {'), phone.indexOf('const handleUpdateSlot'));
    expect(open).toContain('setMobileContactConfirmation(null);');
    expect(open).toContain('setFamilyDoneNotSaved(false);');
  });

  it('a paired display keeps what it showed: the form stays on the phone, as before', () => {
    expect(phone).toContain("{handoffMode !== null && (inlineDisplay || handoffMode === 'consent') && (() => {");
  });

  it('under the form, the overlay’s own button only hands the phone back and does not say Done', () => {
    const cfg = phone.slice(phone.indexOf('function getHandoffCfg('), phone.indexOf('// ─── MobileTill'));
    const consent = cfg.slice(cfg.indexOf('consent: {'), cfg.indexOf('qr: {'));
    expect(consent).toContain("handBackLabel: t('handToCustomer.returnPhone'),");
    // The other hand-over moments keep their wording.
    expect(cfg.match(/handBackLabel: t\('handToCustomer\.handBackDefault'\)/g)).toHaveLength(2);
    // The overlay's wording for handing the phone back, without the Done before it, in every language.
    for (const lang of ['en', 'zh', 'th', 'ru', 'fr'] as const) {
      const handBack = DICTIONARY['handToCustomer.returnPhone']![lang];
      expect(DICTIONARY['handToCustomer.handBackDefault']![lang].toLowerCase().endsWith(handBack.toLowerCase())).toBe(true);
      expect(handBack).not.toContain(DICTIONARY['common.done']![lang]);
    }
    expect(DICTIONARY['handToCustomer.returnPhone']!.en).toBe('Return phone to staff');
  });
});
