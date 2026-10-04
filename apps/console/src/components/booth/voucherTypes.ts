/**
 * Voucher types, as a manager sets them up (SCRUM-400): the words the form
 * uses, the form's own model, and what it sends.
 *
 * **The five choices are the five things the till can do with a voucher**
 * (`resolveVoucherEffect` in `apps/api/src/services/vouchers.ts`): take an
 * amount or a percentage off the ticket order, hand over one product for
 * nothing, give the second kids ticket of a package for nothing, or ring up a
 * prize that reception hands over as it is — a sale at ฿0 that uses the
 * voucher (Q2 of the booth's closing audit,
 * `docs/progress/plans/booth/AUDIT-CLOSING-2026-09-25.md`, answered A: a
 * hand-over prize is given out at reception, not at the booth). A wallet
 * credit is in the schema and nothing redeems one yet, so it is not offered;
 * an existing one is shown for what it is and can still be edited.
 *
 * The API is the authority on every rule here and checks the whole row on
 * save. What this file adds is saying so while somebody types, so the Save
 * button is closed on a free product with no product rather than opening onto
 * a refusal.
 */
import { formatTHB } from '@oto/shared';
import type { VoucherDefinitionInput, VoucherDefinitionRow } from './boothApi';
import { hundredthsToText, parseBahtToSatang, parsePercentToBp } from './odds';

export type VoucherChoice = 'amount' | 'percent' | 'product' | 'ticket' | 'handover';

export const VOUCHER_CHOICES: ReadonlyArray<{
  id: VoucherChoice;
  label: string;
  kind: string;
  valueType: string;
  /** One line under the choice: what the till does with it. */
  detail: string;
}> = [
  {
    id: 'amount',
    label: 'Amount off',
    kind: 'discount',
    valueType: 'amount',
    detail: 'Baht off the tickets on the sale — never more than the tickets cost, and never given as change.',
  },
  {
    id: 'percent',
    label: 'Percent off',
    kind: 'discount',
    valueType: 'percent',
    detail: 'A percentage off the tickets on the sale.',
  },
  {
    id: 'product',
    label: 'Free product',
    kind: 'free_item',
    valueType: 'item',
    detail: 'One of the product, handed over at no charge: the till puts it on the sale and takes its price off.',
  },
  {
    id: 'ticket',
    label: 'Free ticket 1+1',
    kind: 'free_ticket',
    valueType: 'item',
    detail: 'With two kids tickets of the linked package on the sale, one of them is free. Only that package qualifies.',
  },
  {
    id: 'handover',
    label: 'Hand-over prize',
    kind: 'manual',
    valueType: 'none',
    detail:
      'A prize given out at reception: the family brings the slip, reception rings it up as a ฿0 sale, which uses the voucher, and hands the prize over.',
  },
];

/** Which choice a stored definition is, or null for a kind the form does not offer. */
export function choiceOf(row: Pick<VoucherDefinitionRow, 'kind' | 'valueType'>): VoucherChoice | null {
  if (row.kind === 'discount') return row.valueType === 'percent' ? 'percent' : 'amount';
  if (row.kind === 'free_item') return 'product';
  if (row.kind === 'free_ticket') return 'ticket';
  if (row.kind === 'manual') return 'handover';
  return null;
}

/**
 * The columns that decide what a voucher is worth, with the product or package
 * named where it is known. A stored row is one; so is what the editor is about
 * to send, once its links are named from the pickers (`worthChange`).
 */
export type Worth = Pick<
  VoucherDefinitionRow,
  'kind' | 'valueType' | 'valueSatang' | 'valueBp' | 'productId' | 'ticketPackageId'
> & {
  product?: { name: string } | null;
  ticketPackage?: { name: string } | null;
};

/** What a voucher type is worth, in the words the till's card uses. */
export function worthOf(row: Worth): string {
  switch (row.kind) {
    case 'discount':
      return row.valueType === 'percent'
        ? row.valueBp
          ? `${hundredthsToText(row.valueBp)}% off the ticket order`
          : 'Percent off — no percentage set'
        : row.valueSatang
          ? `${formatTHB(row.valueSatang)} off the ticket order`
          : 'Amount off — no amount set';
    case 'free_item':
      return row.product
        ? `Free: ${row.product.name}`
        : row.productId
          ? 'Free product'
          : 'Free product — no product linked';
    case 'free_ticket':
      return row.ticketPackage
        ? `Second kids ticket free — ${row.ticketPackage.name}`
        : row.ticketPackageId
          ? 'Free ticket 1+1'
          : 'Free ticket 1+1 — no package linked';
    case 'manual':
      return 'A prize handed over at reception';
    case 'wallet_credit':
      return 'Wallet credit — no till redeems one yet';
    default:
      return row.kind;
  }
}

