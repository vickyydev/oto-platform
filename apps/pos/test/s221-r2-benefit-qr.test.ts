import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { benefitsApi } from '@/api/benefits';

/**
 * S2-21 (SCRUM-218) round 2 — the Staff Benefits QR button on the platform's
 * benefit QR (plan docs/progress/plans/benefits/PLAN.md §8 round 2).
 *
 *   - the dialog's calls reach the routes the platform serves, and every
 *     write carries one idempotency key per press, so a retried Issue or
 *     Revoke is the same act and never a second QR;
 *   - the dialog keeps the prototype's words and draws a REAL QR — the
 *     prototype's `<QrCode>` is a pattern no scanner reads — and the panel
 *     opens it, gated as the routes are.
 */

const calls: Array<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}> = [];

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

function stubFetch(answer: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
}

describe('the QR dialog’s calls', () => {
  it('lists, prints, issues and revokes on the platform’s routes', async () => {
    stubFetch({ credentials: [] });
    const employeeId = '0199a7b0-0000-7000-8000-00000000e001';
    const credentialId = '0199a7b0-0000-7000-8000-00000000c001';
    await benefitsApi.credentials(employeeId);
    await benefitsApi.credentialQr(credentialId);
    await benefitsApi.issueCredential(employeeId, 'press-1');
    await benefitsApi.revokeCredential(credentialId, 'press-2');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/benefits/credentials?employeeId=${employeeId}`,
      `GET /api/benefits/credentials/${credentialId}/qr`,
      'POST /api/benefits/credentials',
      `POST /api/benefits/credentials/${credentialId}/revoke`,
    ]);
    expect(JSON.parse(calls[2]!.body!)).toEqual({ employeeId });
    expect(calls[2]!.headers['idempotency-key']).toBe('press-1');
    expect(calls[3]!.headers['idempotency-key']).toBe('press-2');
    // A read carries no key.
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('mints a key per press when none is given', async () => {
    stubFetch({ credential: {} });
    await benefitsApi.issueCredential('0199a7b0-0000-7000-8000-00000000e002');
    await benefitsApi.issueCredential('0199a7b0-0000-7000-8000-00000000e002');
    const [a, b] = calls.map((c) => c.headers['idempotency-key']);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe('the dialog and the panel, as written', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', 'src', 'components', 'admin', 'staff-benefits');
  const dialog = readFileSync(join(dir, 'BenefitQrDialog.tsx'), 'utf8');
  const panel = readFileSync(join(dir, 'StaffBenefitsPanel.tsx'), 'utf8');

  it('keeps the prototype’s words and draws a scannable QR, not the stylised pattern', () => {
    expect(dialog).toContain(
      "Scan at the F&amp;B order station to apply this staff member's benefit.",
    );
    expect(dialog).toContain("import QRCode from 'qrcode'");
    expect(dialog).not.toContain("from '@/components/till/QrCode'");
    expect(dialog).not.toContain('@/mockApi');
  });

  it('is opened by the QR button, and printing is gated on the issue permission', () => {
    expect(panel).toContain("can('admin:benefit:credential_issue')");
    expect(panel).toContain('onClick={() => setQrOperator(op)}');
    expect(panel).toMatch(/<BenefitQrDialog[\s\S]*canIssue=\{canIssueQr\}/);
  });
});
