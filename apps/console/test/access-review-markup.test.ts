import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccessReviewAccount, AccessReviewSnapshot } from '@/api/access-review';
import { AccessReviewContent } from '@/pages/AccessReview';

const account: AccessReviewAccount = { id: 'account-private-id', phone: '+66800000001', status: 'active',
  employee: { id: 'employee-private-id', name: 'ZZ TEST Rowan' }, lastSignInAt: '2026-10-22T03:04:05.000Z', mustChangePassword: false };
const snapshot: AccessReviewSnapshot = {
  operatorWideHolders: [{ ...account, assignments: [{ id: 'assignment-private-id', roleName: 'operator_admin', scopeId: 'operator-private-id' }] }],
  platformWideHolders: [{ ...account, assignments: [{ id: 'platform-assignment-private-id', roleName: 'platform_admin', scopeId: null }] }],
  accountsWithoutEmployee: [{ ...account, employee: null, status: 'inactive' }],
  employeesWithoutAccount: [{ id: 'unlinked-employee-private-id', name: 'ZZ TEST Mirror', nickname: 'Mirror', source: 'otoapp',
    archivedAt: '2026-10-21T08:00:00.000Z', branch: { id: 'park-private-id', name: 'ZZ TEST Central' } }],
  accountsNeverSignedIn: [{ ...account, lastSignInAt: null, status: 'invited' }],
  temporaryPasswordsOutstanding: [{ ...account, mustChangePassword: true }],
};
const noop = () => undefined;
function markup(data: AccessReviewSnapshot | null, error: string | null = null) {
  return renderToStaticMarkup(createElement(AccessReviewContent, { data, error, onRetry: noop }));
}

describe('Access review read-only lists', () => {
  it('shows all six authoritative categories with returned account and employee counts and wide role names', () => {
    const html = markup(snapshot);
    for (const title of ['Operator-wide holders', 'Platform-wide holders', 'Accounts without an employee',
      'Employees without an account', 'Accounts with no recorded sign-in', 'Temporary passwords outstanding']) expect(html).toContain(title);
    expect(html.match(/1 account</g)).toHaveLength(5);
    expect(html).toContain('1 employee');
    expect(html).toContain('operator_admin');
    expect(html).toContain('platform_admin');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    for (const id of ['account-private-id', 'employee-private-id', 'assignment-private-id', 'operator-private-id', 'park-private-id']) expect(html).not.toContain(id);
  });

  it('preserves real status, audit time, null timestamp, source, archived state and password-change flag', () => {
    const html = markup(snapshot);
    for (const detail of ['Active', 'Inactive', 'Invited', 'No recorded sign-in', 'Password change required', 'OTO App', 'Archived', 'ZZ TEST Central']) expect(html).toContain(detail);
    expect(html).toMatch(/datetime="2026-10-22T03:04:05\.000Z"/i);
  });

  it('does not infer absent employee linkage from a hidden employee projection', () => {
    const html = markup({ ...snapshot, operatorWideHolders: [{ ...snapshot.operatorWideHolders[0]!, employee: null }] });
    expect(html).toContain('Employee not shown');
    expect(html).toContain('+66800000001');
    expect(html).not.toContain('No linked employee');
    expect(html).not.toContain('No employee exists');
  });

  it('keeps loading and failed reads separate from six genuine empty categories', () => {
    const pending = markup(null);
    expect(pending).toContain('role="status"');
    expect(pending).toContain('Loading access review');
    expect(pending).not.toContain('Operator-wide holders');
    const failed = markup(null, 'The review source did not answer.');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('The review source did not answer.');
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('0 accounts');
    expect(failed).not.toContain('No matching records');
    const empty = markup({ operatorWideHolders: [], platformWideHolders: [], accountsWithoutEmployee: [],
      employeesWithoutAccount: [], accountsNeverSignedIn: [], temporaryPasswordsOutstanding: [] });
    expect(empty.match(/0 accounts</g)).toHaveLength(5);
    expect(empty).toContain('0 employees');
    expect(empty.match(/No matching records in your reach\./g)).toHaveLength(6);
  });
});