/**
 * Whether the type already has a worth the till would honour: an amount or a
 * percentage above zero, a product or a package linked. A hand-over prize is
 * worth what it is by its kind alone.
 *
 * The line between completing a type and changing it. A free product whose
 * product is linked for the first time is being completed — the slips printed
 * before the link must pick it up, which is step 2 of `docs/ops/BOOTH_SETUP.md`
 * — so that is not asked about. A type that already had a worth is a different
 * matter: see `worthChange`.
 */
export function worthSettled(row: Worth): boolean {
  switch (row.kind) {
    case 'discount':
      return row.valueType === 'percent' ? Boolean(row.valueBp) : Boolean(row.valueSatang);
    case 'free_item':
      return Boolean(row.productId);
    case 'free_ticket':
      return Boolean(row.ticketPackageId);
    default:
      return true;
  }
}

/** Whether two worths differ in any column the till reads. */
export function worthDiffers(a: Worth, b: Worth): boolean {
  return (
    a.kind !== b.kind ||
    a.valueType !== b.valueType ||
    (a.valueSatang ?? null) !== (b.valueSatang ?? null) ||
    (a.valueBp ?? null) !== (b.valueBp ?? null) ||
    (a.productId ?? null) !== (b.productId ?? null) ||
    (a.ticketPackageId ?? null) !== (b.ticketPackageId ?? null)
  );
}

/**
 * What a save would change a stored type's worth from and to, in the till's
 * words — or null when it would not, or when the type had no worth yet.
 *
 * Why this is asked about at all (SCRUM-409, the closing audit's L10): the
 * till reads the worth from the type when a voucher is scanned, so the change
 * applies at once to every voucher of the type not yet redeemed, the slips
 * already printed included. The editor shows this and asks before sending;
 * the safer choice for a new worth is a new voucher type, which leaves the
 * slips out there worth what they were printed for.
 */
export function worthChange(stored: Worth, next: Worth): { from: string; to: string } | null {
  if (!worthSettled(stored) || !worthDiffers(stored, next)) return null;
  return { from: worthOf(stored), to: worthOf(next) };
}

/**
 * How many vouchers that change reaches, as the question says it: the type's
 * vouchers still unredeemed — issued, not used, not void, not past their date
 * — as the api counted them when the type was read (`unredeemedVouchers`).
 * Right for none and for one. Undefined is an api that does not send the
 * count yet, and the sentence then says "every", the question's word before
 * the count.
 */
export function unredeemedSentence(unredeemed: number | undefined): string {
  if (unredeemed === undefined) {
    return 'Every voucher of this type not yet redeemed, the slips already printed included, changes with it at once';
  }
  if (unredeemed === 0) {
    return 'No voucher of this type is unredeemed, so no printed slip changes with it';
  }
  if (unredeemed === 1) return '1 unredeemed voucher, its printed slip included, changes with it at once';
  return `${unredeemed} unredeemed vouchers, printed slips included, change with it at once`;
}

/** The words a save would print, as the editor is about to send them. */
export type SlipWords = Pick<
  VoucherDefinitionInput,
  'nameEn' | 'nameTh' | 'titleEn' | 'titleTh' | 'instructionEn' | 'instructionTh' | 'termsEn' | 'termsTh'
>;

/** A way a worth is written in a name or on a slip, and what the sentence calls it when found. */
interface WorthWord {
  text: string;
  shows: string;
}

/**
 * The ways a number is written down: as typed (`100`, `150.5`), with two
 * places (`150.50`), and grouped once it reaches a thousand (`1,000`). Every
 * form is shown as the number as typed, with `suffix` after it.
 */
function numberWords(hundredths: number, suffix = ''): WorthWord[] {
  const plain = hundredthsToText(hundredths);
  const whole = Math.trunc(hundredths / 100);
  const fraction = Math.abs(hundredths % 100);
  const wholes = whole >= 1000 ? [String(whole), whole.toLocaleString('en-US')] : [String(whole)];
  const fractions =
    fraction === 0 ? [''] : [...new Set([`.${plain.split('.')[1]}`, `.${String(fraction).padStart(2, '0')}`])];
  return wholes.flatMap((w) => fractions.map((f) => ({ text: `${w}${f}`, shows: `${plain}${suffix}` })));
}

