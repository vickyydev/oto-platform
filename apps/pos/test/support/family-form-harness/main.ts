import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConsentAction, ConsentFormStep, ConsentPrompt } from '@oto/shared';
import { ConsentCapture } from '../../../src/components/till/ConsentCapture';
import { PublicConsentCapture } from '../../../src/components/till/PublicConsentCapture';
import { FORM_RECONNECTING_LINE } from '../../../src/components/till/consentFormLayout';
import { HandToCustomer } from '../../../src/components/mobile/HandToCustomer';
import { SavedChildrenReview } from '../../../src/components/shared/SavedChildrenReview';
import { SupervisionGate, type SupervisedSlot } from '../../../src/components/till/SupervisionGate';
import Display from '../../../src/pages/Display';
import { installBox } from './station';
import { LanguageProvider, useLanguage } from '../../../src/i18n/LanguageContext';
import type { ContactChannel, SupervisionPolicy } from '../../../src/types';
import '../../../src/index.css';

/**
 * SCRUM-893 / 894 / 943 — the family's drop-off form, drawn by the till's own
 * components in a real browser, at the size of the screen it is on. Only the
 * fixture and a stand-in for the till (which takes each `fill` and answers
 * with its newer copy, as the till does) are supplied here.
 *
 *  ?screen=display   the paired display (Display.tsx's frame round the form)
 *  ?screen=half      the till's own customer half (Till.tsx, step 7, split view)
 *  ?screen=phone     the phone till's form, handed to the parent (MobileTill.tsx:
 *                    HandToCustomer round ConsentCapture with `phoneScroll`)
 *  &keyboard=screen  the counter's touch monitor: no keyboard (kioskFlags)
 *  &step=children|care|agreements   where the display's form opens
 *  &theme=light|dark  the display's look
 *  &camera=none|refused  a display with no camera, or one whose camera is refused
 *  &reconnecting=1   the display's reconnecting line over the form, as Display.tsx draws it
 *
 * SCRUM-963:
 *  ?screen=paired    the display page itself (pages/Display.tsx), paired to a
 *                    stand-in box (`station.ts`); &doc=identify for its first
 *                    screen, else the family's form opened on &step
 *  ?screen=review    the returning family's review (SavedChildrenReview, as the
 *                    paired display draws it): one child to confirm, one confirmed
 *  ?screen=gate      the phone till's supervision gate in its step's frame, under
 *                    the phone's bars (&desk=1: the counter till's step instead)
 *
 * `#till` holds what the till has: the display's last fill, or the half's state.
 */
const query = new URLSearchParams(location.search);
const screen = query.get('screen') ?? 'display';
const step = (query.get('step') ?? 'children') as ConsentFormStep;
const theme = query.get('theme') === 'light' ? 'light' : 'dark';
const camera = query.get('camera');
const reconnecting = query.get('reconnecting') === '1';

if (camera === 'none' || camera === 'refused') {
  const refused = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    enumerateDevices: async () => (camera === 'none' ? [{ kind: 'audioinput' }] : [{ kind: 'videoinput' }]),
    getUserMedia: async () => { throw refused; },
  } });
}

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

const firstPrompt: ConsentPrompt = {
  kind: 'consent', requestId: 'zz-form-1', visitorId: 'zz-form-visitor',
  slots: [{ id: 'zz-slot', name: '', ageYears: 6, requirement: 'drop_off', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '',
    ...(camera ? { photo: 'needed' as const } : {}) }],
  guardianName: '', guardianPhone: '+66898930001', contactChannel: 'whatsapp', contactConfirmed: false, familyStep: step,
  consentRequired: true, consentAcknowledged: false,
  confirmations: policy.confirmations.map((item) => ({ id: item.id, text: item.text, required: item.required, acknowledged: false })),
  fees: { nannyHourlyTHB: 300, dropOffFeeTHB: 225 },
  ...(camera ? { reportsCamera: true } : {}),
  staffReady: false, canContinue: false, completed: false,
};

