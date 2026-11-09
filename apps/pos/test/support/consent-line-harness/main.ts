import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConsentPrompt } from '@oto/shared';
import { ConsentCapture } from '../../../src/components/till/ConsentCapture';
import { PublicConsentCapture } from '../../../src/components/till/PublicConsentCapture';
import type { SupervisedSlot } from '../../../src/components/till/SupervisionGate';
import { LanguageProvider } from '../../../src/i18n/LanguageContext';
import type { SupervisionPolicy } from '../../../src/types';
import '../../../src/index.css';

/**
 * SCRUM-767 — the consent screens with a "Please confirm" list, drawn from the
 * till's own components in a real browser. Only the fixture and the state the
 * page keeps are supplied here; every line, box and handler is the till's.
 *
 *  ?screen=till            the customer's half of the till (Till.tsx, step 7)
 *  ?screen=staff           the staff's private copy when staff may tick (no display paired)
 *  ?screen=staff-readonly  the staff's private copy when the family ticks on their screen
 *  ?screen=display         the paired customer screen (Display.tsx), agreements step
 */
const screen = new URLSearchParams(location.search).get('screen') ?? 'till';

/** The seeded supervision policy (catalogStore's seedSupervisionPolicy). */
const policy: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [
    { id: 'confirm-15min', text: 'I will remain within 15 minutes of the venue', required: true, order: 0 },
    { id: 'confirm-no-refund', text: 'I understand early pickup does not qualify for refund', required: true, order: 1 },
    { id: 'confirm-evac', text: 'I acknowledge the emergency evacuation point', required: true, order: 2 },
  ],
};

const slots: SupervisedSlot[] = [{
  id: 'zz-test-slot', sourceLineId: 'zz-test-line', ticketType: {} as SupervisedSlot['ticketType'],
  name: 'ZZ TEST child', age: '6', waived: false, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false,
}];

/** Every call a line's handlers make, in order, for the test to read. */
type Call = { handler: 'consentAck'; value: boolean } | { handler: 'toggleConfirmation'; id: string };

function TillConsent({ staffScreen, ticksReadOnly }: { staffScreen: boolean; ticksReadOnly: boolean }) {
  const [consentAck, setConsentAck] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [parentName, setParentName] = useState('ZZ TEST guardian');
  const [phone, setPhone] = useState('');
  const [calls, setCalls] = useState<Call[]>([]);
  return h('div', { className: 'flex h-full min-h-0', id: 'ready' },
    h('output', { id: 'calls', className: 'sr-only' }, JSON.stringify(calls)),
    // The staff half of the split view, so the consent screen has the width it has on the iPad.
    h('div', { className: 'w-1/2 h-full border-r border-foreground/10' }),
    h('div', { className: 'w-1/2 h-full min-w-0 dark' },
      h(ConsentCapture, {
        staffScreen, ticksReadOnly, slots, parentName, consentAck, policy,
        parentPhone: phone, onParentPhoneChange: setPhone,
        onParentNameChange: setParentName,
        onConsentAckChange: (value: boolean) => {
          setCalls((previous) => [...previous, { handler: 'consentAck', value }]);
          setConsentAck(value);
        },
        onUpdateChild: () => undefined,
        acknowledgedConfirmationIds: acknowledged,
        // Till.tsx's handleToggleConfirmation, as written there.
        onToggleConfirmation: (id: string) => {
          setCalls((previous) => [...previous, { handler: 'toggleConfirmation', id }]);
          setAcknowledged((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
        },
      })));
}

const prompt: ConsentPrompt = {
  kind: 'consent', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
  slots: [{ id: 'zz-test-slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off', dateOfBirth: null,
    allergiesMedical: '', foodRestrictions: '' }],
  guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: false,
  confirmations: policy.confirmations.map((item) => ({ id: item.id, text: item.text, required: item.required, acknowledged: false })),
  guardianPhone: '+66812345678', fees: { nannyHourlyTHB: 300, dropOffFeeTHB: 200 },
  staffReady: false, canContinue: false, completed: false,
};

function DisplayConsent() {
  return h('div', { className: 'h-full dark', id: 'ready' }, h(PublicConsentCapture, { prompt, busy: false, onAction: () => undefined }));
}

createRoot(document.getElementById('root')!).render(h(LanguageProvider, null,
  screen === 'display'
    ? h(DisplayConsent)
    : h(TillConsent, { staffScreen: screen !== 'till', ticksReadOnly: screen === 'staff-readonly' })));
