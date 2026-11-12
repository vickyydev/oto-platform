import * as React from 'react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { lineShownSatang, linesShownSatang, type ApiSaleLine } from '@/api/history';
import { DEPOSIT_KEPT_LABEL, PaymentRow, tenderStatusOf } from '@/components/history/SaleDetail';
import { surfaceThemeOf } from '@/components/shared/ChildDobPicker';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { DoorCheckInChoiceModal } from '@/components/till/DoorCheckInChoiceModal';
import { ScreenKeyboard } from '@/components/till/ScreenKeyboard';
import { paidLineOf } from '@/components/till/StepConfirmation';
import { DISPLAY_TOUCH, FORM_RECONNECTING_LINE, PHONE_SCROLL, PHONE_SCROLL_FORM } from '@/components/till/consentFormLayout';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import type { Sale } from '@/types';

/**
 * SCRUM-954 / SCRUM-953 — THE SMALL POINTS FROM THE 12 NOVEMBER PROOFS, AS
 * MARKUP AND AS NUMBERS. The layout points are measured in a browser
 * (`s893-family-form-touch-browser`, `s884-split-view-measured`); here, what
 * the screens say and add up to:
 *   - the on-screen keys' own button is a plain key reading "Hide" (954, 2);
 *   - the reconnecting line lies under the language button (954, 3);
 *   - the display form's presses take the finger's height, the till's own
 *     half and the phone keep theirs (954, 4), and the phone's form scrolls
 *     its heading away (954, 6);
 *   - a party's deposit kept by the party reads so in History (953, 4);
 *   - History's item cards add up to the Subtotal after a code (953, 5);
 *   - the door check-in dialog carries the success line it covers (953, 6).
 */

// The panels are compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });
// SaleDetail reads the operator, the station and the router at import.
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ active: { id: 'station-1' } }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/', () => undefined] }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som' }, can: () => true, offlineUnlock: null }),
}));
// The dialog's portal draws nothing on a server render: its content is drawn in place here.
vi.mock('@/components/ui/dialog', () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? createElement('div', { 'data-dialog': '' }, children) : null),
    DialogContent: pass, DialogHeader: pass, DialogFooter: pass, DialogTitle: pass, DialogDescription: pass,
  };
});

afterEach(() => vi.unstubAllGlobals());

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');
const plain = (html: string) => html.split('<!-- -->').join('');

const under = (element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => 'en', setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-954', children: element }));
};

// --- SCRUM-954 (2): one Done on the counter display --------------------------------------------

describe('SCRUM-954 (2) — the keys’ own button is a plain key', () => {
  const keys = () => renderToStaticMarkup(createElement(ScreenKeyboard, {
    value: '', onChange: () => undefined, onDone: () => undefined, doneLabel: 'Hide', spaceLabel: 'Space', backspaceLabel: 'Backspace',
  }));
  const button = (html: string, marker: string) => {
    const at = html.indexOf(marker);
    const open = html.lastIndexOf('<button', at);
    return html.slice(open, html.indexOf('>', at) + 1);
  };

  it('drawn as Space is, never the blue primary button', () => {
    const html = keys();
    const hide = button(html, 'data-testid="screen-keyboard-hide"');
    const space = button(html, 'aria-label="Space"');
    expect(hide).toContain('aria-label="Hide"');
    expect(hide).not.toContain('bg-primary');
    expect(hide).not.toContain('text-primary-foreground');
    for (const look of ['bg-foreground/5', 'border-foreground/10', 'text-lg', 'font-semibold', 'text-foreground/70']) {
      expect(hide, look).toContain(look);
      expect(space, look).toContain(look);
    }
    // Nothing on the keys is primary any more.
    expect(html.includes('bg-primary')).toBe(false);
  });

  it('the family’s form and the first screen’s nickname keys both say Hide, in every display language', () => {
    expect(src('components/till/TouchText.tsx')).toContain("doneLabel={t('display.keyboard.hide')}");
    expect(src('components/till/CustomerDisplay.tsx')).toContain("doneLabel={t('display.keyboard.hide')}");
    for (const file of ['components/till/TouchText.tsx', 'components/till/CustomerDisplay.tsx']) {
      expect(src(file)).not.toContain("doneLabel={t('common.done')}");
    }
    const words = DICTIONARY['display.keyboard.hide']!;
    expect(words.en).toBe('Hide');
    for (const lang of ['zh', 'th', 'ru', 'fr'] as const) {
      expect(words[lang], lang).toBeTruthy();
      expect(words[lang], lang).not.toBe(words.en);
    }
    // The form's own Done keeps its word.
    expect(DICTIONARY['common.done']!.en).toBe('Done');
  });
});