/** The till's side: each fill taken in, and the newer copy published back. */
function DisplayForm() {
  const [prompt, setPrompt] = useState(firstPrompt);
  const [heard, setHeard] = useState<ConsentAction | null>(null);
  const take = (action: ConsentAction) => {
    setHeard(action);
    if (action.action !== 'fill') return;
    setPrompt((current) => ({
      ...current,
      requestId: `zz-form-${Number(current.requestId.split('-').at(-1)) + 1}`,
      slots: current.slots.map((slot) => {
        const filled = action.slots.find((item) => item.id === slot.id);
        return filled ? { ...slot, name: filled.name, ageYears: filled.ageYears, dateOfBirth: filled.dateOfBirth,
          allergiesMedical: filled.allergiesMedical, foodRestrictions: filled.foodRestrictions } : slot;
      }),
      guardianName: action.guardianName,
      ...(action.guardianPhone !== undefined ? { guardianPhone: action.guardianPhone } : {}),
      ...(action.contactChannel !== undefined ? { contactChannel: action.contactChannel } : {}),
      ...(action.contactConfirmed !== undefined ? { contactConfirmed: action.contactConfirmed } : {}),
      ...(action.step ? { familyStep: action.step } : {}),
      consentAcknowledged: action.consentAcknowledged,
      confirmations: current.confirmations.map((item) => ({ ...item, acknowledged: action.acknowledgedConfirmationIds.includes(item.id) })),
    }));
  };
  // Display.tsx's frame: the page, then the form filling what is left of it,
  // with the reconnecting line laid over it as Display.tsx lays it.
  return h('div', { className: `${theme} h-[100dvh] w-full min-w-0 overflow-hidden bg-background text-foreground flex flex-col`, id: 'ready' },
    h('output', { id: 'till', className: 'sr-only' }, JSON.stringify({ prompt, heard })),
    h('div', { className: 'relative flex-1 min-h-0' },
      reconnecting ? h(ReconnectingLine) : null,
      h(PublicConsentCapture, { prompt, busy: false, answerPending: false, onAction: take, sendPhoto: async () => 'zz-file' })));
}

function ReconnectingLine() {
  const { t } = useLanguage();
  return h('p', { role: 'status', 'data-testid': 'display-form-reconnecting', className: FORM_RECONNECTING_LINE }, t('display.reconnectingSendsItself'));
}

const halfSlot: SupervisedSlot = {
  id: 'zz-slot', sourceLineId: 'zz-line', ticketType: {} as SupervisedSlot['ticketType'],
  name: '', age: '6', waived: false, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, optIn: true,
};

/** The till's state behind its own form: the form writes it as the family types. */
function useTillForm() {
  const [slots, setSlots] = useState<SupervisedSlot[]>([halfSlot]);
  const [parentName, setParentName] = useState('');
  const [phone, setPhone] = useState('+66898930001');
  const [channel, setChannel] = useState<ContactChannel>('whatsapp');
  const [consentAck, setConsentAck] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [contactConfirmed, setContactConfirmed] = useState(false);
  const state = h('output', { id: 'till', className: 'sr-only' }, JSON.stringify({ slots, parentName, phone, channel }));
  const props = {
    slots, parentName, consentAck, policy, parentPhone: phone, parentContactMethod: channel,
    onParentPhoneChange: setPhone, onParentContactMethodChange: setChannel, onParentNameChange: setParentName,
    onConsentAckChange: setConsentAck,
    onUpdateChild: (id: string, patch: Partial<SupervisedSlot>) => setSlots((all) => all.map((slot) => slot.id === id ? { ...slot, ...patch } : slot)),
    acknowledgedConfirmationIds: acknowledged,
    onToggleConfirmation: (id: string) => setAcknowledged((all) => all.includes(id) ? all.filter((x) => x !== id) : [...all, id]),
    contactConfirmed, onContactConfirmedChange: setContactConfirmed,
    onDone: () => undefined, doneReady: false,
  };
  return { state, props };
}

/** The till's own customer half: the form writes the till's state as the family types. */
function HalfForm() {
  const { state, props } = useTillForm();
  return h('div', { className: 'flex h-[100dvh] min-h-0 bg-background', id: 'ready' },
    state,
    h('div', { className: 'w-1/2 h-full border-r border-foreground/10 max-[520px]:hidden' }),
    h('div', { className: `w-1/2 max-[520px]:w-full h-full min-w-0 ${theme}` },
      h(ConsentCapture, props)));
}

/**
 * SCRUM-954 — the phone till's form as `MobileTill.tsx` hands it to the
 * parent: HandToCustomer's customer screen round the form, "Return phone to
 * staff" under it, the form told it is on a phone (`phoneScroll`).
 */
