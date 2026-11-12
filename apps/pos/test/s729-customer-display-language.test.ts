import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DisplayCartSchema,
  type DisplayFnbCart,
  type DisplayMerchCart,
  type DisplayTotals,
  type StationSessionDocument,
} from '@oto/shared';
import { cartQuote } from './support/fixtures';
import { FnbCustomerDisplay } from '@/components/fnb/FnbCustomerDisplay';
import { MerchCustomerDisplay } from '@/components/merch/MerchCustomerDisplay';
import { MobileCheckInConsent } from '@/components/mobile/dropoff/MobileCheckInConsent';
import { MobileOrderQrScreen, MobileOrderReviewScreen } from '@/components/mobile/order-station/MobileOrderCustomerScreens';
import { PublicMerchCustomerDisplay } from '@/components/merch/PublicMerchCustomerDisplay';
import { PartySettlementCustomerScreen } from '@/components/parties/PartySettlementCustomerScreen';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { ChildFoodProvisionPicker } from '@/components/shared/ChildFoodProvisionPicker';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { CountryRows, PhoneInput } from '@/components/shared/PhoneInput';
import { PromptPayCustomerScreen } from '@/components/shared/PromptPayCustomerScreen';
import { PublicSavedChildrenReview } from '@/components/shared/PublicSavedChildrenReview';
import { SavedChildrenReview } from '@/components/shared/SavedChildrenReview';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { NumberKeypad } from '@/components/till/NumberKeypad';
import { OrderSummary } from '@/components/till/OrderSummary';
import { PaymentQr } from '@/components/till/PaymentQr';
import { ScreenKeyboard } from '@/components/till/ScreenKeyboard';
import { StepAddTicket } from '@/components/till/StepAddTicket';
import { COUNTRIES, countryName, filterCountries } from '@/data/countries';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupportedLang } from '@/i18n/types';
import {
  breakdownRowLabel,
  customerDiscountDetail,
  customerDiscountTarget,
  customerGrantLabel,
  customerPaymentMethod,
  customerTaxRowLabel,
  customerUnpricedReason,
  displayErrorText,
} from '@/lib/customerDisplayCopy';
import { readTicketDisplayView, ticketDisplayPresentation, type TicketDisplayState } from '@/lib/displaySession';
import { formatDiscountDetail, formatDiscountTarget } from '@/lib/manualDiscount';
import { paymentMethodLabel } from '@/lib/payments';
import { computeLineBreakdown, unpricedLineReason } from '@/lib/pricing';
import { taxRowsOf } from '@/lib/cartWire';
import type { CartLine, ManualDiscount, Sale } from '@/types';

// The add-on grid reads a live store with no server snapshot, and says nothing of what is tested here.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-729 — the labels on the customer's screens follow the customer's language.
 *
 * Kids, Adults and VAT included stayed in English on a Russian display because
 * the rows are built in English by the helpers the staff screens read, and a
 * separate display receives them already captured. So the test that matters runs
 * the whole path: the till's cart, through the presentation it publishes and the
 * reader the display parses it with, onto the customer's screen, in a provider
 * set to each language.
 *
 * And the other half, in the same breath: the staff screen stays in English under
 * that same provider (SCRUM-698).
 */

beforeEach(() => vi.stubGlobal('React', React));
const under = (lang: SupportedLang, element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => lang, setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test', children: element }));
};
afterEach(() => vi.unstubAllGlobals());

