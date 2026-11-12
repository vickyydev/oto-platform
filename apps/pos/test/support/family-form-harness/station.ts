import type { ConsentAction, ConsentPrompt, StationIntent, StationSessionDocument } from '@oto/shared';

/**
 * SCRUM-963 — A STAND-IN FOR THE COUNTER'S BOX, BEHIND THE REAL DISPLAY PAGE.
 *
 * `?screen=paired` draws `pages/Display.tsx` itself, paired to this box: the
 * page's own calls (`/api/display/pairing`, the station bridge's
 * `display/session` and `display/intents`) are answered here in the page, and
 * its live channel is refused, so it reads its box once a second as it does
 * behind a proxy that refuses streaming. The box takes the family's fills,
 * Done, Ask the team and their language as a real box does, and the test
 * reads what it holds (`window.__zzBox.document`, the till's copy).
 *
 * `window.__zzBox.drop()` takes the line down as the proof did: every call
 * fails as a fetch to nowhere does, and the browser says it is offline.
 * `window.__zzBox.restore()` brings it back.
 */
export const BOX_STATION = { id: '01990000-0000-7000-8000-000000000963', name: 'ZZ TEST counter 963', kind: 'till' };
const BOX_ID = '01990000-0000-7000-8000-000000000964';
const DEVICE = { id: 'zz-display-963', name: 'ZZ TEST screen 963' };

export interface ZzBox {
  offline: boolean;
  document: StationSessionDocument;
  heard: StationIntent[];
  drop: () => void;
  restore: () => void;
}

declare global {
  interface Window { __zzBox?: ZzBox }
}

function documentOf(prompt: Record<string, unknown>, stage: 'identify' | 'input', theme: 'dark' | 'light'): StationSessionDocument {
  return {
    stationId: BOX_STATION.id, boxId: BOX_ID, schemaVersion: 1, sequence: 1, stage,
    cart: { supported: true, sale: { tier: 'tourist' } }, member: null, totals: null, payment: null,
    prompt, language: 'en', theme, lease: null, takeoverCount: 0, updatedAt: new Date().toISOString(),
  } as StationSessionDocument;
}

/** The family form's prompt with the fill the box took laid in, as the till lays it. */
function filled(prompt: ConsentPrompt, action: Extract<ConsentAction, { action: 'fill' }>): ConsentPrompt {
  return {
    ...prompt,
    requestId: `zz-963-form-${Number(prompt.requestId.split('-').at(-1)) + 1}`,
    slots: prompt.slots.map((slot) => {
      const given = action.slots.find((item) => item.id === slot.id);
      return given ? { ...slot, name: given.name, ageYears: given.ageYears, dateOfBirth: given.dateOfBirth,
        allergiesMedical: given.allergiesMedical, foodRestrictions: given.foodRestrictions } : slot;
    }),
    guardianName: action.guardianName,
    ...(action.guardianPhone !== undefined ? { guardianPhone: action.guardianPhone } : {}),
    ...(action.contactChannel !== undefined ? { contactChannel: action.contactChannel } : {}),
    ...(action.contactConfirmed !== undefined ? { contactConfirmed: action.contactConfirmed } : {}),
    ...(action.step ? { familyStep: action.step } : {}),
    consentAcknowledged: action.consentAcknowledged,
    confirmations: prompt.confirmations.map((item) => ({ ...item, acknowledged: action.acknowledgedConfirmationIds.includes(item.id) })),
  };
}

export function installBox(screen: { form: ConsentPrompt } | { identify: true }, theme: 'dark' | 'light'): ZzBox {
  const prompt = 'form' in screen
    ? { ...screen.form, requestId: 'zz-963-form-1' }
    : { kind: 'identify', requestId: 'zz-963-identify', phone: '', nickname: '', contactChannel: 'whatsapp', saleKey: 'zz-963-sale' };
  const box: ZzBox = {
    offline: false,
    document: documentOf(prompt, 'form' in screen ? 'input' : 'identify', theme),
    heard: [],
    drop() { box.offline = true; window.dispatchEvent(new Event('offline')); },
    restore() { box.offline = false; },
  };
  const take = (intent: StationIntent) => {
    box.heard.push(intent);
    const now = new Date().toISOString();
    if (intent.type === 'display.set_language') {
      box.document = { ...box.document, language: intent.payload.language as StationSessionDocument['language'], updatedAt: now };
      return;
    }
    if (intent.type !== 'display.consent') return;
    const action = intent.payload as ConsentAction;
    const current = box.document.prompt as unknown as ConsentPrompt;
    box.document = {
      ...box.document, sequence: box.document.sequence + 1, updatedAt: now,
      prompt: (action.action === 'fill' ? filled(current, action)
        : { ...current, answer: { type: 'consent', actionId: intent.actionId, payload: action }, answeredAt: now }) as Record<string, unknown>,
    };
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    // A line that is down: the call reaches nothing.
    if (box.offline) throw new TypeError('Failed to fetch');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/display/pairing') return json({ status: 'paired', station: BOX_STATION, device: DEVICE });
    if (url.pathname.endsWith('/display/session')) return json({ station: BOX_STATION, device: DEVICE, document: box.document });
    if (url.pathname.endsWith('/display/intents')) {
      take(JSON.parse(String(init?.body)) as StationIntent);
      return json({ document: box.document });
    }
    // The live channel is refused: the page reads its box once a second.
    return json({ error: { code: 'NOT_FOUND', message: 'Not served by this stand-in.' } }, 404);
  };
  window.__zzBox = box;
  return box;
}
