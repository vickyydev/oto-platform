import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DepartmentDirectory } from '@/api/departments';
import { DepartmentsContent } from '@/pages/Departments';

const directory: DepartmentDirectory = { departments: [
  { id: 'reception', name: 'ZZ TEST Reception', branch: { id: 'park', name: 'ZZ TEST Central' }, memberCount: 17 },
  { id: 'marketing', name: 'ZZ TEST Marketing', branch: null, memberCount: 0 },
] };
const noop = () => undefined;
function markup(data: DepartmentDirectory | null, options: { error?: string; query?: string } = {}) {
  return renderToStaticMarkup(createElement(DepartmentsContent, {
    data, error: options.error ?? null, query: options.query ?? '', onRetry: noop,
  }));
}

describe('Departments read-only directory', () => {
  it('shows returned names, park or operator-wide coverage and positive or zero member counts', () => {
    const html = markup(directory);
    for (const detail of ['ZZ TEST Reception', 'ZZ TEST Central', 'ZZ TEST Marketing', 'Operator-wide · no park', 'Member count']) {
      expect(html).toContain(detail);
    }
    expect(html).toMatch(/>17<\/dd>/);
    expect(html).toMatch(/>0<\/dd>/);
    expect(html).toContain('aria-label="Departments"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });

  it('formats the returned large count without inferring membership from rows on the page', () => {
    const html = markup({ departments: [{ ...directory.departments[0]!, memberCount: 23014 }] });
    expect(html).toContain('23,014');
    expect(html).not.toContain('ZZ TEST Marketing');
  });

  it('keeps pending or failed reads separate from a directory with no reachable departments', () => {
    const pending = markup(null);
    expect(pending).toContain('role="status"');
    expect(pending).toContain('Loading departments');
    expect(pending).not.toContain('Member count');
    const failed = markup(null, { error: 'The department source did not answer.' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('The department source did not answer.');
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('No departments');
    expect(failed).not.toContain('Member count');
  });

  it('distinguishes a successful reachable-empty directory from a successful search with no matches', () => {
    expect(markup({ departments: [] })).toContain('No departments in your reach');
    expect(markup({ departments: [] }, { query: 'Nobody' })).toContain('No matching departments');
    expect(markup({ departments: [] }, { query: '  ' })).toContain('No departments in your reach');
  });
});