/**
 * The plain words for a worth, the ones a manager writes into the type's name
 * and slip: the number of baht, the percentage, the product's name, `1+1` and
 * the package's name. A hand-over prize has none — "prize" is on every slip.
 */
function worthWords(row: Worth): WorthWord[] {
  switch (row.kind) {
    case 'discount':
      if (row.valueType === 'percent') return row.valueBp ? numberWords(row.valueBp, '%') : [];
      return row.valueSatang ? numberWords(row.valueSatang) : [];
    case 'free_item':
      return row.product ? [{ text: row.product.name, shows: row.product.name }] : [];
    case 'free_ticket':
      return [
        ...['1+1', '1 + 1', '1 แถม 1'].map((text) => ({ text, shows: '1+1' })),
        ...(row.ticketPackage ? [{ text: row.ticketPackage.name, shows: row.ticketPackage.name }] : []),
      ];
    default:
      return [];
  }
}

/**
 * Whether the text says the word, in any case. A number counts only as a
 * whole number — `100` is in `฿100`, `100 THB` and `100.00`, not in `1000`
 * or `2100` — so a name is not accused of a number it does not say.
 */
function says(text: string | null, word: string): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  const needle = word.toLowerCase();
  if (!/^[\d.,]+$/.test(needle)) return hay.includes(needle);
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (!/\d/.test(hay.charAt(at - 1)) && !/\d/.test(hay.charAt(at + needle.length))) return true;
  }
  return false;
}

/** The fields the sentence names, each an English and a Thai column of the same words. */
const WORD_FIELDS: ReadonlyArray<{ label: string; en: keyof SlipWords; th: keyof SlipWords }> = [
  { label: 'name', en: 'nameEn', th: 'nameTh' },
  { label: 'slip title', en: 'titleEn', th: 'titleTh' },
  { label: 'instruction', en: 'instructionEn', th: 'instructionTh' },
  { label: 'terms', en: 'termsEn', th: 'termsTh' },
];

/** `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Which of the type's words still say the worth a save is leaving behind, as
 * one more sentence for the question `worthChange` raises — or null when none
 * do.
 *
 * Why (SCRUM-432): the worth is read from the type, but the words are printed
 * from it too, and confirming ฿100 → ฿150 leaves "100 THB Voucher", "100 THB
 * OFF" and "…for 100 THB off your admission" as they were, so every slip
 * printed afterwards contradicts its worth. The question already says what
 * happens to the vouchers; this says what is still wrong with the words, by
 * name, so the manager changes them in the same edit or knows what they left.
 *
 * A plain text search, nothing more: the old worth's words (`worthWords`) are
 * looked for in the words about to be saved, so a name already retyped to
 * "150 THB Voucher" is not named. When the worth keeps its kind — one amount
 * for another, one package for another — the words the new worth shares with
 * the old are not looked for: "1+1" is still right on a 1+1 whose package
 * changed. The sentence names the field, and its language only when the
 * other language's words are there and do not say it. It does not rewrite
 * anything — the words are the park's, not this form's.
 */
export function staleWordsSentence(stored: Worth, next: Worth, words: SlipWords): string | null {
  const sameKind = stored.kind === next.kind && stored.valueType === next.valueType;
  const kept = new Set(worthWords(next).map((w) => w.text.toLowerCase()));
  const old = worthWords(stored).filter((w) => !sameKind || !kept.has(w.text.toLowerCase()));
  if (old.length === 0) return null;
  const found = (text: string | null) => old.find((w) => says(text, w.text));
  const fields: string[] = [];
  const shown: string[] = [];
  for (const field of WORD_FIELDS) {
    const en = found(words[field.en]);
    const th = found(words[field.th]);
    if (!en && !th) continue;
    const enBlank = !words[field.en]?.trim();
    const thBlank = !words[field.th]?.trim();
    fields.push(
      en && th
        ? field.label
        : en
          ? thBlank
            ? field.label
            : `English ${field.label}`
          : enBlank
            ? field.label
            : `Thai ${field.label}`,
    );
    for (const w of [en, th]) if (w && !shown.includes(w.shows)) shown.push(w.shows);
  }
  if (fields.length === 0) return null;
  // "terms" is plural on its own, so a lone terms field still takes "say" and "them".
  const one = fields.length === 1 && !fields[0]!.endsWith('terms');
  return `Its ${listed(fields)} still ${one ? 'says' : 'say'} ${listed(shown)} — change ${one ? 'it' : 'them'} too, or the slips will contradict their worth.`;
}