// --- SCRUM-954 (3) and (4): the display's form ------------------------------------------------------

describe('SCRUM-954 (3) — the reconnecting line under the language button', () => {
  it('Display.tsx draws it with the shared classes: over the form, under the button', () => {
    const display = src('pages/Display.tsx');
    expect(display).toContain('className={FORM_RECONNECTING_LINE}');
    expect(display).not.toContain('top-0 z-50 border-b');
    for (const cls of ['absolute', 'top-0', 'pointer-events-none', 'z-30', 'pr-36']) {
      expect(FORM_RECONNECTING_LINE.split(' '), cls).toContain(cls);
    }
    // The language button's corner, above it.
    expect(src('components/till/PublicConsentCapture.tsx')).toContain('<div className="absolute top-4 right-4 z-40"><LanguageSwitcher');
  });
});

describe('SCRUM-954 (4) — a finger’s height on the display, nothing else moved', () => {
  it('the display’s own form names the touch size on its bar, its pills and its language button; its read-only copy does not', () => {
    const form = src('components/till/PublicConsentCapture.tsx');
    expect(DISPLAY_TOUCH).toBe('min-h-11');
    expect(form).toContain('const touch = mirror ? undefined : DISPLAY_TOUCH;');
    expect(form).toContain('<LanguageSwitcher variant="dark" buttonClassName={DISPLAY_TOUCH} />');
    expect(form.match(/<Button [^>]*className=\{touch\}/g)).toHaveLength(5);
    expect(form).toContain("'rounded-full border px-4 py-1.5 text-base font-semibold transition-colors', touch,");
  });

  it('the till’s own customer half and the phone draw the form without it', () => {
    const half = plain(under(createElement(ConsentCapture, { ...consentProps, onDone: () => undefined })));
    expect(half.includes('min-h-11')).toBe(false);
    expect(half).toContain('class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-semibold transition-colors bg-foreground/10 border-foreground/15 text-foreground hover:bg-foreground/15"');
  });
});

// --- SCRUM-954 (6): the phone till's form ---------------------------------------------------------

const consentProps = {
  slots: [{ id: 's1', name: 'Mai', age: '6', waived: false, optIn: true, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false }],
  parentName: '', consentAck: false,
  policy: {
    bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'drop_off' }],
    siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [],
  },
  onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
  acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
} as never;

describe('SCRUM-954 (6) — the phone till’s form scrolls its heading away', () => {
  const body = (html: string) => /<div class="([^"]*)" data-testid="consent-form-body">/.exec(html)?.[1] ?? '';
  const form = (html: string) => /<div class="(flex-1 space-y-5 overflow-y-auto px-8 pb-6[^"]*)">/.exec(html)?.[1] ?? '';

  it('on the phone: the heading and the form scroll as one part at phone width', () => {
    const html = under(createElement(ConsentCapture, { ...consentProps, onDone: () => undefined, phoneScroll: true }));
    expect(body(html)).toBe(`flex min-h-0 flex-1 flex-col relative ${PHONE_SCROLL}`);
    expect(form(html)).toBe(`flex-1 space-y-5 overflow-y-auto px-8 pb-6 ${PHONE_SCROLL_FORM}`);
    expect(PHONE_SCROLL).toBe('max-[520px]:overflow-y-auto');
    // The language button goes with the heading, inside the part that scrolls.
    expect(html.indexOf('data-testid="consent-form-body"')).toBeLessThan(html.indexOf('absolute top-4 right-4 z-40'));
  });

  it('everywhere else exactly as before: the heading stands over the form’s own scrolling part', () => {
    const html = under(createElement(ConsentCapture, { ...consentProps, onDone: () => undefined }));
    expect(body(html)).toBe('flex min-h-0 flex-1 flex-col');
    expect(form(html)).toBe('flex-1 space-y-5 overflow-y-auto px-8 pb-6');
    expect(html.indexOf('absolute top-4 right-4 z-40')).toBeLessThan(html.indexOf('data-testid="consent-form-body"'));
  });

  it('the phone till hands its form over with it; the counter till does not', () => {
    const mobile = src('components/mobile/MobileTill.tsx');
    expect(mobile).toMatch(/doneNotSaved=\{familyDoneNotSaved\}\r?\n[^\n]*\n\s*phoneScroll\r?\n/);
    expect(src('pages/Till.tsx')).not.toContain('phoneScroll');
  });
});

// --- SCRUM-954 (5): the age picker's look --------------------------------------------------------

