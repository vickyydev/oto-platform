import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { ApiError } from '@/api/client';
import type { BoothPrizeDraft } from '@/components/booth/boothApi';
import { PrizeEditor } from '@/components/booth/PrizeEditor';
import { readFailureMessage } from '@/components/booth/readState';

/**
 * THE PRIZE FORM SAYS WHAT THE API WILL REFUSE, BEFORE IT IS SENT (SCRUM-661).
 *
 * A tester's slice colour ended in the letter O, not a zero. The api's
 * HexColor rule rightly refused it, but the form had let it through and the
 * banner said only "Request does not match the schema" — no field, no rule.
 * These pin the two halves of the fix: the form blocks and names the bad
 * field inline, and a schema refusal that does arrive names its fields.
 */

let nextId = 0;
function prize(over: Partial<BoothPrizeDraft> = {}): BoothPrizeDraft {
  nextId += 1;
  return {
    id: `prize-${nextId}`,
    nameEn: `Prize ${nextId}`,
    nameTh: null,
    wheelLabel: null,
    weightBp: 1_200,
    active: true,
    expiryDays: null,
    dailyCap: null,
    costSatang: 0,
    sliceColor: null,
    textColor: null,
    sortOrder: nextId,
    voucherDefinitionId: null,
    voucherDefinitionCode: null,
    effectiveExpiryDays: null,
    ...over,
  };
}

const noop = () => undefined;
function editor(over: Partial<BoothPrizeDraft> = {}) {
  return renderToStaticMarkup(
    createElement(Router, { ssrPath: '/booths', children: createElement(PrizeEditor, {
      prize: prize(over),
      siblings: [],
      voucherDefinitions: [],
      saving: false,
      saveUnavailable: false,
      readOnly: false,
      error: null,
      onSave: noop,
      onArchive: noop,
      onClose: noop,
    }) }),
  );
}

/** The save button's disabled state — the attribute, not the always-present `disabled:` class variants. */
function saveDisabled(html: string): boolean {
  const button = html.match(/<button[^>]*>(?:Save|Add prize)<\/button>/);
  expect(button).not.toBeNull();
  return /\sdisabled(?:=""|="disabled")?(?:\s|>)/.test(button![0]);
}

describe('the prize form refuses what the api would refuse (SCRUM-661)', () => {
  it('a colour ending in the letter O is named in words and blocks the save', () => {
    const html = editor({ sliceColor: '#FFF13O' });
    expect(html).toContain('six hex digits');
    expect(html).toContain('letter O');
    expect(saveDisabled(html)).toBe(true);
  });

  it('the same colour with a real zero passes and the save is offered', () => {
    const html = editor({ sliceColor: '#FFF130', textColor: '#111111' });
    expect(html).not.toContain('six hex digits');
    expect(saveDisabled(html)).toBe(false);
  });

  it('shorthand and bare colours are refused; empty is allowed', () => {
    expect(saveDisabled(editor({ textColor: '#fff' }))).toBe(true);
    expect(saveDisabled(editor({ sliceColor: 'E23B3B' }))).toBe(true);
    expect(saveDisabled(editor({ sliceColor: null, textColor: null }))).toBe(false);
  });

  it('a zero or fractional daily cap, expiry or a negative order is said and blocks', () => {
    expect(saveDisabled(editor({ dailyCap: 0 }))).toBe(true);
    expect(editor({ dailyCap: 0 })).toContain('1 or more');
    expect(saveDisabled(editor({ expiryDays: 2.5 }))).toBe(true);
    expect(saveDisabled(editor({ sortOrder: -1 }))).toBe(true);
    expect(saveDisabled(editor({ dailyCap: 3, expiryDays: 7, sortOrder: 0 }))).toBe(false);
  });
});

describe('a schema refusal names its fields (SCRUM-661)', () => {
  it('VALIDATION details reach the banner as field: reason', () => {
    const refusal = new ApiError(400, 'VALIDATION', 'Request does not match the schema', [
      { instancePath: '/sliceColor', message: 'A colour is #RRGGBB' },
    ]);
    expect(readFailureMessage(refusal)).toBe('Request does not match the schema — sliceColor: A colour is #RRGGBB');
  });

  it('other failures keep their own words', () => {
    expect(readFailureMessage(new ApiError(409, 'BOOTH_PRIZE_NAME_TAKEN', 'That name is already on this booth'))).toBe(
      'That name is already on this booth',
    );
    expect(readFailureMessage(new Error('boom'))).toBe('boom');
    expect(readFailureMessage(undefined)).toBe('The request failed.');
  });
});
