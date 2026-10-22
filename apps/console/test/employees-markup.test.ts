import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { employeeSourcePath, type EmployeeDirectory } from '@/api/employees';
import { EmployeesContent } from '@/pages/Employees';

const directory: EmployeeDirectory = { employees: [{
  id: 'employee', name: 'ZZ TEST Directory', nickname: 'Dir', source: 'otoapp', externalId: 'legacy-employee_007',
  archivedAt: '2026-10-21T08:00:00.000Z', branch: { id: 'park', name: 'ZZ TEST Park' },
  department: { id: 'department', name: 'Reception' },
  accounts: [
    { id: 'one', phone: '+66800000001', status: 'active', lastSignInAt: '2026-10-22T03:04:05.000Z' },
    { id: 'two', phone: '+66800000002', status: 'inactive', lastSignInAt: null },
  ],
  lastSignInAt: '2026-10-22T03:04:05.000Z',
}] };
const noop = () => undefined;
function markup(data: EmployeeDirectory | null, options: { error?: string; sourceAccess?: boolean; query?: string } = {}) {
  return renderToStaticMarkup(createElement(EmployeesContent, {
    data, error: options.error ?? null, sourceAccess: options.sourceAccess ?? true,
    query: options.query ?? '', onRetry: noop, openingEmployee: null, onOpenSource: noop,
  }));
}

describe('Employees read-only directory', () => {
  it('shows source, park, department, every linked login, archived state and successful-sign-in timestamps', () => {
    const html = markup(directory);
    for (const detail of ['ZZ TEST Directory', 'Dir', 'OTO App', 'ZZ TEST Park', 'Reception',
      '+66800000001', '+66800000002', 'Active', 'Inactive', 'Archived', 'No recorded sign-in']) expect(html).toContain(detail);
    expect(html).toMatch(/datetime="2026-10-22T03:04:05\.000Z"/i);
    expect(html).toContain('Open in OTO App');
    for (const action of ['Invite', 'Edit employee', 'Save', 'Deactivate', 'Delete']) expect(html).not.toContain(action);
  });

  it('names absent mirror fields and visible login state honestly without inventing a source target', () => {
    const html = markup({ employees: [{ ...directory.employees[0]!, source: 'platform', externalId: null,
      branch: null, department: null, accounts: [], lastSignInAt: null }] });
    for (const detail of ['Platform', 'No park recorded', 'No department recorded', 'No visible linked sign-in']) expect(html).toContain(detail);
    expect(html).not.toContain('Open in OTO App');
  });

  it('separates pending, source failure, reachable empty and filtered empty states', () => {
    expect(markup(null)).toContain('Loading employees');
    const failed = markup(null, { error: 'Employee source is unavailable.' });
    expect(failed).toContain('Employee source is unavailable.');
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('No employees');
    expect(markup({ employees: [] })).toContain('No employees in your reach');
    expect(markup({ employees: [] }, { query: 'Nobody' })).toContain('No matching employees');
  });

  it('withholds source actions when app access or a safe mirrored identifier is absent', () => {
    const noAccess = markup(directory, { sourceAccess: false });
    expect(noAccess).toContain('OTO App is not on your access.');
    expect(noAccess).not.toContain('Open in OTO App');
    const noSource = markup({ employees: [{ ...directory.employees[0]!, externalId: null }] });
    expect(noSource).toContain('The source employee link is unavailable.');
    expect(noSource).not.toContain('Open in OTO App');
  });

  it('keeps opaque source IDs usable while refusing targets that can escape the employee segment', () => {
    expect(employeeSourcePath({ source: 'otoapp', externalId: 'legacy-employee_007' })).toBe('/employees/legacy-employee_007');
    expect(employeeSourcePath({ source: 'otoapp', externalId: 'legacy employee' })).toBe('/employees/legacy%20employee');
    for (const externalId of [null, '', '.', '..', '../users', 'one/two', 'one\\two', 'one\n', '%2fusers']) {
      expect(employeeSourcePath({ source: 'otoapp', externalId })).toBeNull();
    }
    expect(employeeSourcePath({ source: 'platform', externalId: 'legacy-employee_007' })).toBeNull();
  });
});