describe('SCRUM-954 (5) — the age picker reads the look of the screen it sits on', () => {
  const element = (found: { dark: boolean } | null) => ({ closest: () => found && { classList: { contains: (name: string) => name === 'dark' && found.dark } } }) as unknown as Element;
  it('dark on a dark screen, light on a light one, nothing where nothing says', () => {
    expect(surfaceThemeOf(element({ dark: true }))).toBe('dark');
    expect(surfaceThemeOf(element({ dark: false }))).toBe('light');
    expect(surfaceThemeOf(element(null))).toBeNull();
    expect(surfaceThemeOf(null)).toBeNull();
  });

  it('the family’s form asks for it on both screens; the staff copy does not', () => {
    expect(src('components/till/PublicConsentCapture.tsx')).toContain('disabled={locked} className="mt-2" matchSurface');
    expect(src('components/till/ConsentCapture.tsx')).toContain('matchSurface={!staffScreen}');
    for (const file of ['components/till/SupervisionGate.tsx', 'components/till/AddDropOffModal.tsx', 'components/shared/SavedChildrenReview.tsx']) {
      expect(src(file), file).not.toContain('matchSurface');
    }
  });
});

// --- SCRUM-953 (4): a party's deposit after its settlement was refunded ----------------------------

describe('SCRUM-953 (4) — a deposit kept by the party is not "Cancelled" in History', () => {
  const attempt = (over: Partial<PaymentAttemptView>): PaymentAttemptView => ({
    id: 'a', saleId: 's', method: 'other', provider: 'manual', status: 'approved', amountSatang: 100_000, tenderedSatang: null,
    changeSatang: null, terminalRef: null, tid: null, approvalCode: null, last4: null, invoiceNo: null, tranRef: null,
    actionId: null, offline: false, paidAt: '2026-11-12T14:15:00.000Z', createdAt: '2026-11-12T14:15:00.000Z', ...over,
  });
  const row = (over: Partial<PaymentAttemptView>) => plain(renderToStaticMarkup(createElement(PaymentRow, {
    attempt: attempt(over), sale: { note: 'Party: ZZ TEST SCRUM-936 party' }, fmt: () => '12 Nov, 21:15',
  })));

  it('the proof’s row (picture 03n): the deposit stays with the party, as the platform keeps it', () => {
    const html = row({ partyDeposit: true, status: 'cancelled' });
    expect(DEPOSIT_KEPT_LABEL).toBe('Stays with the party');
    expect(html).toContain('Party deposit');
    expect(html).toContain(' · Stays with the party');
    expect(html.includes('Cancelled')).toBe(false);
    expect(html).toContain('฿1000');
  });

  it('a deposit on a settlement still open reads Approved, and any other cancelled tender Cancelled, as before', () => {
    expect(tenderStatusOf(attempt({ partyDeposit: true })).label).toBe('Approved');
    expect(tenderStatusOf(attempt({ status: 'cancelled' })).label).toBe('Cancelled');
    expect(tenderStatusOf(attempt({ method: 'cash', status: 'cancelled' })).label).toBe('Cancelled');
    expect(row({ method: 'cash', status: 'cancelled', amountSatang: 10_000 })).toContain(' · Cancelled');
  });
});

// --- SCRUM-953 (5): History's item cards after a code ---------------------------------------------

/** SCRUM-934 proof, sale B (Z93401-000002): two children, a 10 percent code on ฿1,605. */
const line = (over: Partial<ApiSaleLine>): ApiSaleLine => ({
  id: 'l', lineNo: 1, cartLineId: 'c', kind: 'kids', componentKey: null, ticketPackageId: 'p', label: 'Kids', revenueCategory: 'tickets',
  taxableCategory: 'tickets', quantity: 1, unitSatang: 69_000, baseSatang: 69_000, discountSatang: 6_900, netSatang: 58_037,
  serviceChargeSatang: 0, taxSatang: 4_063, taxMode: 'inclusive', taxRateBp: 700, taxName: 'VAT', grossSatang: 62_100,
  customerTier: 'tourist', kidCount: 1, adultCount: 0, freeAdultCount: 0, stayHours: 1, stayDurationLabel: '1 Hour', ...over,
});
const mint = [
  line({ id: 'm-kids', cartLineId: 'stay-mint', childName: 'ZZ TEST Mint B 934' }),
  line({ id: 'm-fee', cartLineId: 'stay-mint', kind: 'service_fee', label: 'Drop-off service', unitSatang: 22_500, baseSatang: 22_500,
    discountSatang: 2_250, grossSatang: 20_250, childName: 'ZZ TEST Mint B 934' }),
];
const nok = [line({ id: 'n-kids', cartLineId: 'stay-nok', childName: 'ZZ TEST Nok B 934' })];