/**
 * Why the till would refuse this voucher type today, or null when it would
 * honour it. The words are the counter's own reasons ("not set up yet"), so
 * the list says what a family at reception would hear.
 *
 * **One note here is not a refusal: the hand-over prize's.** Its slip is
 * honoured by ringing it up at a till as a ฿0 sale, which uses the voucher
 * before the prize changes hands, and the park does that at reception — so
 * whoever puts one on a wheel has to know the prize is kept at reception, not
 * at the booth. It is said in this note's places (the voucher types list, the
 * editor's "Today at the till", the prize editor's voucher line) for that
 * reason, and in the same amber.
 */
export function notSetUp(row: VoucherDefinitionRow): string | null {
  if (row.kind === 'free_item' && !row.productId) {
    return 'No product linked — the till answers “not set up yet”.';
  }
  if (row.kind === 'free_ticket' && !row.ticketPackageId) {
    return 'No ticket package linked — the till answers “not set up yet”.';
  }
  if (row.kind === 'discount' && row.valueType === 'amount' && !row.valueSatang) {
    return 'No amount — the till answers “not set up yet”.';
  }
  if (row.kind === 'discount' && row.valueType === 'percent' && !row.valueBp) {
    return 'No percentage — the till answers “not set up yet”.';
  }
  if (row.kind === 'wallet_credit') return 'No till redeems a wallet credit yet.';
  if (row.product && !row.product.live) {
    return `${row.product.name} is not on sale any more — the till refuses it.`;
  }
  if (row.ticketPackage && !row.ticketPackage.live) {
    return `${row.ticketPackage.name} is not on sale any more — the till refuses it.`;
  }
  if (row.kind === 'manual') {
    return 'The family brings the slip to reception, which rings it up at ฿0 and hands the prize over.';
  }
  return null;
}

export function expiryText(days: number | null): string {
  if (days === null) return 'Never expires';
  return days === 1 ? '1 day' : `${days} days`;
}

/** Whether the park has written its own words for the slip. */
export function isWorded(row: VoucherDefinitionRow): boolean {
  return [row.titleEn, row.titleTh, row.instructionEn, row.instructionTh].some(
    (w) => typeof w === 'string' && w.trim() !== '',
  );
}

/**
 * A reference code from the English name: `50 THB off` → `50-thb-off`. The
 * API's shape is lower-case letters, digits and hyphens, two to sixty-one
 * long; a name with too few of those (Thai only, say) gets `voucher-` and a
 * short code worked out from the name — the same name, the same code, so the
 * field does not change under somebody's eyes while they type.
 */