/** The way `renderToStaticMarkup` writes an apostrophe. */
const inMarkup = (text: string) => text.replace(/'/g, '&#x27;');

const ticket = {
  id: 'ticket-1', name: '1 Hour Play', durationLabel: '1 hour', hours: 1,
  translations: { ru: { name: 'Игра 1 час' }, th: { name: 'เล่น 1 ชั่วโมง' } },
  prices: { tourist: { weekday: 200, weekend: 300 } },
  adultRules: { tourist: { kind: 'free_adults', freeAdults: 1, overflow: 'same_as_kid' } },
} as unknown as CartLine['ticketType'];

const line: CartLine = {
  id: 'line-1', ticketType: ticket, tier: 'tourist', kids: 2, adults: 2, socks: 1, lineTotal: 790,
  addOns: [{
    id: 'addon-1', name: 'Grip Socks', price: 50, quantity: 1,
    translations: { ru: { name: 'Нескользящие носки' }, th: { name: 'ถุงเท้ากันลื่น' } },
  }],
  dropOff: { service: 'nanny', hours: 2, serviceFeeTHB: 300 },
} as unknown as CartLine;

const discounts = [
  { id: 'd-kids', scope: 'line', targetLineId: 'line-1', targetComponent: { kind: 'kids' }, targetLabel: 'Kids × 2', type: 'percent', value: 10, reason: 'r', amountTHB: 40, appliedBy: 'x', appliedById: 'x', appliedAt: '' },
  { id: 'd-line', scope: 'line', targetLineId: 'line-1', targetLabel: 'Grip Socks', type: 'fixed', value: 50, reason: 'r', amountTHB: 50, appliedBy: 'x', appliedById: 'x', appliedAt: '' },
  { id: 'd-order', scope: 'order', type: 'comp', value: 0, reason: 'r', amountTHB: 100, appliedBy: 'x', appliedById: 'x', appliedAt: '' },
] as unknown as ManualDiscount[];

const sale: Sale = {
  id: 'sale-1', operatorId: 'private', operatorName: 'Private', tier: 'tourist', total: 700, lines: [line],
  manualDiscounts: discounts,
  creditGrants: [
    { id: 'g1', type: 'fnb_credit', label: 'Credit', valueTHB: 100 },
    { id: 'g2', type: 'item', label: 'Regular Socks', quantity: 1 },
    { id: 'g3', type: 'item', label: 'Free: Ice Cream', quantity: 1 },
  ],
  bracelets: { adults: 2, children: 2 }, createdAt: '', status: 'paid', refunds: [],
} as unknown as Sale;

const quote = cartQuote(700).totals;
const totals = {
  ...quote,
  manualAmounts: { 'd-kids': 40, 'd-line': 50, 'd-order': 100 },
  taxBreakdown: {
    ...quote.taxBreakdown, serviceChargeTotal: 20,
    categories: [{
      category: 'tickets', base: 650, taxMode: 'inclusive', taxName: 'VAT', taxPercent: 7, tax: 45.79, serviceCharge: 20,
      secondaryTaxMode: 'exclusive', secondaryTaxName: 'City levy', secondaryTaxPercent: 1, secondaryTax: 6.5, gross: 700,
    }],
  },
} as unknown as typeof quote;

const state = (stage: TicketDisplayState['stage'], step: number): TicketDisplayState => ({
  stage, step, sessionKey: 'sale-0', tier: 'tourist', phone: '', nickname: '', contactChannel: 'whatsapp', member: null,
  sale, totals, rateMode: 'weekday', online: true, voucherPrize: null, nothingToPay: false,
  payment: { saleId: 'sale-1', amountSatang: 70_000, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true },
});

const document = (overrides: Partial<StationSessionDocument>): StationSessionDocument => ({
  stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
  takeoverCount: 0, updatedAt: '2026-11-03T00:00:00.000Z', ...overrides,
} as StationSessionDocument);

/** The till's cart as a paired display receives it, on the customer's screen. */
const onDisplay = (lang: SupportedLang, stage: 'order' | 'thankyou', step: number) => {
  const presented = ticketDisplayPresentation(state(stage, step), 'prompt-1');
  const view = readTicketDisplayView(document(presented as Partial<StationSessionDocument>));
  expect(view, 'the display must accept the captured document').not.toBeNull();
  return under(lang, createElement(CustomerDisplay, {
    stage: view!.stage, sale: view!.sale, phone: '', nickname: '', member: null, totals: view!.totals,
    lineBreakdowns: view!.lineBreakdowns, showGrantQr: false,
    onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
    onCustomerDone: () => undefined,
  }));
};

interface OrderWords {
  kids: string; adults: string; adultsFree: string; socks: string; nanny: string; addOn: string;
  percent: string; fixed: string; comp: string; service: string; vat: string;
}
const WORDS: Record<'en' | 'ru' | 'th', OrderWords> = {
  en: { kids: 'Kids', adults: 'Adults', adultsFree: 'Adults (free)', socks: 'Regular Socks', nanny: 'Nanny (2h)', addOn: 'Grip Socks',
    percent: '10% off', fixed: '฿50 off', comp: 'Comp (100% off)', service: 'Service charge', vat: 'VAT included' },
  ru: { kids: 'Дети', adults: 'Взрослые', adultsFree: 'Взрослые (бесплатно)', socks: 'Обычные носки', nanny: 'Няня (2 ч)', addOn: 'Нескользящие носки',
    percent: 'Скидка 10%', fixed: 'Скидка ฿50', comp: 'Бесплатно (скидка 100%)', service: 'Сервисный сбор', vat: 'Включая НДС' },
  th: { kids: 'เด็ก', adults: 'ผู้ใหญ่', adultsFree: 'ผู้ใหญ่ (ฟรี)', socks: 'ถุงเท้าธรรมดา', nanny: 'พี่เลี้ยง (2 ชม.)', addOn: 'ถุงเท้ากันลื่น',
    percent: 'ลด 10%', fixed: 'ลด ฿50', comp: 'ฟรี (ลด 100%)', service: 'ค่าบริการ', vat: 'รวมภาษีมูลค่าเพิ่ม' },
};
/** English words that must not survive on a screen set to another language. */
const ENGLISH = ['Kids', 'Adults', 'Regular Socks', 'Nanny', 'off<', ' off', 'Comp', 'Service charge', 'included', 'VAT'];

describe.each(['en', 'ru', 'th'] as const)('the ticket order on a paired display, in %s', (lang) => {
  const words = WORDS[lang];

  it('names every row, discount and tax row in that language', () => {
    const html = onDisplay(lang, 'order', 3);
    for (const word of Object.values(words)) expect(html, word).toContain(word);
    expect(html).toContain(lang === 'en' ? '1 Hour Play' : lang === 'ru' ? 'Игра 1 час' : 'เล่น 1 ชั่วโมง');
    // A tax the branch named itself is printed as the branch wrote it.
    expect(html).toContain('City levy');
  });

  it(lang === 'en' ? 'is the English it always was' : 'leaves no English label behind', () => {
    const html = onDisplay(lang, 'order', 3).replace(/City levy/g, '');
    if (lang === 'en') {
      expect(html).toContain('Kids × 2 · 10% off');
      return;
    }
    expect(html).toContain(`${words.kids} × 2 · ${words.percent}`);
    for (const word of ENGLISH) expect(html.includes(word), word).toBe(false);
  });

  it('says what a family was given on the thank-you screen in that language', () => {
    const html = onDisplay(lang, 'thankyou', 6);
    const t = tFor(lang);
    expect(html).toContain(t('display.grant.credit'));
    expect(html).toContain(t('display.row.socks'));
    expect(html).toContain(t('display.grant.free', { name: 'Ice Cream' }));
  });
});

describe('the row helpers, line by line', () => {
  it('in English they are exactly the words the staff helpers print, so the look does not change', () => {
    const t = tFor('en');
    for (const row of computeLineBreakdown(line, 'weekday')) {
      expect(breakdownRowLabel(row, 'en', t)).toBe(row.label);
    }
    for (const row of taxRowsOf(totals.taxBreakdown)) {
      expect(customerTaxRowLabel(row, t)).toBe(row.label);
    }
    for (const discount of discounts) {
      expect(customerDiscountDetail(discount, t)).toBe(formatDiscountDetail(discount));
      expect(customerDiscountTarget(discount, undefined, t)).toBe(formatDiscountTarget(discount));
    }
    const onAddOn = { ...discounts[0]!, targetComponent: { kind: 'addon' as const, addOnId: 'addon-1' }, targetLabel: 'Grip Socks × 3' };
    expect(customerDiscountTarget(onAddOn, 'Grip Socks', t)).toBe(formatDiscountTarget(onAddOn));
    const unpriced = { ticketName: '1 Hour Play', tier: 'tourist', what: 'adult' as const };
    expect(customerUnpricedReason(unpriced, t)).toBe(unpricedLineReason(unpriced));
    expect(customerUnpricedReason({ ...unpriced, what: 'kid' }, t)).toBe(unpricedLineReason({ ...unpriced, what: 'kid' }));
    expect(customerGrantLabel({ label: 'Free item (promo)' }, t)).toBe('Free item (promo)');
  });

  it('Paying by: the configured name in English, the method’s kind in another language', () => {
    expect(customerPaymentMethod('cash', 'en', tFor('en'))).toBe(paymentMethodLabel('cash'));
    expect(customerPaymentMethod('cash', 'ru', tFor('ru'))).toBe('Наличные');
    expect(customerPaymentMethod('cash', 'th', tFor('th'))).toBe('เงินสด');
    expect(customerPaymentMethod('no-such-method', 'ru', tFor('ru'))).toBe('no-such-method');
  });

  it('a drop-off service row, with no hours to carry', () => {
    expect(breakdownRowLabel({ key: 'dropoff-service', label: 'Drop-off service' }, 'ru', tFor('ru'))).toBe('Услуга присмотра');
    expect(breakdownRowLabel({ key: 'dropoff-service', label: 'Drop-off service' }, 'th', tFor('th'))).toBe('บริการรับฝากเด็ก');
  });

  it('an add-on with no translation for the language keeps the name it was sold under', () => {
    const row = { key: 'addon-2', label: 'Face Paint', translations: { th: 'เพ้นท์หน้า' } };
    expect(breakdownRowLabel(row, 'th', tFor('th'))).toBe('เพ้นท์หน้า');
    expect(breakdownRowLabel(row, 'ru', tFor('ru'))).toBe('Face Paint');
  });

  it('an add-on’s variant summary comes with its translated name', () => {
    const withSizes = { ...line, dropOff: undefined, kids: 0, adults: 0, socks: 0, addOns: [{
      ...line.addOns[0]!, variantBreakdown: [{ variantId: 'v', label: 'M', qty: 2 }],
    }] } as unknown as CartLine;
    const [row] = computeLineBreakdown(withSizes, 'weekday');
    expect(row!.label).toMatch(/^Grip Socks \(.+\)$/);
    expect(row!.translations?.ru).toBe(`Нескользящие носки ${row!.label.slice('Grip Socks '.length)}`);
  });

  it('crosses the wire with the row, and a publisher that sends none still parses', () => {
    const presented = ticketDisplayPresentation(state('order', 3), 'prompt-1');
    const parsed = DisplayCartSchema.parse(presented.cart);
    const row = parsed.sale.lines[0]!.breakdown.rows.find((r) => r.key === 'addon-1')!;
    expect(row.translations?.th).toBe('ถุงเท้ากันลื่น');
    const { translations: _translations, ...older } = row;
    expect(breakdownRowLabel(older, 'th', tFor('th'))).toBe('Grip Socks');
  });

  it('keeps the platform’s English sentence in English, and tells another language what to do', () => {
    const sentence = 'Connection interrupted. Please retry when the connection returns.';
    expect(displayErrorText(sentence, 'en', tFor('en'))).toBe(sentence);
    expect(displayErrorText(sentence, 'ru', tFor('ru'))).toBe('Пожалуйста, попробуйте ещё раз.');
    expect(displayErrorText(sentence, 'th', tFor('th'))).toBe('กรุณาลองอีกครั้ง');
  });
});

const displayTotals: DisplayTotals = {
  manualAmounts: { 'd-line': 10, 'd-order': 20 }, discountAmount: 0, total: 90,
  taxBreakdown: { serviceChargeTotal: 5, categories: [{ taxMode: 'inclusive', taxName: 'VAT', tax: 5.89, secondaryTaxMode: 'none', secondaryTax: 0 }] },
};
const fnbCart: DisplayFnbCart = {
  kind: 'fnb', supported: true, orderNote: '', completion: null,
  lines: [{ id: 'l', name: 'Fries', qty: 2, basePrice: 40, lineTotal: 100, translations: { ru: 'Картофель фри', th: 'เฟรนช์ฟรายส์' },
    modifiers: [{ groupName: 'Sauce', optionName: 'Ketchup', price: 0 }] }],
  manualDiscounts: [
    { id: 'd-line', scope: 'line', targetLineId: 'l', type: 'percent', value: 10 },
    { id: 'd-order', scope: 'order', type: 'fixed', value: 20 },
  ],
};
const merchCart: DisplayMerchCart = {
  kind: 'merch', supported: true, completion: null,
  lines: [{ id: 'l', name: 'T-Shirt', qty: 1, unitPrice: 90, lineTotal: 90 }],
  manualDiscounts: [
    { id: 'd-line', scope: 'line', targetLineId: 'l', type: 'comp', value: 0 },
    { id: 'd-order', scope: 'order', type: 'percent', value: 10 },
  ],
};

const SHOP: Record<'en' | 'ru' | 'th', { each: string; eachTimes: string; base: string; free: string; percent: string; fixed: string; comp: string; vat: string; service: string }> = {
  en: { each: '฿90 each', eachTimes: '฿50 each × 2', base: '฿40 base', free: 'free', percent: '10% off', fixed: '฿20 off', comp: 'Comp (100% off)', vat: 'VAT included', service: 'Service charge' },
  ru: { each: '฿90 за шт.', eachTimes: '฿50 за шт. × 2', base: 'Базовая цена ฿40', free: 'бесплатно', percent: 'Скидка 10%', fixed: 'Скидка ฿20', comp: 'Бесплатно (скидка 100%)', vat: 'Включая НДС', service: 'Сервисный сбор' },
  th: { each: 'ชิ้นละ ฿90', eachTimes: 'ชิ้นละ ฿50 × 2', base: 'ราคาเริ่มต้น ฿40', free: 'ฟรี', percent: 'ลด 10%', fixed: 'ลด ฿20', comp: 'ฟรี (ลด 100%)', vat: 'รวมภาษีมูลค่าเพิ่ม', service: 'ค่าบริการ' },
};

describe.each(['en', 'ru', 'th'] as const)('F&B and the shop on a customer’s screen, in %s', (lang) => {
  const words = SHOP[lang];

  it('F&B: the base price, the per-unit line, a free option, discounts and tax rows', () => {
    const html = under(lang, createElement(FnbCustomerDisplay, { stage: 'order', presentation: { cart: fnbCart, totals: displayTotals } }));
    for (const word of [words.base, words.eachTimes, words.free, words.percent, words.fixed, words.vat, words.service]) {
      expect(html, word).toContain(word);
    }
    if (lang !== 'en') {
      for (const word of [' base', ' each', '>free<', ' off', 'VAT', 'Service charge']) expect(html.includes(word), word).toBe(false);
    }
  });

  it('the shop, as a paired display draws it: the unit price, discounts and tax rows', () => {
    const html = under(lang, createElement(PublicMerchCustomerDisplay, { stage: 'order', cart: merchCart, totals: displayTotals }));
    for (const word of [words.each, words.comp, words.percent, words.vat, words.service]) expect(html, word).toContain(word);
    if (lang !== 'en') {
      for (const word of [' each', ' off', 'Comp', 'VAT', 'Service charge']) expect(html.includes(word), word).toBe(false);
    }
  });

  it('the shop, as the till’s own panel draws it, with the name on the credit chip', () => {
    const html = under(lang, createElement(MerchCustomerDisplay, {
      stage: 'order', wristband: { id: 'w', code: 'c', customerNickname: 'Anna', creditBalanceTHB: 50, gateAccess: false } as never,
      lines: [{ id: 'l', qty: 1, lineTotal: 90, merchItem: { id: 'm', name: 'T-Shirt', price: { weekday: 90, weekend: 90 } } }] as never,
      manualDiscounts: [{ id: 'o', scope: 'order', type: 'percent', value: 10, reason: 'r', amountTHB: 9, appliedBy: 'x', appliedById: 'x', appliedAt: '' }],
      total: 81, taxBreakdown: { ...quote.taxBreakdown, serviceChargeTotal: 5 }, promptpayAmount: null, completedOrder: null, newBalance: null,
    }));
    expect(html).toContain(inMarkup(tFor(lang)('display.credit.of', { name: 'Anna' })));
    expect(html).toContain(tFor(lang)('display.price.each', { price: 90 }));
    expect(html).toContain(words.percent);
    expect(html).toContain(words.service);
  });

  it('the shop’s last resort tells a guest where to look, in that language', () => {
    const html = under(lang, createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart: merchCart }));
    expect(html).toContain(tFor(lang)('display.idle.followStaff'));
  });
});