function PhoneForm() {
  const { state, props } = useTillForm();
  const { t } = useLanguage();
  return h('div', { className: 'h-[100dvh] bg-background', id: 'ready' },
    state,
    h(HandToCustomer, { title: t('handToCustomer.consentTitle'), subtitle: t('handToCustomer.consentSubtitle'),
      handBackLabel: t('handToCustomer.returnPhone'), onDone: () => undefined, onCancel: () => undefined,
      children: h(ConsentCapture, { ...props, phoneScroll: true }) }));
}

/**
 * SCRUM-963 — the returning family's review as the paired display draws it
 * (`PublicSavedChildrenReview`: `publicMode`, the family's language): the
 * first child still to confirm ("Saved — still correct?"), the second
 * confirmed ("Confirmed"), on the display's look.
 */
function ReviewScreen() {
  const { lang } = useLanguage();
  const slots = [
    { id: 'zz-review-a', savedChildId: 'zz-saved-a', name: 'ZZ TEST Aya', age: '6', dateOfBirth: '2020-01-01' },
    { id: 'zz-review-b', savedChildId: 'zz-saved-b', name: 'ZZ TEST Ben', age: '8', dateOfBirth: '2018-01-01' },
  ];
  const saved = [
    { id: 'zz-saved-a', childName: 'ZZ TEST Aya', dateOfBirth: '2020-01-01', childAge: 6 },
    { id: 'zz-saved-b', childName: 'ZZ TEST Ben', dateOfBirth: '2018-01-01', childAge: 8 },
  ];
  return h('div', { className: `${theme} h-[100dvh] w-full min-w-0 overflow-hidden bg-background text-foreground flex flex-col`, id: 'ready' },
    h('div', { className: 'flex-1 min-h-0' },
      h(SavedChildrenReview, {
        slots, savedChildren: saved, confirmedIds: ['zz-review-b'], publicMode: true, lang, publicReferenceDate: '2026-11-13',
        onUpdateSlot: () => undefined, onConfirmSlot: () => undefined, onAssignSaved: () => undefined, onMarkNew: () => undefined,
        onRemoveSaved: () => undefined, onBack: () => undefined, onContinue: () => undefined, canContinue: false, onStaffHelp: () => undefined,
      })));
}

/**
 * SCRUM-963 — the phone till's supervision gate as `MobileTill.tsx` draws its
 * step (`h-full overflow-y-auto p-4`), between the phone's bars at their
 * staging heights (the header and the step's title, 108 pixels; the cart bar
 * and the tabs, 110; pictures 12a, 12b). `&desk=1` draws the counter till's
 * step instead (Till.tsx: the gate in its column, `p-6`).
 */
function GateScreen() {
  const [name, setName] = useState('');
  const gate = h(SupervisionGate, {
    slots: [{ ...halfSlot, id: 'zz-gate', name }], parentName: '', consentAck: false, policy, acknowledgedConfirmationIds: [],
    onUpdateSlot: (_id: string, patch: Partial<SupervisedSlot>) => { if (patch.name !== undefined) setName(patch.name); },
    onToggleWaiver: () => undefined, onBack: () => undefined, onContinue: () => undefined,
    continueOpensForm: true, contactConfirmed: false, contactPhoneProblem: 'empty',
  });
  if (query.get('desk') === '1') {
    return h('div', { className: 'light h-[100dvh] w-full flex bg-background text-foreground', id: 'ready' },
      h('div', { className: 'flex-1 overflow-hidden relative p-6' }, gate),
      h('div', { className: 'w-[360px] shrink-0' }));
  }
  return h('div', { className: 'light h-[100dvh] w-full flex flex-col bg-background text-foreground', id: 'ready' },
    h('div', { className: 'shrink-0', style: { height: 108 } }),
    h('div', { className: 'flex-1 min-h-0' }, h('div', { className: 'h-full overflow-y-auto p-4', 'data-testid': 'phone-step' }, gate)),
    h('div', { className: 'shrink-0', style: { height: 110 } }));
}

/** SCRUM-963 — the display page itself, paired to the stand-in box. */
function PairedScreen() {
  return h('div', { id: 'ready' }, h(Display));
}
if (screen === 'paired') installBox(query.get('doc') === 'identify' ? { identify: true } : { form: firstPrompt }, theme);

createRoot(document.getElementById('root')!).render(
  screen === 'paired'
    ? h(LanguageProvider, { storageKey: 'oto.display.language', children: h(PairedScreen) })
    : h(LanguageProvider, null,
      screen === 'half' ? h(HalfForm) : screen === 'phone' ? h(PhoneForm) : screen === 'review' ? h(ReviewScreen)
        : screen === 'gate' ? h(GateScreen) : h(DisplayForm)));
