import { describe, expect, it } from 'vitest';
import { renderJob } from '../src/index';
import type { PrintTemplate } from '../src/index';
import { PROFILES } from './fixtures';
import { decodeQrMatrix } from './qr-reader';

/**
 * S2-14a round 1 — the credit voucher the platform now prints, one per
 * granted wallet (`printRouting.tsx:86-119`, `PrintTemplatePreview.tsx:101-149`).
 *
 * The platform sends `{ balance, balanceTHB, qrCode, holderName }`: the
 * pre-formatted figure every printout carries and the prototype's number. The
 * template's two toggles are honoured — the balance block and the QR each go
 * when switched off — and the QR printed is the wallet's ONE key.
 */

const escpos576 = PROFILES.escpos576!;

function template(fields: PrintTemplate['fields']): PrintTemplate {
  return { id: 'tpl-credit-voucher', type: 'credit_voucher', name: 'Credit voucher', showLogo: false, fields };
}

function textOf(job: ReturnType<typeof renderJob>): string[] {
  return job.layout.items.filter((i) => i.k === 'text').map((i) => (i as { text: string }).text);
}

const QR = 'QR-7KMQ4XB9TZ2D5HVR8NWC';

describe('the credit voucher', () => {
  it('prints the credit, the holder and the wallet QR — the one key it spends by', () => {
    const job = renderJob(
      { kind: 'credit_voucher', data: { balance: '฿350', balanceTHB: 350, qrCode: QR, holderName: 'Walk-in guest' } },
      { device: escpos576, templates: [template({ creditVoucherBalance: true, creditVoucherQr: true })] },
    );
    const lines = textOf(job).join('\n');
    expect(lines).toContain('CREDIT VOUCHER');
    expect(lines).toContain('Credit loaded');
    expect(lines).toContain('฿350');
    expect(lines).toContain('For Walk-in guest');
    expect(lines).toContain(QR);
    const qr = job.layout.items.find((i) => i.k === 'qr');
    expect(qr).toBeDefined();
    if (qr && qr.k === 'qr') expect(decodeQrMatrix(qr.matrix)).toBe(QR);
    expect(job.overflow).toEqual([]);
  });

  it('formats the prototype number when only balanceTHB is sent', () => {
    const job = renderJob(
      { kind: 'credit_voucher', data: { balanceTHB: 1300, qrCode: QR } },
      { device: escpos576, templates: [template({ creditVoucherBalance: true, creditVoucherQr: true })] },
    );
    expect(textOf(job).join('\n')).toContain('฿1,300');
    const half = renderJob(
      { kind: 'credit_voucher', data: { balanceTHB: 445.5 } },
      { device: escpos576, templates: [template({ creditVoucherBalance: true })] },
    );
    expect(textOf(half).join('\n')).toContain('฿445.50');
  });

  it('honours the template: balance off hides the figure, QR off hides the code', () => {
    const noBalance = renderJob(
      { kind: 'credit_voucher', data: { balance: '฿350', balanceTHB: 350, qrCode: QR } },
      { device: escpos576, templates: [template({ creditVoucherBalance: false, creditVoucherQr: true })] },
    );
    expect(textOf(noBalance).join('\n')).not.toContain('฿350');
    expect(noBalance.layout.items.some((i) => i.k === 'qr')).toBe(true);

    const noQr = renderJob(
      { kind: 'credit_voucher', data: { balance: '฿350', balanceTHB: 350, qrCode: QR } },
      { device: escpos576, templates: [template({ creditVoucherBalance: true, creditVoucherQr: false })] },
    );
    expect(textOf(noQr).join('\n')).toContain('฿350');
    expect(textOf(noQr).join('\n')).not.toContain(QR);
    expect(noQr.layout.items.some((i) => i.k === 'qr')).toBe(false);
  });
});