const slot = { id: 's1', savedChildId: 'c1', name: 'Mai', age: '6' };
const reviewProps = {
  slots: [slot], savedChildren: [{ id: 'c1', childName: 'Mai', childAge: 6 }], confirmedIds: [],
  onUpdateSlot: () => undefined, onConfirmSlot: () => undefined, onAssignSaved: () => undefined,
  onMarkNew: () => undefined, onRemoveSaved: () => undefined, onBack: () => undefined, onContinue: () => undefined, canContinue: false,
};
const consentProps = {
  slots: [{ id: 's1', name: 'Mai', age: '6', waived: false, optIn: false }],
  parentName: '', consentAck: false,
  policy: {
    bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'nanny' }],
    siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [],
  },
  onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
  acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
} as never;

describe.each(['ru', 'th'] as const)('the supervised-child screens on the customer’s half, in %s', (lang) => {
  const t = tFor(lang);

  it('the saved-children review, named by the customer’s language', () => {
    const html = under(lang, createElement(SavedChildrenReview, { ...reviewProps, lang }));
    for (const key of ['childReview.welcomeBack', 'childReview.titleOne', 'childReview.subtitle', 'childReview.stillCorrect', 'common.confirm', 'childReview.noteMember', 'common.back', 'common.continue']) {
      expect(html, key).toContain(t(key));
    }
    expect(html).toContain(t('childReview.childN', { n: 1 }));
    expect(html).toContain(t('childReview.ageOption', { name: 'Mai', age: 6 }));
    for (const word of ['Welcome back', 'still your child', 'Confirm', 'Back', 'Continue', 'Full name', 'yrs']) expect(html.includes(word), word).toBe(false);
  });

  it('the review as a paired display draws it', () => {
    const prompt = {
      kind: 'child_review', requestId: 'r', visitorId: 'v', referenceDate: '2026-11-03', canContinue: false,
      slots: [{ id: 's1', savedChildId: 'c1', name: 'Mai', dateOfBirth: null, ageYears: 6, confirmed: false }],
      choices: [{ id: 'c1', name: 'Mai', dateOfBirth: null, ageYears: 6 }],
      save: { status: 'failed', slotId: 's1', actionId: 'a' },
    } as never;
    const html = under(lang, createElement(PublicSavedChildrenReview, { prompt, busy: false, onAction: () => undefined }));
    for (const key of ['childReview.saveFailed', 'childReview.retrySave', 'childReview.subtitlePublic', 'childReview.notePublic', 'childReview.continueOnStaff', 'common.done']) {
      expect(html, key).toContain(t(key));
    }
  });

  it('the date-of-birth picker’s closed face, and the months it opens on', () => {
    expect(under(lang, createElement(ChildDobPicker, { lang, onChange: () => undefined }))).toContain(t('dob.tapToSet'));
    expect(under(lang, createElement(ChildDobPicker, { lang, age: 6, onChange: () => undefined }))).toContain(t('dob.yrs'));
    expect(new Set(Array.from({ length: 12 }, (_, i) => t(`dob.month.${i + 1}`))).size).toBe(12);
  });

  it('the food choice and the camera', () => {
    const food = under(lang, createElement(ChildFoodProvisionPicker, {
      lang, childName: 'Mai', value: { mode: 'none', paidTHB: 0 }, onChange: () => undefined,
    }));
    for (const key of ['food.none', 'food.prepaidCredit', 'food.chooseItems']) expect(food, key).toContain(t(key));
    expect(food).toContain(t('food.noneNote', { name: 'Mai' }));
    const camera = under(lang, createElement(CameraCapture, { lang, onCapture: () => undefined }));
    for (const key of ['camera.noPhoto', 'camera.start']) expect(camera, key).toContain(t(key));
  });

  it('the consent screen hands its language to the picker inside it', () => {
    const html = under(lang, createElement(ConsentCapture, consentProps));
    expect(html).toContain(t('superviseConsent.childName'));
    expect(html).toContain(t('dob.yrs'));
    expect(html.includes('>yrs<')).toBe(false);
  });

  it('the on-screen keyboard’s space bar and the language pill’s name', () => {
    const keyboard = renderToStaticMarkup(createElement(ScreenKeyboard, {
      value: '', onChange: () => undefined, onDone: () => undefined, doneLabel: t('common.done'), spaceLabel: t('display.keyboard.space'),
      backspaceLabel: t('display.keyboard.backspace'),
    }));
    expect(keyboard).toContain(t('display.keyboard.space'));
    expect(keyboard).toContain(`aria-label="${t('display.keyboard.backspace')}"`);
    expect(under(lang, createElement(LanguageSwitcher, { variant: 'dark' }))).toContain(`aria-label="${t('common.changeLanguage')}"`);
  });

  it('a party’s Thai QR screen and the extra-charge subtotal', () => {
    const qr = under(lang, createElement(PromptPayCustomerScreen, { amount: 100, qrPayload: 'zz' }));
    for (const key of ['fnb.payment.thaiQrPromptpay', 'till.payment.scanToPay', 'till.payment.openBankingApp', 'till.payment.waitingConfirmation']) {
      expect(qr, key).toContain(t(key));
    }
    expect(qr).toContain(`aria-label="${t('display.qr.waiting')}"`);
    expect(qr.includes(t('till.payment.codePending'))).toBe(false);
    // Before the payment route has answered there is no code yet, and the screen says so in the same language.
    const pending = under(lang, createElement(PromptPayCustomerScreen, { amount: 100 }));
    expect(pending).toContain(t('till.payment.codePending'));
    expect(pending.includes(t('till.payment.openBankingApp'))).toBe(false);
    const review = under(lang, createElement(PartySettlementCustomerScreen, {
      stage: 'review', amount: 100,
      party: {
        id: 'p', basePrice: 100, deposit: 0, partyPayments: [], lineItems: [], packageName: 'Party',
        partyExtraCharges: [{ id: 'x', kind: 'fnb', items: [{ name: 'Fries', qty: 1, lineTotal: 90 }], total: 90 }],
      } as never,
    }));
    expect(review).toContain(t('party.review.extraFnb'));
  });
});

