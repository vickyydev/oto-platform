import { describe, expect, it } from 'vitest';
import { renderJob } from '../src/index';
import type { CreditVoucherData, PrintTemplate, ReceiptData } from '../src/index';
import { RECEIPT_TYPE } from '../src/templates/common';
import { parseEscpos } from './escpos-reader';
import { PROFILES, TEMPLATES } from './fixtures';
import { decodeQrMatrix } from './qr-reader';

/**
 * One sale, one slip.
 *
 * A sale that loads F&B credit used to print its receipt and then one credit
 * voucher per wallet, each a job of its own with its own cut. The receipt now
 * carries each wallet's credit section — the figure, the QR and its key, the
 * holder, the band it is also on — above its footer, and the job ends in one
 * cut. The section obeys the branch's `credit_voucher` template, as the slip
 * did.
 *
 * And the receipt's type: every line bold and larger than the other
 * printouts, sized so that no figure ever wraps on either head the XP-80
 * family ships with.
 */

const escpos576 = PROFILES.escpos576!;
const escpos512 = PROFILES.escpos512!;

const ADULT_QR = 'QR-7KMQ4XB9TZ2D5HVR8NWC';
const KID_QR = 'QR-C9P5Q3RTVW2X4Y6Z8A0B';

const CREDITS: CreditVoucherData[] = [
  { balance: '฿350', qrCode: ADULT_QR, holderName: 'Walk-in guest', bandCode: 'T1-A7K3M1' },
  { balance: '฿1,300', qrCode: KID_QR, holderName: 'Walk-in guest', bandCode: 'T1-B8N4P2' },
];

function receipt(extra: Partial<ReceiptData> = {}): ReceiptData {
  return {
    title: 'Receipt',
    receiptNumber: 'T1-000042',
    dateTime: '2026-09-30 14:05',
    lines: [
      { qty: 1, name: 'Eat & Play — Child', price: '฿1,300' },
      { qty: 1, name: 'Eat & Play — Adult', price: '฿350' },
    ],
    subtotal: '฿1,650',
    vat: '฿107.94',
    total: '฿1,650',
    tenders: [{ label: 'Cash', amount: '฿1,650' }],
    bandCodes: ['T1-A7K3M1', 'T1-B8N4P2'],
    ...extra,
  };
}

function creditTemplate(fields: PrintTemplate['fields'], footerText?: string): PrintTemplate {
  return {
    id: 'tpl-credit-voucher',
    type: 'credit_voucher',
    name: 'Credit voucher',
    showLogo: false,
    ...(footerText ? { footerText } : {}),
    fields,
  };
}

const receiptTemplate = TEMPLATES.find((t) => t.type === 'receipt')!;

function texts(job: ReturnType<typeof renderJob>): string[] {
  return job.layout.items.filter((i) => i.k === 'text').map((i) => (i as { text: string }).text);
}

function qrValues(job: ReturnType<typeof renderJob>): string[] {
  return job.layout.items.filter((i) => i.k === 'qr').map((i) => (i.k === 'qr' ? decodeQrMatrix(i.matrix) : ''));
}

describe('a sale that loads F&B credit prints one receipt', () => {
  it('carries every wallet’s credit, QR and band, and comes out with ONE cut', () => {
    const job = renderJob({ kind: 'receipt', data: receipt({ creditVouchers: CREDITS }) }, { device: escpos576, templates: TEMPLATES });
    const lines = texts(job);
    expect(lines.filter((t) => t === 'CREDIT VOUCHER')).toHaveLength(2);
    expect(lines.filter((t) => t === 'Credit loaded')).toHaveLength(2);
    for (const credit of CREDITS) {
      expect(lines).toContain(credit.balance);
      expect(lines).toContain(credit.qrCode);
      expect(lines).toContain(`Band ${credit.bandCode}`);
    }
    // The QRs are the wallets' keys, in the order the wallets were granted.
    expect(qrValues(job)).toEqual([ADULT_QR, KID_QR]);
    // One job, one bitmap, one cut — the paper the guest is handed.
    const parsed = parseEscpos(job.bytes, escpos576.widthDots);
    expect(parsed.cuts).toBe(1);
    expect(parsed.unknown).toEqual([]);
    expect(job.overflow).toEqual([]);
  });

  it('puts the credit after the receipt’s own sections and before its footer', () => {
    const job = renderJob({ kind: 'receipt', data: receipt({ creditVouchers: CREDITS }) }, { device: escpos576, templates: TEMPLATES });
    const lines = texts(job);
    const total = lines.indexOf('TOTAL');
    const firstCredit = lines.indexOf('CREDIT VOUCHER');
    const footer = lines.findIndex((t) => t.startsWith('Thank you for visiting!'));
    expect(total).toBeGreaterThan(-1);
    expect(firstCredit).toBeGreaterThan(total);
    expect(footer).toBeGreaterThan(lines.lastIndexOf(KID_QR));
  });

  it('prints the credit voucher template’s footer once, however many wallets', () => {
    const footer = 'Scan QR or wristband at the F&B or merch counter to spend.';
    const job = renderJob(
      { kind: 'receipt', data: receipt({ creditVouchers: CREDITS }) },
      { device: escpos576, templates: [receiptTemplate, creditTemplate({ creditVoucherBalance: true, creditVoucherQr: true }, footer)] },
    );
    expect(texts(job).join(' ').split(footer).length - 1).toBe(1);
  });

  it('obeys the credit voucher template: QR off drops the codes, balance off drops the figures', () => {
    const noQr = renderJob(
      { kind: 'receipt', data: receipt({ creditVouchers: CREDITS }) },
      { device: escpos576, templates: [receiptTemplate, creditTemplate({ creditVoucherBalance: true, creditVoucherQr: false })] },
    );
    expect(noQr.layout.items.some((i) => i.k === 'qr')).toBe(false);
    expect(texts(noQr)).not.toContain(ADULT_QR);
    expect(texts(noQr)).toContain('฿350');

    const noBalance = renderJob(
      { kind: 'receipt', data: receipt({ creditVouchers: CREDITS }) },
      { device: escpos576, templates: [receiptTemplate, creditTemplate({ creditVoucherBalance: false, creditVoucherQr: true })] },
    );
    expect(texts(noBalance)).not.toContain('Credit loaded');
    expect(qrValues(noBalance)).toEqual([ADULT_QR, KID_QR]);
  });

  it('prints no credit section on a receipt that granted nothing', () => {
    const job = renderJob({ kind: 'receipt', data: receipt() }, { device: escpos576, templates: TEMPLATES });
    expect(texts(job)).not.toContain('CREDIT VOUCHER');
    expect(job.layout.items.some((i) => i.k === 'qr')).toBe(false);
    expect(parseEscpos(job.bytes, escpos576.widthDots).cuts).toBe(1);
  });
});