export function codeFor(nameEn: string): string {
  const slug = nameEn
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  if (slug.length >= 2) return slug;
  let hash = 0;
  for (const ch of nameEn) hash = (Math.imul(hash, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `voucher-${hash.toString(36).padStart(6, '0').slice(-6)}`;
}

export const CODE_SHAPE = /^[a-z0-9][a-z0-9-]{1,60}$/;

// --- The form ------------------------------------------------------------------

/** What the editor holds while somebody types. Text fields hold what was typed. */
export interface VoucherForm {
  code: string;
  /** False once somebody typed a code of their own: stop deriving it from the name. */
  codeTouched: boolean;
  nameEn: string;
  nameTh: string;
  /** Null for a stored kind the form does not offer (a wallet credit). */
  choice: VoucherChoice | null;
  amountText: string;
  percentText: string;
  productId: string;
  ticketPackageId: string;
  expiry: 'days' | 'never';
  expiryDays: number | null;
  titleEn: string;
  titleTh: string;
  instructionEn: string;
  instructionTh: string;
  termsEn: string;
  termsTh: string;
  active: boolean;
  /** 'generated': each slip its own code. 'fixed': every slip prints fixedCode. */
  codeMode: 'generated' | 'fixed';
  fixedCode: string;
}

export function blankForm(): VoucherForm {
  return {
    code: '',
    codeTouched: false,
    nameEn: '',
    nameTh: '',
    choice: 'amount',
    amountText: '',
    percentText: '',
    productId: '',
    ticketPackageId: '',
    expiry: 'days',
    expiryDays: 14,
    titleEn: '',
    titleTh: '',
    instructionEn: '',
    instructionTh: '',
    termsEn: '',
    termsTh: '',
    active: true,
    codeMode: 'generated',
    fixedCode: '',
  };
}

export function formFrom(row: VoucherDefinitionRow): VoucherForm {
  return {
    code: row.code,
    codeTouched: true,
    nameEn: row.nameEn,
    nameTh: row.nameTh ?? '',
    choice: choiceOf(row),
    amountText: row.valueSatang ? hundredthsToText(row.valueSatang) : '',
    percentText: row.valueBp ? hundredthsToText(row.valueBp) : '',
    productId: row.productId ?? '',
    ticketPackageId: row.ticketPackageId ?? '',
    expiry: row.expiryDays === null ? 'never' : 'days',
    expiryDays: row.expiryDays,
    titleEn: row.titleEn ?? '',
    titleTh: row.titleTh ?? '',
    instructionEn: row.instructionEn ?? '',
    instructionTh: row.instructionTh ?? '',
    termsEn: row.termsEn ?? '',
    termsTh: row.termsTh ?? '',
    active: row.active,
    codeMode: row.codeMode === 'fixed' ? 'fixed' : 'generated',
    fixedCode: row.fixedCode ?? '',
  };
}

/**
 * Everything that stops a save, each against the field it belongs to. The same
 * rules the API enforces — the form says them first, the API has the last word.
 */
export function formProblems(form: VoucherForm, isNew: boolean): Partial<Record<keyof VoucherForm, string>> {
  const out: Partial<Record<keyof VoucherForm, string>> = {};
  if (form.nameEn.trim() === '') out.nameEn = 'Every voucher type needs an English name.';
  if (isNew && !CODE_SHAPE.test(form.code)) {
    out.code = 'Lower-case letters, digits and hyphens, at least two.';
  }
  if (form.choice === 'amount') {
    const satang = parseBahtToSatang(form.amountText);
    if (satang === null || satang <= 0) out.amountText = 'An amount in baht, above zero.';
  }
  if (form.choice === 'percent') {
    const bp = parsePercentToBp(form.percentText);
    if (bp === null || bp <= 0) out.percentText = 'A percentage above 0 and at most 100.';
  }
  if (form.choice === 'product' && form.productId === '') {
    out.productId = 'Choose the product it hands over.';
  }
  if (form.choice === 'ticket' && form.ticketPackageId === '') {
    out.ticketPackageId = 'Choose the ticket package the 1+1 applies to.';
  }
  if (form.expiry === 'days') {
    const d = form.expiryDays;
    if (d === null || !Number.isInteger(d) || d < 1 || d > 36_500) {
      out.expiryDays = 'Whole days, at least 1 — or choose “Never”.';
    }
  }
  if (form.codeMode === 'fixed' && !/^[0-9A-Z-]{4,32}$/.test(form.fixedCode.trim().toUpperCase())) {
    out.fixedCode = '4 to 32 letters, digits or hyphens.';
  }
  return out;
}

const words = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/**
 * The body the API takes. Only a stored wallet credit reaches here without a
 * choice, and it is sent as it is stored — the form cannot change its value.
 */
export function inputFrom(
  form: VoucherForm,
  stored: VoucherDefinitionRow | null,
  isNew: boolean,
): VoucherDefinitionInput {
  const choice = VOUCHER_CHOICES.find((c) => c.id === form.choice);
  const base = {
    nameEn: form.nameEn.trim(),
    nameTh: words(form.nameTh),
    expiryDays: form.expiry === 'never' ? null : form.expiryDays,
    titleEn: words(form.titleEn),
    titleTh: words(form.titleTh),
    instructionEn: words(form.instructionEn),
    instructionTh: words(form.instructionTh),
    termsEn: words(form.termsEn),
    termsTh: words(form.termsTh),
    active: form.active,
    codeMode: form.codeMode,
    fixedCode: form.codeMode === 'fixed' ? form.fixedCode.trim().toUpperCase() : null,
    ...(isNew ? { code: form.code } : {}),
  };
  if (!choice) {
    return {
      ...base,
      kind: stored?.kind ?? 'manual',
      valueType: stored?.valueType ?? 'none',
      valueSatang: stored?.valueSatang ?? null,
      valueBp: stored?.valueBp ?? null,
      productId: stored?.productId ?? null,
      ticketPackageId: stored?.ticketPackageId ?? null,
    };
  }
  return {
    ...base,
    kind: choice.kind,
    valueType: choice.valueType,
    valueSatang: choice.id === 'amount' ? parseBahtToSatang(form.amountText) : null,
    valueBp: choice.id === 'percent' ? parsePercentToBp(form.percentText) : null,
    productId: choice.id === 'product' ? form.productId || null : null,
    ticketPackageId: choice.id === 'ticket' ? form.ticketPackageId || null : null,
  };
}