const SEEN: Record<'en' | 'ru' | 'th', {
  clear: string; backspace: string; turning: string; thailand: string; france: string;
  yourOrder: string; review: string; pickup: string; credit: string; available: string; total: string; scan: string; fries: string; waitingQr: string;
}> = {
  en: { clear: 'Clear', backspace: 'Backspace', turning: 'turning 6', thailand: 'Thailand', france: 'France',
    yourOrder: 'Your Order', review: 'Please review your items and total below.', pickup: 'Pick-up code', credit: 'Credit', available: '฿50 available', total: 'Total', scan: 'Scan to pay', fries: 'Fries', waitingQr: 'Waiting for payment QR' },
  ru: { clear: 'Очистить', backspace: 'Стереть', turning: 'исполняется 6', thailand: 'Таиланд', france: 'Франция',
    yourOrder: 'Ваш заказ', review: 'Пожалуйста, проверьте позиции и итог ниже.', pickup: 'Код получения', credit: 'Кредит', available: 'Доступно ฿50', total: 'Итого', scan: 'Сканируйте для оплаты', fries: 'Картофель фри', waitingQr: 'Ожидание QR-кода для оплаты' },
  th: { clear: 'ล้าง', backspace: 'ลบตัวอักษร', turning: 'อายุครบ 6 ปี', thailand: 'ไทย', france: 'ฝรั่งเศส',
    yourOrder: 'คำสั่งซื้อของคุณ', review: 'กรุณาตรวจสอบรายการและยอดรวมด้านล่าง', pickup: 'รหัสรับสินค้า', credit: 'เครดิต', available: 'ใช้ได้ ฿50', total: 'ยอดรวม', scan: 'สแกนเพื่อชำระเงิน', fries: 'เฟรนช์ฟรายส์', waitingQr: 'กำลังรอคิวอาร์สำหรับชำระเงิน' },
};

