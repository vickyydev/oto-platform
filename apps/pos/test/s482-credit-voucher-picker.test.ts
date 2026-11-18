import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { vouchersApi, type IssuableDefinition } from '@/api/vouchers';
import { IssueVoucherRow, issueOptionLabel } from '@/components/till/RedeemVoucher';
import {
  MANAGER_APPROVAL_ACTION,
  MANAGER_APPROVAL_TITLE,
  ManagerApprovalFields,
  managerApprovalLine,
} from '@/components/till/ManagerApprovalDialog';
import { LanguageProvider } from '@/i18n/LanguageContext';

/**
 * SCRUM-482 — A CREDIT VOUCHER NEEDS A MANAGER, AT THE TILL.
 *
 *   - the Issue picker names a credit type "(needs a manager)" when the
 *     platform says this person may not issue one alone (`needsManager`);
 *   - choosing one and pressing Issue opens "Needs a manager": the manager's
 *     phone number and password, Back and "Approve and print";
 *   - the till sends the approval with that one issue and nowhere else.
 *
 * The dialog's frame is Radix's (it renders into a portal, which a server
 * render leaves empty), so its fields are checked on their own and the frame's
 * wiring from its source, as the till's other dialogs are.
 */

// The components are compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");

const def = (over: Partial<IssuableDefinition>): IssuableDefinition => ({
  id: 'd', code: 'c', nameEn: 'Promotion', nameTh: null, kind: 'discount', valueSatang: 10_000, valueBp: null,
  validFrom: null, validUntil: null, usageLimit: null, redeemed: 0, needsManager: false, ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the picker names a credit voucher that needs a manager', () => {
  const credit = def({ id: 'credit', nameEn: 'ZZ TEST ฿1 credit', kind: 'wallet_credit', usageLimit: 2, redeemed: 0, needsManager: true });
  const discount = def({ id: 'disc', nameEn: '฿50 off' });
  const row = (options: IssuableDefinition[], chosen = '') => html(React.createElement(IssueVoucherRow, {
    options, chosen, busy: false, answer: null, onChoose: () => undefined, onIssue: () => undefined, onClose: () => undefined,
  }));

  it('"(needs a manager)" after the name and the uses, only where the platform says so', () => {
    expect(issueOptionLabel(credit)).toBe('ZZ TEST ฿1 credit (0/2 used) (needs a manager)');
    expect(issueOptionLabel(discount)).toBe('฿50 off');
    expect(issueOptionLabel({ ...credit, needsManager: false })).toBe('ZZ TEST ฿1 credit (0/2 used)');
    const { needsManager: _absent, ...older } = credit;
    expect(issueOptionLabel(older)).toBe('ZZ TEST ฿1 credit (0/2 used)');
    const out = row([credit, discount]);
    expect(out).toContain('<option value="credit">ZZ TEST ฿1 credit (0/2 used) (needs a manager)</option>');
    expect(out).toContain('<option value="disc">฿50 off</option>');
  });

  it('it stays choosable, and Issue stays the button that asks', () => {
    const out = row([credit], 'credit');
    expect(out).not.toMatch(/<option value="credit" disabled/);
    expect(out).toMatch(/<button[^>]*>Issue &amp; print<\/button>/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Issue &amp; print<\/button>/);
  });
});

describe('"Needs a manager": the manager’s phone and password, Back and Approve and print', () => {
  const fields = (over: Partial<Parameters<typeof ManagerApprovalFields>[0]> = {}) =>
    html(React.createElement(LanguageProvider, null, React.createElement(ManagerApprovalFields, {
      phone: '', password: '', busy: false, error: null,
      onPhone: () => undefined, onPassword: () => undefined, onApprove: () => undefined, onBack: () => undefined,
      ...over,
    })));

  it('names what it is for and what to type', () => {
    expect(MANAGER_APPROVAL_TITLE).toBe('Needs a manager');
    expect(managerApprovalLine('ZZ TEST ฿1 credit')).toBe(
      'ZZ TEST ฿1 credit is a credit voucher. A manager types their own phone number and password to approve it — nobody is signed out.',
    );
    const out = fields();
    expect(out).toContain('Manager’s phone number');
    expect(out).toContain('Manager’s password');
    const password = /<input[^>]*type="password"[^>]*>/.exec(out)?.[0] ?? '';
    expect(password).toMatch(/autocomplete="off"/i);
    expect(out).toMatch(/<button[^>]*>Back<\/button>/);
    // Nothing typed yet: the action waits for both fields.
    expect(out).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${MANAGER_APPROVAL_ACTION}</button>`));
  });

  it('ready once both are typed; busy while the platform checks; a refusal in its own words', () => {
    expect(fields({ phone: '+66900000004', password: 'x' })).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*>${MANAGER_APPROVAL_ACTION}</button>`));
    expect(fields({ phone: '+66900000004', password: 'x' })).not.toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${MANAGER_APPROVAL_ACTION}</button>`));
    expect(fields({ phone: '+66900000004', password: 'x', busy: true })).toContain('Approving…');
    const refused = fields({ phone: '+66900000004', error: 'The manager’s phone number or password is incorrect.' });
    expect(refused).toContain('data-testid="manager-approval-error"');
    expect(refused).toContain('The manager’s phone number or password is incorrect.');
  });

  it('the Issue row opens it for a credit voucher that needs a manager, and nothing else does', () => {
    const source = readFileSync(new URL('../src/components/till/RedeemVoucher.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<ManagerApprovalDialog');
    expect(source).toMatch(/if \(chosenDef\?\.needsManager\) \{\s*approval\.reset\(\);\s*setApproving\(true\);\s*return;/);
    const dialog = readFileSync(new URL('../src/components/till/ManagerApprovalDialog.tsx', import.meta.url), 'utf8');
    expect(dialog).toContain('<DialogTitle>{MANAGER_APPROVAL_TITLE}</DialogTitle>');
    expect(dialog).toContain('<DialogContent className="max-w-md">');
  });
});

describe('the approval travels with that one issue', () => {
  it('sent in the issue’s body only when given', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    await vouchersApi.issue('d-1', null, 'key-1');
    await vouchersApi.issue('d-1', 'm-1', 'key-2', { phone: '+66900000004', password: 'pw' });
    expect(post.mock.calls[0]).toEqual(['/vouchers/issue', { definitionId: 'd-1' }, { idempotencyKey: 'key-1' }]);
    expect(post.mock.calls[1]).toEqual([
      '/vouchers/issue',
      { definitionId: 'd-1', memberId: 'm-1', approval: { phone: '+66900000004', password: 'pw' } },
      { idempotencyKey: 'key-2' },
    ]);
  });
});
