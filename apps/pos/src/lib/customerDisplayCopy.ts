import type { TFunction } from '@/i18n/LanguageContext';
import type { SupportedLang } from '@/i18n/types';
import { tierLabel } from '@/lib/membership';
import { paymentMethodKind, paymentMethodLabel } from '@/lib/payments';
import type { CustomerTier } from '@/types';

/**
 * THE WORDS A CUSTOMER'S SCREEN PUTS ON A ROW (SCRUM-729).
 *
 * The rows themselves are built once, in English, by helpers the staff screens
 * read too (`computeLineBreakdown`, `taxRowsOf`, `formatDiscountDetail`), and a
 * separate display receives them already captured from the till. So the label on
 * a row is English by the time it reaches a customer's screen, and the row's key
 * is what says what it is. These read the key, in the customer's language, on the
 * customer's screens only. The helpers underneath stay as they were, and the
 * staff screens keep reading them: that is what keeps the till in English
 * whatever the display beside it is set to (SCRUM-698).
 *
 * Every wording here is the same as the English row it stands in for, so in
 * English nothing on the screen changes.
 */

interface BreakdownRow {
  key: string;
  label: string;
  translations?: Partial<Record<SupportedLang, string | undefined>>;
}

/**
 * A ticket breakdown row. An add-on is catalogue data: its translated name when
 * it has one, and the name it was sold under when it has not.
 */
export function breakdownRowLabel(row: BreakdownRow, lang: SupportedLang, t: TFunction): string {
  switch (row.key) {
    case 'kids':
      return t('book.tickets.kids');
    case 'adults':
      return t('book.tickets.adults');
    case 'adults-free':
      return t('display.row.adultsFree');
    case 'socks':
      return t('display.row.socks');
    case 'dropoff-service': {
      // `Nanny (2h)` on the wire: the hours are in the label and nowhere else.
      const nanny = /^Nanny \((.+)h\)$/.exec(row.label);
      return nanny ? t('display.row.nanny', { hours: nanny[1]! }) : t('display.row.dropOffService');
    }
    default:
      return row.translations?.[lang] ?? row.label;
  }
}

interface TaxRow {
  key: string;
  label: string;
  kind: 'service' | 'tax_included' | 'tax_added';
}

/**
 * `service`, `inclusive:VAT` or `exclusive:VAT`, from `summarizeTax`. A branch
 * names its own taxes: the two names the platform itself uses are translated,
 * and any other is printed the way the branch wrote it.
 */
export function customerTaxRowLabel(row: TaxRow, t: TFunction): string {
  if (row.kind === 'service') return t('display.tax.service');
  const configured = row.key.slice(row.key.indexOf(':') + 1);
  const name =
    configured === 'VAT' ? t('display.tax.vat') : configured === 'Tax' ? t('display.tax.tax') : configured;
  return row.kind === 'tax_included' ? t('display.tax.included', { name }) : name;
}

/** "10% off", "฿50 off", "Comp (100% off)": `formatDiscountDetail`, for the customer. */
export function customerDiscountDetail(
  discount: { type: 'percent' | 'fixed' | 'comp'; value: number },
  t: TFunction,
): string {
  if (discount.type === 'comp') return t('display.discount.comp');
  return t(discount.type === 'percent' ? 'display.discount.percent' : 'display.discount.fixed', {
    value: discount.value,
  });
}

/**
 * What a line discount applies to: `formatDiscountTarget`, for the customer. Staff
 * chose it by the row's label with its count (`Kids × 2`). The component says which
 * row that was, the row it is drawn under has the word for an add-on, and the count
 * comes along. A discount on no component keeps the catalogue name it was chosen by.
 */
export function customerDiscountTarget(
  discount: {
    scope: 'order' | 'line';
    targetLabel?: string;
    targetComponent?: { kind: 'kids' | 'adults' | 'socks' | 'addon' };
  },
  rowLabel: string | undefined,
  t: TFunction,
): string {
  if (discount.scope !== 'line') return t('display.discount.wholeOrder');
  const kind = discount.targetComponent?.kind;
  const word =
    kind === 'kids'
      ? t('book.tickets.kids')
      : kind === 'adults'
        ? t('book.tickets.adults')
        : kind === 'socks'
          ? t('display.row.socks')
          : kind === 'addon'
            ? rowLabel
            : undefined;
  if (word === undefined) return discount.targetLabel ?? t('display.discount.item');
  const count = / × \d+$/.exec(discount.targetLabel ?? '')?.[0] ?? '';
  return `${word}${count}`;
}

/**
 * The tender on "Paying by …". A branch can name its methods, and in English that
 * name is what the screen has always shown. In another language the method's kind
 * is what can be said; a method of no known kind keeps its configured name.
 */
export function customerPaymentMethod(token: string, lang: SupportedLang, t: TFunction): string {
  const configured = paymentMethodLabel(token);
  if (lang === 'en') return configured;
  switch (paymentMethodKind(token)) {
    case 'cash':
      return t('common.cash');
    case 'card':
      return t('common.card');
    case 'qr':
      return t('common.thaiQrPromptpay');
    default:
      return configured;
  }
}

/**
 * A grant on the thank-you screen. The words `buildCreditGrants` gives every sale
 * are translated; anything else on the wire is an item's own name, and stays it.
 */
export function customerGrantLabel(grant: { label: string }, t: TFunction): string {
  if (grant.label === 'Credit') return t('display.grant.credit');
  if (grant.label === 'Regular Socks') return t('display.row.socks');
  if (grant.label === 'Free item (promo)') return t('display.grant.freeItem');
  if (grant.label.startsWith('Free: ')) {
    return t('display.grant.free', { name: grant.label.slice('Free: '.length) });
  }
  return grant.label;
}

/** `unpricedLineReason`, for the half of the counter a family reads. */
export function customerUnpricedReason(
  line: { ticketName: string; tier: CustomerTier; what: 'kid' | 'adult' },
  t: TFunction,
): string {
  return t(line.what === 'adult' ? 'display.unpriced.adult' : 'display.unpriced.kid', {
    tier: tierLabel(line.tier),
    ticket: line.ticketName,
  });
}

/**
 * What a paired display's alert says. English keeps the sentence the platform
 * answered with. Those sentences exist in English only, and a family reading
 * another language is told what they can do about it.
 */
export function displayErrorText(message: string, lang: SupportedLang, t: TFunction): string {
  return lang === 'en' ? message : t('display.error.tryAgain');
}