describe.each(['en', 'ru', 'th'] as const)('the keys and hand-over screens a family touches, in %s', (lang) => {
  const words = SEEN[lang];
  const t = tFor(lang);
  const qrPayment = { saleId: 's', amountSatang: 9_000, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'pending', offline: false, online: true } as const;

  it.each(['identify', 'input'] as const)('the phone keypad on the %s stage', (stage) => {
    const html = under(lang, createElement(CustomerDisplay, {
      stage, sale, phone: '', nickname: '', member: null, totals, showGrantQr: false,
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
      onCustomerDone: () => undefined,
    }));
    expect(html).toContain(`>${words.clear}</button>`);
    expect(html).toContain(`aria-label="${words.backspace}"`);
    if (lang !== 'en') {
      expect(html.includes('>Clear<')).toBe(false);
      expect(html.includes('aria-label="Backspace"')).toBe(false);
    }
  });

  it('the party bill says who is turning what', () => {
    const html = under(lang, createElement(PartySettlementCustomerScreen, {
      stage: 'review', amount: 100,
      party: { id: 'p', title: 'Mali party', childName: 'Mali', kidAge: 6, basePrice: 100, deposit: 0, partyPayments: [], lineItems: [], packageName: 'Party', partyExtraCharges: [] } as never,
    }));
    expect(html).toContain(`Mali · ${words.turning}`);
    if (lang !== 'en') expect(html.includes('turning')).toBe(false);
  });

  it('a party with no age says none', () => {
    const html = under(lang, createElement(PartySettlementCustomerScreen, {
      stage: 'review', amount: 100,
      party: { id: 'p', title: 'Mali party', childName: 'Mali', basePrice: 100, deposit: 0, partyPayments: [], lineItems: [], packageName: 'Party', partyExtraCharges: [] } as never,
    }));
    expect(html.includes(words.turning)).toBe(false);
    expect(html.includes('Mali · ')).toBe(false);
  });

  it('the parent’s check-in on a handed-over phone: the camera follows the heading', () => {
    const html = under(lang, createElement(MobileCheckInConsent, {
      checkIn: { childName: 'Mai', childAge: 6 } as never, mayOrderFood: false, consentAck: false,
      onPhotoCapture: () => undefined, onPhotoClear: () => undefined, onMayOrderFoodChange: () => undefined, onConsentAckChange: () => undefined,
    }));
    expect(html).toContain(t('dropoff.consent.photoTitle'));
    for (const key of ['camera.noPhoto', 'camera.start']) expect(html, key).toContain(t(key));
    if (lang !== 'en') for (const word of ['No photo yet', 'Start camera']) expect(html.includes(word), word).toBe(false);
  });

  it('the order station’s review on a handed-over phone', () => {
    const html = under(lang, createElement(MobileOrderReviewScreen, {
      pickupCode: '042', creditBalance: 50, total: 90,
      lines: [{ id: 'l', qty: 2, lineTotal: 90, selectedModifiers: [], note: 'no salt', menuItem: {
        id: 'm', name: 'Fries', translations: { ru: { name: 'Картофель фри' }, th: { name: 'เฟรนช์ฟรายส์' } },
      } }] as never,
    }));
    for (const word of [words.yourOrder, words.review, words.pickup, words.credit, words.available, words.total, words.fries]) expect(html, word).toContain(word);
    expect(html).toContain('042');
    // What a guest typed is printed as they typed it.
    expect(html).toContain('no salt');
    if (lang !== 'en') {
      for (const word of ['Your Order', 'Please review', 'Pick-up code', '>Credit<', 'available', '>Total<', 'Fries']) expect(html.includes(word), word).toBe(false);
    }
  });

  it('no credit, no pick-up code: those rows stay away', () => {
    const html = under(lang, createElement(MobileOrderReviewScreen, { pickupCode: '', creditBalance: 0, total: 0, lines: [] }));
    for (const word of [words.pickup, words.credit, words.available]) expect(html.includes(word), word).toBe(false);
  });

  it('the order station’s QR on a handed-over phone, the code’s name included', () => {
    const html = under(lang, createElement(MobileOrderQrScreen, { pickupCode: '042', payment: qrPayment, showCode: true }));
    for (const word of [words.scan, words.pickup, t('fnb.payment.waiting')]) expect(html, word).toContain(word);
    expect(html).toContain(`aria-label="${words.waitingQr}"`);
    if (lang !== 'en') {
      for (const word of ['Scan to pay', 'Pick-up code', 'Waiting for payment QR']) expect(html.includes(word), word).toBe(false);
    }
  });

  it('with no attempt running, the QR screen shows no code', () => {
    const html = under(lang, createElement(MobileOrderQrScreen, { pickupCode: '', payment: { ...qrPayment, status: 'idle' }, showCode: false }));
    expect(html.includes('payment-qr')).toBe(false);
    expect(html).toContain(t('till.payment.checking'));
  });

  it('the QR on the till’s customer display is named in that language', () => {
    const html = under(lang, createElement(CustomerDisplay, {
      stage: 'payment', sale: { ...sale, paymentMethod: 'promptpay' }, phone: '', nickname: '', member: null, totals, showGrantQr: false,
      payment: { ...qrPayment, qrImageUrl: 'https://example.test/qr.png' },
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
      onCustomerDone: () => undefined,
    } as never));
    expect(html).toContain(`alt="${t('display.qr.ready')}"`);
    if (lang !== 'en') expect(html.includes('alt="Payment QR"')).toBe(false);
  });

  it('the country picker’s rows, ordered and searched in that language', () => {
    const html = under(lang, createElement(CountryRows, {
      query: '', lang, selected: COUNTRIES[0]!, noResultsLabel: t('phoneInput.noResults'), onSelect: () => undefined,
    }));
    for (const word of [words.thailand, words.france]) expect(html, word).toContain(word);
    expect(html.indexOf(words.thailand)).toBeLessThan(html.indexOf(words.france));
    expect(filterCountries('', lang)[0]?.iso2, 'Thailand first and the default').toBe('TH');
    for (const query of [words.france, 'France', '+33']) {
      expect(filterCountries(query, lang).map((country) => country.iso2), query).toContain('FR');
    }
    const empty = under(lang, createElement(CountryRows, {
      query: 'zzzz', lang, selected: COUNTRIES[0]!, noResultsLabel: t('phoneInput.noResults'), onSelect: () => undefined,
    }));
    expect(empty).toContain(t('phoneInput.noResults'));
  });
});

