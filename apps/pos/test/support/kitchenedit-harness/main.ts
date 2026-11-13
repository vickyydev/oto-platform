import { createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { EventView, PartyKitchenPlan } from '@oto/shared';
import { toOtoEvent } from '@/api/events';
import { PartyEditForm } from '@/components/parties/PartyEditForm';
import { LanguageProvider } from '@/i18n/LanguageContext';
import type { PartyBooking } from '@/types';
import '@/fonts.css';
import '@/index.css';

/**
 * SCRUM-967 (point 11) — the page `test/s967-kitchen-marks-measured.test.ts`
 * drives: the party page's Edit form (`components/parties/PartyEditForm.tsx`,
 * its kitchen and bar sections from `PartyKitchenPlanEditor.tsx`) in the frame
 * the Events page draws a party in (`pages/Events.tsx`: `p-6` around
 * `mx-auto max-w-5xl`), with ZZ TEST dishes long enough that their marks were
 * cut at the end of the one-line name box on staging (picture 05a of
 * docs/qa/proof-2026-11-13/SCRUM-907).
 *
 *   `who=reception`  the sections read-only, as reception sees them;
 *   `who=manager`    a manager's, the counts and notes editable;
 *   `split=1`        the frame in half the window (the split view's staff half).
 */
const params = new URLSearchParams(window.location.search);
const manager = params.get('who') === 'manager';
const split = params.get('split') === '1';

/** What the measurement reads of one line: its name box, and its marks under it. */
export interface KitchenLineReading {
  name: string;
  marks: string | null;
  /** The marks' whole text laid out: nothing cut, nothing past their box. */
  marksWhole: boolean;
  /** The marks inside the section card that holds them, and on screen. */
  marksInside: boolean;
}

const PARTY_ID = '0190a0a0-0000-7000-8000-0000000e0967';

const KITCHEN: PartyKitchenPlan = {
  eventId: PARTY_ID,
  partyDate: '2026-11-13',
  startTime: '13:00',
  endTime: '16:00',
  counts: { kidsExpected: 10, adultsExpected: 4 },
  setMenu: [
    { lineId: 'zz967-mango', productCode: null, name: 'ZZ TEST mango sticky rice with coconut cream', qty: 2, choiceGroup: null,
      chosenOption: null, note: null, origin: 'extra', onTillMenu: false },
    { lineId: 'zz967-skewers', productCode: 'CF-31', name: 'ZZ TEST grilled chicken skewers for the grown-ups', qty: 4, choiceGroup: null,
      chosenOption: null, note: null, origin: 'extra', onTillMenu: true, audience: 'adults' },
    { lineId: 'zz967-pizza', productCode: 'CF-24', name: 'ZZ TEST mini cheese pizza for the kids table', qty: 10, choiceGroup: null,
      chosenOption: null, note: null, origin: 'set_menu', onTillMenu: true, audience: 'kids' },
    { lineId: 'zz967-calamari', productCode: null, name: 'ZZ TEST calamari', qty: 2, choiceGroup: null,
      chosenOption: null, note: null, origin: 'extra', onTillMenu: false, audience: 'kids' },
  ],
  barItems: [
    { lineId: 'zz967-soda', productCode: null, name: 'ZZ TEST sparkling passion fruit soda pitcher', qty: 3, note: null, origin: 'extra', onTillMenu: false },
  ],
  kitchen: { kidsFoodTime: '14:00', adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: '11:00', barServiceTime: '14:30' },
  cake: null,
};

const VIEW: EventView = {
  id: PARTY_ID, branchId: '0190a0a0-0000-7000-8000-00000000b001', type: 'party', appEventType: 'birthday',
  status: 'upcoming', appStatus: 'upcoming', archived: false, title: 'ZZ TEST SCRUM-967 party',
  startDate: '2026-11-13', endDate: '2026-11-13', cancelledDays: [], startTime: '13:00', endTime: '16:00',
  location: 'Party room 1', expectedKids: 10, expectedAdults: 4, entryPrice: null,
  party: {
    childName: 'ZZ TEST Mali', kidTurningAge: 6, bookingName: null, parentName: 'ZZ TEST Nok', parentPhone: '+66812345678',
    activities: null, decoration: null, totalValueSatang: 0, depositSatang: 0, depositDate: null, walkUpCharges: [],
    charges: [], payments: [], lastEdited: null, editSync: null, settlement: null,
  },
  attendeeCount: 0, attendees: [], roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
};

function readKitchenLines(): KitchenLineReading[] {
  const out: KitchenLineReading[] = [];
  for (const input of document.querySelectorAll<HTMLInputElement>('input[aria-label="Food items item"], input[aria-label="Bar items item"]')) {
    const row = input.closest('.space-y-1');
    const marksEl = row?.querySelector<HTMLElement>('[data-testid="kitchen-line-marks"]') ?? null;
    let marksWhole = false;
    let marksInside = false;
    if (marksEl) {
      const box = marksEl.getBoundingClientRect();
      const card = marksEl.closest<HTMLElement>('section, [class*="rounded-xl"], [class*="rounded-lg"]') ?? document.body;
      const cardBox = card.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(marksEl);
      const textBox = range.getBoundingClientRect();
      marksWhole = marksEl.scrollWidth <= marksEl.clientWidth + 0.5 && textBox.right <= box.right + 0.5;
      marksInside = box.left >= cardBox.left - 0.5 && box.right <= cardBox.right + 0.5
        && box.left >= 0 && box.right <= window.innerWidth + 0.5;
    }
    out.push({ name: input.value, marks: marksEl?.textContent ?? null, marksWhole, marksInside });
  }
  return out;
}

function Page() {
  useEffect(() => {
    void document.fonts.ready.then(() => { document.documentElement.dataset.ready = '1'; });
  }, []);
  const party = toOtoEvent(VIEW, 'hkt-central') as unknown as PartyBooking;
  const form = h(PartyEditForm, {
    party, kitchenPlan: KITCHEN, mayEditKitchen: manager, kitchenChoices: null,
    onSave: () => undefined, onCancel: () => undefined,
  });
  // The Events page's frame around a party (`pages/Events.tsx`).
  const frame = h('div', { className: 'h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden' },
    h('div', { className: 'flex-1 min-h-0 p-6' },
      h('div', { className: 'mx-auto h-full max-w-5xl flex flex-col min-h-0' }, form)));
  return split ? h('div', { className: 'flex h-[100dvh] w-full' }, h('div', { className: 'w-1/2 min-w-0' }, frame), h('div', { className: 'w-1/2' })) : frame;
}

declare global {
  interface Window {
    __readKitchenLines?: typeof readKitchenLines;
  }
}

window.__readKitchenLines = readKitchenLines;
document.documentElement.classList.add('light');
createRoot(document.getElementById('root')!).render(h(LanguageProvider, null, h(Page)));