describe('the receipt’s type: bigger and bold', () => {
  it('draws every line bold, none smaller than the small size, the TOTAL in the large one', () => {
    for (const device of [escpos576, escpos512]) {
      const job = renderJob({ kind: 'receipt', data: receipt({ creditVouchers: CREDITS }) }, { device, templates: TEMPLATES });
      const items = job.layout.items.filter((i) => i.k === 'text');
      expect(items.length).toBeGreaterThan(20);
      for (const item of items) {
        if (item.k !== 'text') continue;
        expect(item.style.weight, item.text).toBe('bold');
        expect(item.style.sizeDots, item.text).toBeGreaterThanOrEqual(RECEIPT_TYPE.small.sizeDots);
      }
      const total = items.find((i) => i.k === 'text' && i.text === 'TOTAL');
      expect(total?.k === 'text' && total.style.sizeDots).toBe(RECEIPT_TYPE.total.sizeDots);
      expect(job.overflow, device.label).toEqual([]);
    }
  });

  it('keeps every figure on one line and on one right edge, on a 512-dot head as on a 576', () => {
    for (const device of [escpos576, escpos512]) {
      const job = renderJob(
        {
          kind: 'receipt',
          data: receipt({
            lines: [
              { qty: 3, name: 'Birthday Package — Jungle, party room B', price: '฿12,345.50' },
              { qty: 1, name: 'Adult Pass', price: '฿150' },
            ],
            subtotal: '฿12,495.50',
            discounts: [{ label: 'Discount · Kids', amount: '−฿1,234.50' }],
            total: '฿11,261',
          }),
        },
        { device, templates: TEMPLATES },
      );
      const money = job.layout.items.filter(
        (i) => i.k === 'text' && /^−?฿/.test(i.text) && i.style.sizeDots === RECEIPT_TYPE.body.sizeDots,
      );
      expect(money.map((i) => (i.k === 'text' ? i.text : ''))).toEqual(
        expect.arrayContaining(['฿12,345.50', '฿150', '฿12,495.50', '−฿1,234.50']),
      );
      const rights = new Set(money.map((i) => (i.k === 'text' ? i.x + i.widthDots : 0)));
      expect(rights.size, device.label).toBe(1);
      // Split mid-word is the one overflow note that would mean a broken figure.
      expect(job.overflow.filter((o) => o.includes('split mid-word')), device.label).toEqual([]);
    }
  });

  it('sets the receipt number and the time on one row when they fit, on two lines when they do not', () => {
    const fits = renderJob({ kind: 'receipt', data: receipt() }, { device: escpos512, templates: TEMPLATES });
    const number = fits.layout.items.find((i) => i.k === 'text' && i.text === 'T1-000042');
    const when = fits.layout.items.find((i) => i.k === 'text' && i.text === '2026-09-30 14:05');
    expect(number?.k === 'text' && when?.k === 'text' && number.baselineY === when.baselineY).toBe(true);

    const long = renderJob(
      { kind: 'receipt', data: receipt({ receiptNumber: 'HKT1-REC-000000042' }) },
      { device: escpos512, templates: TEMPLATES },
    );
    const n = long.layout.items.find((i) => i.k === 'text' && i.text === 'HKT1-REC-000000042');
    const w = long.layout.items.find((i) => i.k === 'text' && i.text === '2026-09-30 14:05');
    expect(n?.k === 'text' && w?.k === 'text' && w.baselineY > n.baselineY).toBe(true);
    expect(long.overflow).toEqual([]);
  });
});