describe('a country the runtime cannot name', () => {
  it('keeps the list’s own name, and the English list keeps its order after another language is read', () => {
    const before = COUNTRIES.map((country) => country.iso2);
    filterCountries('', 'ru');
    filterCountries('', 'th');
    expect(COUNTRIES.map((country) => country.iso2)).toEqual(before);
    expect(filterCountries('', 'en').map((country) => country.iso2)).toEqual(before);
    expect(countryName({ name: 'Nowhere', dialCode: '0', flag: '', iso2: 'not-a-region' }, 'ru')).toBe('Nowhere');
    expect(countryName({ name: 'Nowhere', dialCode: '0', flag: '', iso2: 'ZZ' }, 'en')).toBe('Nowhere');
  });
});

describe('the staff screen stays in English under a Russian or Thai provider (SCRUM-698)', () => {
  const summaryProps = {
    tier: 'tourist', lines: [{ ...line, dropOff: undefined }], discounts: [], manualDiscounts: [], onUpdateLine: () => undefined,
    onRemoveLine: () => undefined, onRemoveDiscount: () => undefined, totals: { ...totals, manualAmounts: {} },
  } as never;

  it.each(['ru', 'th'] as const)('the order panel in %s', (lang) => {
    const html = under(lang, createElement(OrderSummary, summaryProps));
    for (const word of ['Kids', 'Adults', 'VAT included']) expect(html, word).toContain(word);
    for (const word of [WORDS[lang].kids, WORDS[lang].adults, WORDS[lang].vat]) expect(html.includes(word), word).toBe(false);
  });

  it.each(['ru', 'th'] as const)('the Configure step in %s', (lang) => {
    const html = under(lang, createElement(StepAddTicket, {
      tier: 'tourist', activeLine: { ...line, dropOff: undefined }, hasLines: true, onSelectTicket: () => undefined,
      onUpdateLine: () => undefined, onAddDropOff: () => undefined, onBackToGrid: () => undefined, onDone: () => undefined,
    } as never));
    for (const word of ['Kids', 'Adults', 'Participants', 'Requires adult supervision']) expect(html, word).toContain(word);
    for (const word of [WORDS[lang].kids, WORDS[lang].adults]) expect(html.includes(word), word).toBe(false);
  });

  it.each(['ru', 'th'] as const)('the saved-children review on the staff half names no language, in %s', (lang) => {
    const html = under(lang, createElement(SavedChildrenReview, reviewProps));
    for (const word of ['Welcome back', 'Is this still your child?', 'Confirm', 'Back', 'Continue', 'Full name', 'Remove from saved']) {
      expect(html, word).toContain(word);
    }
    expect(html).toContain('Mai (age 6)');
    expect(html).toContain('yrs');
  });

  it.each(['ru', 'th'] as const)('the till’s private consent dialog, in %s', (lang) => {
    const html = under(lang, createElement(ConsentCapture, { ...(consentProps as object), staffScreen: true } as never));
    expect(html).toContain(inMarkup("Child's name"));
    expect(html).toContain('yrs');
    expect(html.includes(tFor(lang)('superviseConsent.childName'))).toBe(false);
  });

  it.each(['ru', 'th'] as const)('the keypad and the phone field on a staff screen, in %s', (lang) => {
    const keypad = under(lang, createElement(NumberKeypad, { value: '', onChange: () => undefined }));
    expect(keypad).toContain('>Clear</button>');
    expect(keypad).toContain('aria-label="Backspace"');
    const phone = under(lang, createElement(PhoneInput, { value: '', onChange: () => undefined, showKeypad: true }));
    expect(phone).toContain('>Clear</button>');
    expect(phone).toContain('aria-label="Backspace"');
    expect(phone).toContain('Phone Number');
    expect(phone.includes(SEEN[lang].clear)).toBe(false);
    const source = readFileSync(path.resolve(import.meta.dirname, '..', 'src/components/shared/PhoneInput.tsx'), 'utf8');
    expect(source).toContain("lang={translate ? lang : 'en'}");
  });

  it.each(['ru', 'th'] as const)('the QR on the staff panel names itself in English, in %s', (lang) => {
    expect(under(lang, createElement(PaymentQr, {}))).toContain('aria-label="Waiting for payment QR"');
    expect(under(lang, createElement(PaymentQr, { imageUrl: 'https://example.test/qr.png' }))).toContain('alt="Payment QR"');
  });

  it('the order station draws the hand-over from the customer’s screens', () => {
    const station = readFileSync(path.resolve(import.meta.dirname, '..', 'src/components/mobile/order-station/MobileOrderStation.tsx'), 'utf8');
    expect(station).toContain('<MobileOrderReviewScreen');
    expect(station).toContain('<MobileOrderQrScreen');
    for (const word of ['Please review your items', 'Scan to pay</p>', '>Pick-up code<']) expect(station.includes(word), word).toBe(false);
  });

  it('nothing on the staff panel’s path reads the language, and the rows it reads stay English', () => {
    const source = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');
    for (const file of ['components/till/OrderSummary.tsx', 'components/till/StepAddTicket.tsx']) {
      expect(source(file), file).not.toMatch(/useLanguage|customerDisplayCopy/);
    }
    expect(computeLineBreakdown(line, 'weekday').map((row) => row.label)).toEqual(expect.arrayContaining(['Kids', 'Adults', 'Regular Socks', 'Grip Socks']));
    expect(taxRowsOf(totals.taxBreakdown).map((row) => row.label)).toEqual(['Service charge', 'VAT included', 'City levy']);
  });

  it('the till passes the customer’s language to the customer’s half only', () => {
    const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src/pages/Till.tsx'), 'utf8');
    expect(till).toContain('{reviewSaveNotice(tFor(\'en\'))}<SavedChildrenReview');
    expect(till).toMatch(/\{reviewSaveNotice\(customerT\)\}\s+<SavedChildrenReview\s+lang=\{customerLang\}/);
    expect(till).toMatch(/<ConsentCapture staffScreen slots=/);
    expect((till.match(/lang=\{customerLang\}/g) ?? [])).toHaveLength(1);
  });
});

