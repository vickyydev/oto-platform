import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OperatorSwitchPicker, type OperatorSwitchPickerProps } from '@/components/OperatorSwitchPicker';

const HOME = { id: '01964000-0000-7000-8000-000000000001', name: 'ZZ TEST Home operator' };
const TARGET = { id: '01964000-0000-7000-8000-000000000002', name: 'ZZ TEST Current operator' };
const UNKNOWN = { id: '01964000-0000-7000-8000-000000000003', name: 'ZZ TEST Unlisted operator' };
const ERROR = 'ZZ TEST The operator list could not be confirmed.';

function fixture(overrides: Partial<OperatorSwitchPickerProps> = {}): OperatorSwitchPickerProps {
  return { home: HOME, current: TARGET, options: [HOME, TARGET], epoch: 7, canSwitch: true,
    loading: false, switching: false, error: null, onSelect: vi.fn(async () => {}), onRetry: vi.fn(), ...overrides };
}
const render = (props: OperatorSwitchPickerProps) => renderToStaticMarkup(createElement(OperatorSwitchPicker, props));
function select(html: string) {
  const result = html.match(/<select\b[^>]*>[\s\S]*?<\/select>/);
  expect(result, 'A permitted picker must render the native select, not disappear.').not.toBeNull();
  return result![0];
}
const options = (html: string) => [...select(html).matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)]
  .map(([, attrs, label]) => {
    if (attrs === undefined || label === undefined) throw new Error('The native option capture is missing.');
    return { value: attrs.match(/\bvalue="([^"]*)"/)?.[1], selected: /\bselected(?:=|\s|$)/.test(attrs), label };
  });
const selected = (html: string) => options(html).filter(option => option.selected).map(option => option.value);
const disabled = (html: string) => /<select\b[^>]*\bdisabled(?:=|\s|>)/.test(select(html));

describe('Operator switch picker native markup', () => {
  it('offers no switch or operator options without switch authority', () => {
    const html = render(fixture({ canSwitch: false, error: ERROR }));
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<option');
    expect(html).not.toContain('Try again');
  });

  it('keeps the home operator visible and distinct from the current effective operator', () => {
    const html = render(fixture());
    expect(html).toContain('Home operator');
    expect(html).toContain(HOME.name);
    expect(html).toContain(TARGET.name);
    expect(selected(html)).toEqual([TARGET.id]);
  });

  it('selects the canonical current operator rather than the first option', () => {
    const html = render(fixture({ options: [UNKNOWN, HOME, TARGET] }));
    expect(selected(html)).toEqual([TARGET.id]);
    expect(disabled(html)).toBe(false);
  });

  it('continues to use the canonical current value while a switch is pending', () => {
    const html = render(fixture({ current: HOME, options: [TARGET, HOME], switching: true }));
    expect(selected(html)).toEqual([HOME.id]);
    expect(disabled(html)).toBe(true);
    expect(html).toContain(HOME.name);
  });

  it('shows an unselected disabled placeholder when the current context is unknown', () => {
    const html = render(fixture({ current: null }));
    expect(selected(html)).toEqual(['']);
    expect(disabled(html)).toBe(true);
    expect(html).toContain(HOME.name);
    expect(options(html).filter(option => option.selected && option.value === HOME.id)).toEqual([]);
  });

  it('does not manufacture an option or choose home when the current ID is missing from the confirmed list', () => {
    const html = render(fixture({ current: UNKNOWN }));
    expect(selected(html)).toEqual(['']);
    expect(disabled(html)).toBe(true);
    expect(options(html).map(option => option.value)).not.toContain(UNKNOWN.id);
    expect(options(html).filter(option => option.selected && option.value === HOME.id)).toEqual([]);
  });

  it('does not turn an empty directory into a selected home operator', () => {
    const html = render(fixture({ options: [] }));
    expect(selected(html)).toEqual(['']);
    expect(disabled(html)).toBe(true);
    expect(options(html).filter(option => option.value)).toEqual([]);
  });

  it.each([
    ['loading', { loading: true }],
    ['switching', { switching: true }],
    ['error', { error: ERROR }],
  ] satisfies Array<[string, Partial<OperatorSwitchPickerProps>]>)('disables the canonical select while %s', (_state, overrides) => {
    const html = render(fixture(overrides));
    expect(disabled(html)).toBe(true);
    expect(selected(html)).toEqual([TARGET.id]);
  });

  it('renders the actual failure with a native Retry offer instead of an empty successful list', () => {
    const html = render(fixture({ error: ERROR }));
    expect(html).toContain(ERROR);
    expect(html).toMatch(/<button\b[^>]*>Try again<\/button>/);
    expect(disabled(html)).toBe(true);
  });

  it('does not offer Retry for a successful directory', () => {
    const html = render(fixture());
    expect(select(html)).toContain(TARGET.id);
    expect(html).not.toContain('Try again');
  });

  it('offers only supplied confirmed choices, without appending an unknown current context', () => {
    const html = render(fixture({ current: UNKNOWN, options: [HOME, TARGET] }));
    expect(options(html).filter(option => option.value).map(option => option.value)).toEqual([HOME.id, TARGET.id]);
    expect(options(html).map(option => option.value)).not.toContain(UNKNOWN.id);
  });

  it('uses the native labelled select and width constraints for narrow screens', () => {
    const html = render(fixture());
    expect(html).toMatch(/<label\b[^>]*>[\s\S]*?Operator[\s\S]*?<select\b/);
    expect(select(html)).toMatch(/class="[^"]*min-w-0[^"]*max-w-full[^"]*"/);
    expect(html).toContain('flex-wrap');
    expect(html).not.toMatch(/style="[^"]*(?:min-width|width):\s*\d+px/);
  });

  it('escapes operator labels rather than rendering supplied names as markup', () => {
    const html = render(fixture({ home: { ...HOME, name: 'ZZ TEST Home <b>unsafe</b>' } }));
    expect(html).toContain('ZZ TEST Home &lt;b&gt;unsafe&lt;/b&gt;');
    expect(html).not.toContain('<b>unsafe</b>');
  });

  it('never switches or retries during rendering, including pending and error states', () => {
    for (const overrides of [{}, { loading: true }, { switching: true }, { error: ERROR }]) {
      const props = fixture(overrides);
      render(props);
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(props.onRetry).not.toHaveBeenCalled();
    }
  });
});
