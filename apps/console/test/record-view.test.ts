import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RawRecord, RecordDiff, RecordFields } from '@/components/RecordView';

const fields = (record: unknown) => renderToStaticMarkup(createElement(RecordFields, { record }));
const diff = (before: unknown, after: unknown) => renderToStaticMarkup(createElement(RecordDiff, { before, after }));
const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('native audit JSON rendering (SCRUM-644)', () => {
  it('keeps the no-state message for absent before and after records', () => {
    expect(diff(null, null)).toContain('This action recorded no before or after state.');
    expect(fields(null)).toContain('No record was stored with this entry.');
  });

  it('keeps object field changes and omits unchanged fields', () => {
    const html = diff({ count: 1, unchanged: 'ZZ TEST retained' }, { count: 2, unchanged: 'ZZ TEST retained' });
    expect(html).toContain('Count');
    expect(text(html)).toContain('was 1');
    expect(text(html)).toContain('now 2');
    expect(html).not.toContain('Unchanged');
  });

  it('does not claim that a masked object field changed or stayed the same', () => {
    const html = diff({ phone: '[redacted]' }, { phone: '[redacted]' });
    expect(html).toContain('Also in this record, hidden:');
    expect(html).toContain('whether they changed cannot be told from a masked read.');
    expect(html).not.toContain('was ');
    expect(html).not.toContain('now ');
  });

  it('retains array entries, nested JSON and masked values in the existing field presentation', () => {
    const html = fields([0, false, { state: 'ZZ TEST nested' }, '[redacted]']);
    expect(text(html)).toContain('0');
    expect(text(html)).toContain('false');
    expect(html).toContain('ZZ TEST nested');
    expect(text(html)).toContain('hidden');
  });

  it.each([false, 0, ''])('renders the present root value %j instead of saying no record was stored', value => {
    const html = fields(value);
    expect(html).not.toContain('No record was stored');
    expect(text(html)).toContain(value === '' ? 'empty' : String(value));
  });

  it.each([
    { before: false, after: true, was: 'false', now: 'true' },
    { before: 0, after: 1, was: '0', now: '1' },
    { before: '', after: 'ZZ TEST ready', was: 'empty', now: 'ZZ TEST ready' },
    { before: 0, after: false, was: '0', now: 'false' },
  ])('shows the whole root change from $was to $now', ({ before, after, was, now }) => {
    const html = diff(before, after);
    expect(text(html)).toContain(`was ${was}`);
    expect(text(html)).toContain(`now ${now}`);
    expect(html).not.toContain('This action recorded no before or after state.');
    expect(html).not.toContain('Nothing changed');
  });

  it('distinguishes unchanged zero from absent state', () => {
    const html = diff(0, 0);
    expect(html).toContain('Nothing changed');
    expect(html).not.toContain('This action recorded no before or after state.');
  });

  it('retains the raw JSON shape and escapes text rather than creating markup', () => {
    const record = { before: [false, 0, ''], after: { state: '<script>ZZ TEST</script>' } };
    const html = renderToStaticMarkup(createElement(RawRecord, { record }));
    expect(html).toContain('false');
    expect(html).toContain('&lt;script&gt;ZZ TEST&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(JSON.stringify(record)).toBe('{"before":[false,0,""],"after":{"state":"<script>ZZ TEST</script>"}}');
  });
});