describe('the words themselves', () => {
  const OWN_KEYS = Object.keys(DICTIONARY).filter((key) =>
    /^(display\.|childReview\.|dob\.|food\.|camera\.)/.test(key) || ['common.changeLanguage', 'common.confirm', 'party.review.extraTickets', 'party.review.extraFnb'].includes(key));

  it('every label added for this has all five languages, and only a word that is the same in both may match English', () => {
    expect(OWN_KEYS.length).toBeGreaterThan(70);
    for (const key of OWN_KEYS) {
      const entry = DICTIONARY[key]!;
      for (const lang of ['en', 'zh', 'th', 'ru', 'fr'] as const) expect(entry[lang], `${key} ${lang}`).toBeTruthy();
      for (const lang of ['zh', 'th', 'ru'] as const) expect(entry[lang], `${key} ${lang}`).not.toBe(entry.en);
    }
    expect(OWN_KEYS.filter((key) => DICTIONARY[key]!.fr === DICTIONARY[key]!.en)).toEqual([]);
  });

  it('a placeholder keeps its name in every language', () => {
    for (const key of OWN_KEYS) {
      const names = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort().join();
      const entry = DICTIONARY[key]!;
      for (const lang of ['zh', 'th', 'ru', 'fr'] as const) expect(names(entry[lang]), `${key} ${lang}`).toBe(names(entry.en));
    }
  });

  it('the paired display’s own two notices are no longer English in every language', () => {
    for (const key of ['display.reconnecting', 'display.connectionPaused']) {
      for (const lang of ['zh', 'th', 'ru', 'fr'] as const) expect(tFor(lang)(key), `${key} ${lang}`).not.toBe(tFor('en')(key));
    }
  });

  it('every key a customer screen asks for answers in every language, and only a name or a shared word reads like English', () => {
    const files = [
      'components/till/CustomerDisplay.tsx', 'components/till/CustomerLanguageChoice.tsx', 'components/fnb/FnbCustomerDisplay.tsx', 'components/merch/MerchCustomerDisplay.tsx',
      'components/merch/PublicMerchCustomerDisplay.tsx', 'components/till/PublicConsentCapture.tsx', 'components/till/ConsentCapture.tsx',
      'components/shared/PublicSavedChildrenReview.tsx', 'components/shared/SavedChildrenReview.tsx', 'components/shared/PromptPayCustomerScreen.tsx',
      'components/parties/PartySettlementCustomerScreen.tsx', 'components/shared/PhoneInput.tsx', 'components/shared/ChildDobPicker.tsx',
      'components/shared/ChildFoodProvisionPicker.tsx', 'components/shared/CameraCapture.tsx', 'pages/Display.tsx', 'lib/customerDisplayCopy.ts',
      'components/mobile/order-station/MobileOrderCustomerScreens.tsx', 'components/mobile/dropoff/MobileCheckInConsent.tsx',
      // SCRUM-857 — the family's photo block on the paired display.
      'components/till/DisplayChildPhoto.tsx',
    ];
    const keys = new Set<string>();
    for (const file of files) {
      const raw = readFileSync(path.resolve(import.meta.dirname, '..', 'src', file), 'utf8');
      for (const match of raw.matchAll(/\bt\('([\w.]+)'/g)) keys.add(match[1]!);
      for (const match of raw.matchAll(/[?:] '([a-z]+\.[\w.]+)'/g)) keys.add(match[1]!);
    }
    expect(keys.size).toBeGreaterThan(200);
    const reads: string[] = [];
    for (const key of keys) {
      const english = tFor('en')(key);
      expect(english, key).not.toBe(key);
      for (const lang of ['zh', 'th', 'ru', 'fr'] as const) {
        const said = tFor(lang)(key);
        expect(said, `${key} ${lang}`).not.toBe(key);
        if (said === english) reads.push(`${key} ${lang}`);
      }
    }
    expect(reads.sort()).toEqual([
      'common.brand fr', 'common.brand ru', 'common.thaiQrPromptpay ru', 'common.total fr',
      'fnb.payment.thaiQrPromptpay ru', 'merch.payment.thaiQrPromptpay ru', 'party.review.total fr',
    ]);
  });

  it('no customer screen draws a word of its own in English any more', () => {
    const files = [
      'components/till/CustomerDisplay.tsx', 'components/till/CustomerLanguageChoice.tsx', 'components/fnb/FnbCustomerDisplay.tsx', 'components/merch/MerchCustomerDisplay.tsx',
      'components/merch/PublicMerchCustomerDisplay.tsx', 'components/till/PublicConsentCapture.tsx',
      'components/shared/PublicSavedChildrenReview.tsx', 'components/shared/PromptPayCustomerScreen.tsx',
      'components/parties/PartySettlementCustomerScreen.tsx', 'components/till/NumberKeypad.tsx', 'components/till/PaymentQr.tsx',
      'components/mobile/order-station/MobileOrderCustomerScreens.tsx', 'components/mobile/dropoff/MobileCheckInConsent.tsx',
      'components/till/DisplayChildPhoto.tsx',
    ];
    const jsxWord = /(?<=[>}])\s*([A-Z]?[a-z]{2,}(?: [a-z']+)*)\s*(?=[<{])/g;
    // A word inside a template literal, once class lists and the expressions it holds are set aside.
    const templateWords = (source: string): string[] => [...source.replace(/className=\{`[^`]*`\}/g, '').matchAll(/`([^`]*)`/g)]
      .flatMap((match) => match[1]!.replace(/\$\{[^}]*\}/g, ' ').match(/(?<![-\w])[A-Za-z]{3,}(?![-\w])/g) ?? []);
    // It would have found what this ticket fixed.
    expect([...'<div>฿{price} each</div>'.matchAll(jsxWord)].map((match) => match[1])).toEqual(['each']);
    expect([...'<p>Please wait</p>'.matchAll(jsxWord)].map((match) => match[1])).toEqual(['Please wait']);
    expect([...'<button>\n  Clear\n</button>'.matchAll(jsxWord)].map((match) => match[1])).toEqual(['Clear']);
    expect(templateWords('{age ? ` · turning ${age}` : ""}')).toEqual(['turning']);
    expect(templateWords('<div className={`flex gap-4 ${on ? 1 : 2}`} seed={`promptpay-${id}`} />')).toEqual([]);
    for (const file of files) {
      const raw = readFileSync(path.resolve(import.meta.dirname, '..', 'src', file), 'utf8');
      // Comments and the code above the first JSX are not drawn.
      const drawn = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/=>\s*\w+[^<\n]*</g, '');
      const found = [...drawn.matchAll(jsxWord)].map((match) => match[1]!.trim()).filter((word) => !/^(?:div|span|const|return|key|typeof)$/.test(word));
      expect(found, file).toEqual([]);
      expect(templateWords(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), file).toEqual([]);
    }
  });
});
