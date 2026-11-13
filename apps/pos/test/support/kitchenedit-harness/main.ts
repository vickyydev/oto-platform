import { createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { EventView, PartyKitchenPlan } from '@oto/shared';
import { toOtoEvent } from '@/api/events';
import { PartyEditForm } from '@/components/parties/PartyEditForm';
import { PARTY_ACTIONS_ROW } from '@/components/parties/partyLayout';
import { Button } from '@/components/ui/button';
import { Ban, GlassWater, MessageCircle, Pencil, Sparkles, Wallet } from 'lucide-react';
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
 *
 * SCRUM-953 (point 6) — `screen=actions`: the party page's header as
 * `PartyDetail.tsx` draws it with a settlement open, its six buttons in the
 * row's own classes (`PARTY_ACTIONS_ROW`), in the same frame; read with
 * `window.__readActionsRow`.
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

/** Where each of the header's buttons stands against the party page's column. */
function readActionsRow() {
  const column = document.querySelector('[data-testid="party-column"]')!.getBoundingClientRect();
  return {
    column: [column.left, column.right], pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
    buttons: [...document.querySelectorAll('[data-testid="party-actions"] button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent?.trim() ?? '', left: r.left, right: r.right, top: r.top, whole: b.scrollWidth <= b.clientWidth + 0.5 };
    }),
  };
}

function ActionsPage() {
  useEffect(() => {
    void document.fonts.ready.then(() => { document.documentElement.dataset.ready = '1'; });
  }, []);
  const button = (icon: typeof Pencil, label: string, primary = false) =>
    h(Button, { key: label, variant: primary ? 'default' : 'outline', size: 'lg', className: 'gap-2 h-12' }, h(icon, { className: 'w-5 h-5' }), label);
  // PartyDetail's header: the title block and the button row beside it (`flex items-start justify-between gap-4 flex-wrap`).
  const header = h('div', { className: 'shrink-0 mb-4' },
    h('div', { className: 'flex items-start justify-between gap-4 flex-wrap' },
      h('div', { className: 'min-w-0' },
        h('h2', { className: 'text-2xl font-black tracking-tight' }, 'ZZ TEST SCRUM-953 party'),
        h('p', { className: 'text-muted-foreground mt-1' }, 'ZZ TEST Mali · turning 6 · 13:00–16:00 · Party room 1')),
      h('div', { className: PARTY_ACTIONS_ROW, 'data-testid': 'party-actions' },
        button(MessageCircle, 'Message parent'), button(Pencil, 'Edit party'), button(Sparkles, 'Resume settlement ฿18010'),
        button(Ban, 'Cancel settlement'), button(GlassWater, 'Add F&B to party'), button(Wallet, 'Take balance ฿18010', true))));
  return h('div', { className: 'h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden' },
    h('div', { className: 'flex-1 min-h-0 p-6' },
      h('div', { className: 'mx-auto h-full max-w-5xl flex flex-col min-h-0', 'data-testid': 'party-column' }, header)));
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
    __readActionsRow?: typeof readActionsRow;
  }
}

window.__readKitchenLines = readKitchenLines;
window.__readActionsRow = readActionsRow;
document.documentElement.classList.add('light');
createRoot(document.getElementById('root')!).render(h(LanguageProvider, null, h(params.get('screen') === 'actions' ? ActionsPage : Page)));