describe('SCRUM-953 (5) — History’s item cards read as the order panel did', () => {
  it('the proof’s sale: ฿915 and ฿690, which make the Subtotal ฿1,605 above the code', () => {
    expect(linesShownSatang(mint)).toBe(91_500);
    expect(linesShownSatang(nok)).toBe(69_000);
    expect(mint.map(lineShownSatang)).toEqual([69_000, 22_500]);
    // The Subtotal the money card shows is the ledger's sum of the lines before discounts.
    expect(linesShownSatang([...mint, ...nok])).toBe(160_500);
    // ... where the cards read ฿823.50 and ฿621 before, ฿1,444.50 under a Subtotal of ฿1,605.
    expect([...mint, ...nok].reduce((sum, l) => sum + l.grossSatang, 0)).toBe(144_450);
  });

  it('a sale with no discount reads exactly as before; a voucher’s free item stays ฿0, as on the panel', () => {
    const plainLine = line({ discountSatang: 0, grossSatang: 69_000, netSatang: 64_486, taxSatang: 4_514 });
    expect(lineShownSatang(plainLine)).toBe(plainLine.grossSatang);
    const free = line({ kind: 'promo_item', label: 'Ice Cream', unitSatang: 9_000, baseSatang: 9_000, discountSatang: 9_000, grossSatang: 0 });
    expect(lineShownSatang(free)).toBe(0);
  });

  it('desk and phone both use it, for each line and each card', () => {
    const desk = src('components/history/SaleDetail.tsx');
    expect(desk).toContain('const groupTotal = linesShownSatang(lines);');
    expect(desk).toContain('<span className="tabular-nums">฿{satangText(lineShownSatang(line))}</span>');
    expect(desk).not.toContain('l.grossSatang, 0)');
    const phone = src('components/mobile/history/MobileTransactionDetail.tsx');
    expect(phone).toContain('฿{satangText(linesShownSatang(lines))}');
    expect(phone).toContain('<span className="tabular-nums">฿{satangText(lineShownSatang(line))}</span>');
    expect(phone).not.toContain('sum + line.grossSatang');
  });
});

// --- SCRUM-953 (6): the success line under the door check-in dialog -------------------------------

describe('SCRUM-953 (6) — the door check-in dialog says what was paid', () => {
  const sale = { total: 1444.5, paymentMethod: 'cash' } as Pick<Sale, 'total' | 'paymentMethod'>;
  const groups = [{
    registrationId: 'reg-b', entries: [
      { checkInId: 'c-mint', childName: 'ZZ TEST Mint B 934', service: 'drop_off' as const, input: {} as never },
      { checkInId: 'c-nok', childName: 'ZZ TEST Nok B 934', service: 'none' as const, input: {} as never },
    ],
  }];

  it('the success screen’s own line, word for word', () => {
    expect(paidLineOf(sale, { kind: 'receipt', number: 'Z93401-000002' })).toBe('Receipt Z93401-000002 • ฿1444.50 • Cash');
    expect(paidLineOf(sale, { kind: 'recorded' })).toBe('Recorded — no receipt number yet • ฿1444.50 • Cash');
    expect(src('components/till/StepConfirmation.tsx')).toContain('{paidLineOf(sale, issue.number)}');
  });

  it('under the dialog’s title, where the proof found the screen’s line hidden (picture 02h)', () => {
    const html = plain(renderToStaticMarkup(createElement(DoorCheckInChoiceModal, {
      groups, onCheckInNow: () => undefined, onLeaveAsBooked: () => undefined,
      paidLine: paidLineOf(sale, { kind: 'receipt', number: 'Z93401-000002' }),
    })));
    expect(html).toContain('data-testid="door-check-in-paid"');
    expect(html).toContain('Receipt Z93401-000002 • ฿1444.50 • Cash');
    expect(html.indexOf('Check in the drop-off')).toBeLessThan(html.indexOf('Receipt Z93401-000002'));
    expect(html.indexOf('Receipt Z93401-000002')).toBeLessThan(html.indexOf('Payment is complete.'));
    expect(src('pages/Till.tsx')).toContain('paidLine={shownResult ? paidLineOf(shownResult, saleIssue.number) : null}');
  });

  it('without it the dialog reads as before', () => {
    const html = plain(renderToStaticMarkup(createElement(DoorCheckInChoiceModal, {
      groups, onCheckInNow: () => undefined, onLeaveAsBooked: () => undefined,
    })));
    expect(html.includes('door-check-in-paid')).toBe(false);
    expect(html).toContain('Payment is complete.');
  });
});
