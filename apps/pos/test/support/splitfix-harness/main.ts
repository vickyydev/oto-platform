import { createElement as h, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { StepCustomerType } from '@/components/till/StepCustomerType';
import { StepIdentify } from '@/components/till/StepIdentify';
import { StepConfirmation, type SaleIssue } from '@/components/till/StepConfirmation';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { MerchGrid } from '@/components/merch/MerchGrid';
import { MerchCustomerDisplay } from '@/components/merch/MerchCustomerDisplay';
import { StrandedList } from '@/components/eod/StrandedList';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { loadSellableStock } from '@/api/stock';
import { getMenuCategories, getTicketTypes } from '@/mockApi';
import { upsertMenuCategory, deleteMenuCategory } from '@/store/catalogStore';
import { HISTORY_SEARCH_PLACEHOLDER } from '@/lib/historyLookup';
import type { TaxBreakdownBaht } from '@/lib/cartWire';
import type { EodStrandedRow } from '@oto/shared';
import type { CartLine, Member, MenuItem, MerchItem, MerchOrderLine, Sale } from '@/types';
import { readSplitFix } from './measure';
import '@/fonts.css';
import '@/index.css';

/**
 * SCRUM-959 — the page `test/s959-split-view-measured.test.ts` drives: the
 * screens the split view's proof of 12 November found cut, each drawn by the
 * till's own components in the frame its page draws them in (the frames'
 * classes are pinned against the pages by the test), at the window the test
 * sets, with the till's chrome above at the height staging measured.
 *
 *   `tiers-two-line`   the rate cards after "Show all rates", for a member
 *                      whose name takes two lines (picture 01b);
 *   `identify`         the Membership Check waiting for the phone (20b);
 *   `confirm`          Payment Successful with the credit column (03d, 06d);
 *   `fnb-menu`         the F&B menu, staging's categories and dishes (20c,
 *                      14a), one dish in the order;
 *   `merch-grid`       the Shop's grid, staging's items (16a);
 *   `merch-display`    the Shop's customer half with two lines (16e);
 *   `history-search`   History's search row (14f);
 *   `stranded`         the phone End of Day's "Still counted inside" with a
 *                      long band code (17b).
 *
 * `split=1` puts the staff half beside the customer half (`w-1/2`), as the
 * test harness the park runs on one screen does; `split=0` is full width.
 */
const params = new URLSearchParams(window.location.search);
const screen = params.get('screen') ?? 'tiers-two-line';
const split = params.get('split') === '1';

// --- The platform's answers: an empty shelf, so nothing is stock-tracked ---------

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const body = /\/stock\/sellable$/.test(url.pathname) ? { branchId: 'harness-branch', products: [] } : undefined;
  return Promise.resolve(
    body === undefined
      ? new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
};

const noop = () => undefined;

// --- The ticket till ----------------------------------------------------------------

/** Staging's member of picture 01b: the name takes two lines in the split view. */
const twoLineMember: Member = {
  id: '01990000-0000-7000-8000-000000000959',
  phone: '+66898884010',
  nickname: 'ZZ TEST 884 Expat Verified Member',
  tierVerification: {
    tier: 'expat', proofType: 'Passport', verifiedAt: '2026-11-12T03:00:00.000Z',
    verifiedBy: 'Som', verifiedById: 'account-1', expiresAt: '2030-01-01',
  },
};

function paidSale(): Sale {
  const ticket = getTicketTypes()[0]!;
  const line: CartLine = { id: 'line-1', ticketType: ticket, tier: 'tourist', kids: 1, adults: 1, socks: 0, addOns: [], lineTotal: 1040 };
  return {
    id: 'harness-sale-959', operatorId: 'account-1', operatorName: 'Som', tier: 'tourist', lines: [line],
    manualDiscounts: [], paymentMethod: 'cash', total: 1040, creditGrants: [],
    bracelets: { adults: 1, children: 1 }, createdAt: '2026-11-12T09:00:00.000Z', status: 'completed', refunds: [],
  } as unknown as Sale;
}

/** The platform's answer for it: one F&B credit, printed on the receipt (staging's 03d). */
const paidIssue = {
  number: { kind: 'receipt', number: 'Z88401-000001' },
  bands: null,
  lines: [],
  printJobs: [{ id: 'job-1', kind: 'receipt', status: 'printed', reprintOf: null }],
  grants: [{ walletId: 'wallet-1', creditSatang: 35_000, personIndex: 0, role: 'adult', gateAccess: true, qrCode: 'QR-959' }],
  issuedVouchers: [],
} as unknown as SaleIssue;

function tillScreen(): ReactNode {
  switch (screen) {
    case 'tiers-two-line':
      return h(StepCustomerType, { member: twoLineMember, selectedTier: 'expat', onPickTier: noop, onRequestVerify: noop, onShowAllTiers: noop, showAllTiers: true });
    case 'identify':
      return h(StepIdentify, { phone: '', nickname: '', member: null, onRedeemBooking: noop });
    default:
      throw new Error(`no till screen "${screen}"`);
  }
}

/** The counter till's frame, as `pages/Till.tsx` draws it (classes pinned by the test). */
function TillFrame() {
  const staffTill = h('div', { className: 'flex h-full w-full bg-background text-foreground overflow-hidden' },
    h('div', { className: 'flex-1 flex flex-col border-r bg-card/30 min-w-0' },
      h('div', { id: 'region', className: 'flex-1 overflow-hidden relative p-6' }, tillScreen())),
    h('div', { className: 'w-[360px] min-w-0 bg-sidebar flex flex-col p-6 overflow-y-auto' }));
  return chromeAnd(206, staffTill);
}

/** Payment Successful: the till's step 6, the order column gone (`pages/Till.tsx`). */
function ConfirmFrame() {
  const staffTill = h('div', { className: 'flex h-full w-full bg-background text-foreground overflow-hidden' },
    h('div', { className: 'flex-1 flex flex-col border-r bg-card/30 min-w-0' },
      h('div', { id: 'region', className: 'flex-1 overflow-hidden relative p-6' },
        h('div', { className: 'flex h-full min-h-0 flex-col' },
          h('div', { className: 'min-h-0 flex-1' }, h(StepConfirmation, { sale: paidSale(), onNewSale: noop, issue: paidIssue }))))));
  return chromeAnd(206, staffTill);
}

/** The window: the till's chrome at staging's height, the staff half, and the customer half when split. */
function chromeAnd(chrome: number, staff: ReactNode, customer: ReactNode = null) {
  return h('div', { className: 'h-[100dvh] w-full flex flex-col bg-background' },
    h('div', { className: 'shrink-0', style: { height: chrome }, 'data-chrome': 'staging' }),
    h('div', { className: 'flex-1 flex min-h-0' },
      h('div', { className: `${split ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0` }, staff),
      split ? h('div', { className: 'w-1/2 h-full min-w-0' }, customer) : null));
}

// --- F&B and the Shop ---------------------------------------------------------------

/** Staging's menu on 12 November: twenty-two top-level categories (picture 20c). */
const STAGING_CATEGORIES = [
  'Breakfast', 'Sides', 'Sharing', 'Soup', 'Salads', 'Pasta', 'Pizza', 'Mains', 'Asian Food', 'Kids', 'Desserts',
  'Coffee', 'Iced Coffee', 'Chocolate', 'Soda', 'Smoothies', 'Juice', 'Tea pot', 'Soft drinks', 'Kids juice', 'Wine', 'Beer',
];
const catId = (name: string) => `cat-${name.toLowerCase().replace(/\W+/g, '-')}`;

function seedMenu(): MenuItem[] {
  for (const c of getMenuCategories()) deleteMenuCategory(c.id);
  STAGING_CATEGORIES.forEach((name, i) => upsertMenuCategory({
    id: catId(name), name, sortOrder: i + 1, defaultPrepStation: 'kitchen', defaultTaxCategory: 'fnb',
  } as Parameters<typeof upsertMenuCategory>[0]));
  const dish = (id: string, name: string, cat: string, baht: number): MenuItem =>
    ({ id, name, category: catId(cat), price: { weekday: baht, weekend: baht } });
  return [
    dish('m-american', 'American Breakfast', 'Breakfast', 290),
    dish('m-pancakes', 'Pancakes', 'Breakfast', 175),
    dish('m-omelette', 'Thai Omelette with Rice', 'Breakfast', 150),
    dish('m-granola', 'Granola Strawberry Yoghurt', 'Breakfast', 190),
    dish('m-croissant', 'Croissant', 'Breakfast', 95),
    dish('m-fries', 'French fries', 'Sides', 175),
    dish('m-wedges', 'Potato Wedges', 'Sides', 160),
    dish('m-nachos', 'Nachos to Share', 'Sharing', 250),
    dish('m-tomyum', 'Tom Yum Soup', 'Soup', 180),
    dish('m-caesar', 'Caesar Salad', 'Salads', 220),
    dish('m-carbonara', 'Carbonara', 'Pasta', 260),
    dish('m-margherita', 'Margherita Pizza', 'Pizza', 320),
    dish('m-chicken-rice', 'Grilled Chicken Rice', 'Mains', 240),
    dish('m-padthai', 'Pad Thai', 'Asian Food', 190),
    dish('m-nuggets', 'Chicken Nuggets', 'Kids', 150),
    dish('m-brownie', 'Chocolate Brownie', 'Desserts', 140),
    dish('m-cappuccino', 'Cappuccino', 'Coffee', 110),
    dish('m-americano', 'Americano', 'Coffee', 90),
    dish('m-iced-latte', 'Iced Latte', 'Iced Coffee', 120),
    dish('m-hot-choc', 'Hot Chocolate', 'Chocolate', 110),
    dish('m-cola', 'Coca-Cola', 'Soda', 60),
    dish('m-mango', 'Mango Smoothie', 'Smoothies', 130),
    dish('m-orange', 'Orange Juice', 'Juice', 100),
    dish('m-tea', 'English Breakfast Tea', 'Tea pot', 90),
    dish('m-water', 'Mineral Water', 'Soft drinks', 30),
    dish('m-apple', 'Apple Juice Box', 'Kids juice', 45),
    dish('m-red', 'House Red Wine', 'Wine', 220),
    dish('m-chang', 'Chang Beer', 'Beer', 120),
  ];
}

/** Staging's shop on 12 November (pictures 16a, 16e). */
function shopItems(): MerchItem[] {
  const item = (id: string, name: string, category: string, baht: number): MerchItem =>
    ({ id, name, category, active: true, price: { weekday: baht, weekend: baht } });
  return [
    item('s-golden', 'Golden Ticket', 'Tickets & passes', 1500),
    item('s-school', 'School Admission Ticket', 'Tickets & passes', 250),
    item('s-thai-int', 'Thai-International Admission Ticket', 'Tickets & passes', 200),
    item('s-helium-65', 'Helium Balloon (65)', 'Balloons', 65),
    item('s-helium-75', 'Helium Balloon (75)', 'Balloons', 75),
    item('s-foil-s', 'Helium Foil Balloon S', 'Balloons', 150),
    item('s-backpack', 'Deer Kids Backpack', 'Merchandise', 1050),
    item('s-dino', 'Dino Monster Truck', 'Merchandise', 1200),
    item('s-bracelet', 'OTO CS Bracelet', 'Merchandise', 100),
    item('s-workshop', 'Slime Workshop', 'Workshop', 350),
  ];
}

/**
 * The F&B and Shop stations' order stage, as `pages/OrderStation.tsx` and
 * `pages/MerchStation.tsx` draw it at a desk (classes pinned by the test): the
 * menu column (the region read) beside the 380px order column.
 */
function ItemFrame({ grid }: { grid: ReactNode }) {
  const staff = h('div', { className: 'h-full w-full flex flex-col bg-background text-foreground overflow-hidden' },
    h('div', { className: 'flex-1 min-h-0' },
      h('div', { className: 'flex h-full min-h-0' },
        h('div', { id: 'region', className: 'flex-1 min-w-0 flex flex-col p-6 border-r bg-card/20' },
          h('div', { className: 'flex-1 min-h-0' }, grid)),
        h('div', { className: 'w-[380px] shrink-0 bg-sidebar p-6 overflow-y-auto' }))));
  // F&B and the Shop: the harness banner, the header and the stock strip (staging's 146px, picture 14a).
  return chromeAnd(146, staff);
}

/** The Shop's customer half with two lines on the order, as the station draws it in the split view. */
function MerchDisplayFrame() {
  const items = shopItems();
  const lines: MerchOrderLine[] = [
    { id: 'l1', merchItem: items[8]!, qty: 1, lineTotal: 100 },
    { id: 'l2', merchItem: items[3]!, qty: 1, lineTotal: 65 },
  ];
  const tax = { netSubtotal: 0, discountTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, grandTotal: 165, serviceChargeTotal: 0, categories: [] } as unknown as TaxBreakdownBaht;
  const display = h(LanguageProvider, null,
    h('div', { id: 'region', className: 'h-full' },
      h(MerchCustomerDisplay, {
        stage: 'order', wristband: null, lines, manualDiscounts: [], total: 165, taxBreakdown: tax,
        promptpayAmount: null, completedOrder: null, newBalance: null,
      })));
  return chromeAnd(146, h('div', { className: 'h-full' }), h('div', { className: 'w-full h-full light' }, display));
}

// --- History's search row -----------------------------------------------------------

/** `pages/History.tsx`'s body and its search row (classes pinned by the test). */
function HistoryFrame() {
  return h('div', { className: 'h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden' },
    // The station header and the stock strip (staging's 97px, picture 14f).
    h('div', { className: 'shrink-0', style: { height: 97 } }),
    h('div', { className: 'flex-1 min-h-0 p-6' },
      h('div', { id: 'region', className: 'mx-auto h-full max-w-5xl flex flex-col min-h-0' },
        h('div', { className: 'shrink-0 mb-4 flex items-center gap-3' },
          h('div', { className: 'relative flex-1' },
            h('input', {
              type: 'text', placeholder: HISTORY_SEARCH_PLACEHOLDER, readOnly: true, value: '',
              className: HISTORY_SEARCH_CLASS,
            })),
          h('div', { className: 'relative shrink-0' },
            h('input', { type: 'date', readOnly: true, value: '2026-11-12', className: 'h-12 pl-9 pr-3 rounded-xl bg-muted/50 border border-border text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40' })),
          h(Button, { size: 'lg', variant: 'outline', className: 'h-12 gap-2 shrink-0' }, 'Find by phone'),
          h(Button, { size: 'lg', className: 'h-12 gap-2 shrink-0' }, 'Scan bracelet')))));
}

/** History's search field (pinned against `pages/History.tsx` by the test). */
const HISTORY_SEARCH_CLASS =
  'w-full h-12 pl-12 pr-12 placeholder-shown:pr-4 rounded-xl bg-muted/50 border border-border text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';

// --- The phone's End of Day ---------------------------------------------------------

/** Staging's row of picture 17b: a child checked in on a band whose code has no break in it. */
const strandedRow: EodStrandedRow = {
  kind: 'checkin',
  subjectId: '01990000-0000-7000-8000-000000000960',
  bandCode: 'Z88401229PF69WPVWDEXKX7PTKWSVQEHH.G8F379S6EPK3M2Q',
  childName: 'ZZ TEST Mali 884 G',
  childrenWithBand: 0,
  lastGateEvent: null,
  checkedInAt: '2026-11-12T16:11:00.000Z',
  sale: { saleId: '01990000-0000-7000-8000-000000000961', receiptNumber: 'Z88401-000005' },
  guardian: { name: 'ZZ TEST 884 guardian G', phone: '+66898884014' },
};

/** `MobileTodayPage`'s scrolling body and `MobileEndOfDayTab`'s column (classes pinned by the test). */
function PhoneEodFrame() {
  return h('div', { className: 'h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden' },
    h('div', { className: 'h-full flex flex-col overflow-hidden' },
      h(ScrollArea, { className: 'flex-1 min-h-0' },
        h('div', { className: 'p-4' },
          h('div', { id: 'region', className: 'space-y-3 pb-4' },
            h(StrandedList, {
              compact: true, rows: [strandedRow], override: null, readOnly: false, resolving: null, error: null,
              canOverride: false, overrideReason: '', onOverrideReason: noop, onResolve: noop,
            }),
            h(Button, { size: 'lg', className: 'w-full h-14 text-lg font-bold gap-2' }, 'Close Day'))))));
}

// --- The page -----------------------------------------------------------------------

function Page() {
  useEffect(() => {
    void loadSellableStock('harness-branch').then(() => {
      document.documentElement.dataset.ready = '1';
    });
  }, []);
  switch (screen) {
    case 'confirm':
      return h(ConfirmFrame);
    case 'fnb-menu': {
      const items = seedMenu();
      return h(ItemFrame, { grid: h(MenuGrid, { items, quantities: { 'm-pancakes': 1 }, onAdd: noop }) });
    }
    case 'merch-grid':
      return h(ItemFrame, { grid: h(MerchGrid, { items: shopItems(), quantities: { 's-helium-65': 1 }, onAdd: noop }) });
    case 'merch-display':
      return h(MerchDisplayFrame);
    case 'history-search':
      return h(HistoryFrame);
    case 'stranded':
      return h(PhoneEodFrame);
    default:
      return h(TillFrame);
  }
}

window.__readSplitFix = readSplitFix;
document.documentElement.classList.add('light');
createRoot(document.getElementById('root')!).render(h(Page));
