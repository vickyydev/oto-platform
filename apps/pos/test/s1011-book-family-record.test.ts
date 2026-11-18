import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedChildrenReview } from '@/components/shared/SavedChildrenReview';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { publicApi } from '@/api/platform';
import { DICTIONARY } from '@/i18n/dictionary';
import {
  bookingLineSavedChildId,
  familySaveChildren,
  linkSavedChildren,
  livePass,
} from '@/lib/bookFamilyRecord';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
beforeEach(() => { vi.stubGlobal('React', React); });
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * SCRUM-1011 — THE BOOKING SITE SAVES A RETURNING FAMILY'S CHANGES TO THEIR
 * RECORD (the owner's ruling of 18 and 19 November: plain, at the parent's
 * confirm paid or not, "Remove from saved" online, the contact app too).
 *
 * The site sends the family pass the code check answered and, per child, the
 * saved child it is or the id it minted for a new one; the review's note says
 * when the record changes, in the family's language. These pin the rule the
 * page uses (`lib/bookFamilyRecord.ts`), what the client sends, the page's
 * wiring to the confirm and remove presses, and the words.
 */

const slot = (over: Partial<SupervisedSlot>): SupervisedSlot => ({
  id: 'place-1',
  sourceLineId: 'line-1',
  ticketType: { id: 'pkg', name: '1 Hour Play', durationLabel: '1 hour', hours: 1, prices: {} } as SupervisedSlot['ticketType'],
  name: '',
  age: '',
  waived: false,
  optIn: true,
  allergiesMedical: '',
  foodRestrictions: '',
  mayOrderFood: false,
  ...over,
});

describe('SCRUM-1011 (1): what the site sends at the parent\'s confirm', () => {
  it('names a saved child by its id and a new one by an id it mints once per place', () => {
    const slots = [
      slot({ id: 'a', savedChildId: '0192f0a0-0000-7000-8000-00000000000a', name: 'ZZ TEST Aya', age: '6', dateOfBirth: '2020-03-01', allergiesMedical: 'Peanuts and sesame' }),
      slot({ id: 'b', name: 'ZZ TEST Dao', age: '4', foodRestrictions: 'Vegetarian' }),
      slot({ id: 'c', name: '', age: '5' }),
      slot({ id: 'd', name: 'ZZ TEST Unaged', age: '' }),
    ];
    let n = 0;
    const mint = () => `0192f0a0-0000-7000-8000-00000000010${n++}`;
    const first = familySaveChildren(slots, {}, mint);
    expect(first.children).toEqual([
      { savedChildId: '0192f0a0-0000-7000-8000-00000000000a', name: 'ZZ TEST Aya', dateOfBirth: '2020-03-01',
        ageYears: first.children[0]!.ageYears, allergies: 'Peanuts and sesame', foodRestrictions: '' },
      { newChildId: '0192f0a0-0000-7000-8000-000000000100', name: 'ZZ TEST Dao', dateOfBirth: null, ageYears: 4,
        allergies: '', foodRestrictions: 'Vegetarian' },
    ]);
    expect(first.minted).toEqual({ b: '0192f0a0-0000-7000-8000-000000000100' });
    // A second confirm is the same child, not a second one.
    const again = familySaveChildren(slots, first.minted, mint);
    expect(again.children[1]).toMatchObject({ newChildId: '0192f0a0-0000-7000-8000-000000000100' });
    expect(n).toBe(1);
  });

  it('links each place that added a child to it once the platform holds it', () => {
    const slots = [slot({ id: 'b', name: 'ZZ TEST Dao', age: '4' }), slot({ id: 'e', name: 'ZZ TEST Eve', age: '3' })];
    const links = linkSavedChildren(slots, { b: 'kid-b', e: 'kid-e' }, new Set(['kid-b']));
    expect(links).toEqual([{ slotId: 'b', savedChildId: 'kid-b' }]);
  });

  it('sends the pass only while it is live, and a booking line names its saved child only with it', () => {
    const now = Date.parse('2026-11-19T10:00:00Z');
    expect(livePass(null, now)).toBeNull();
    expect(livePass({ pass: 'p', expiresAt: '2026-11-19T10:30:00Z' }, now)).toBe('p');
    expect(livePass({ pass: 'p', expiresAt: '2026-11-19T10:00:30Z' }, now), 'inside the minute it runs out').toBeNull();
    expect(livePass({ pass: 'p', expiresAt: '2026-11-19T09:00:00Z' }, now)).toBeNull();
    expect(bookingLineSavedChildId({ savedChildId: 'kid' }, 'p')).toEqual({ savedChildId: 'kid' });
    expect(bookingLineSavedChildId({ savedChildId: 'kid' }, null)).toEqual({});
    expect(bookingLineSavedChildId(undefined, 'p')).toEqual({});
  });

  it('posts the pass, the children, the removals and the contact app to the save route', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ children: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await publicApi.savedChildrenSave({
      phone: '0812011011', branch: 'hkt-central', pass: 'zz-pass', contactChannel: 'telegram',
      children: [{ savedChildId: '0192f0a0-0000-7000-8000-00000000000a', name: 'ZZ TEST Aya', ageYears: 6 }],
      remove: ['0192f0a0-0000-7000-8000-00000000000b'],
    });
    expect(seen).toEqual([{
      url: '/api/public/saved-children/save',
      body: {
        phone: '0812011011', branch: 'hkt-central', pass: 'zz-pass', contactChannel: 'telegram',
        children: [{ savedChildId: '0192f0a0-0000-7000-8000-00000000000a', name: 'ZZ TEST Aya', ageYears: 6 }],
        remove: ['0192f0a0-0000-7000-8000-00000000000b'],
      },
    }]);
  });
});

describe('SCRUM-1011 (2): the page saves at the confirm and removes at "Remove from saved"', () => {
  const page = readFileSync(resolve(__dirname, '../src/pages/Book.tsx'), 'utf8');

  it('"Continue to payment" on the consent step is the confirm: it saves, then goes on', () => {
    expect(page).toMatch(/disabled=\{!consentOk \|\| savingFamily\}[\s\S]{0,400}onClick=\{\(\) => saveFamilyThen\(\(\) => setStage\('pay'\)\)\}/);
    expect(page).toContain("publicApi\n      .savedChildrenSave({ phone, branch: park, pass, children, contactChannel })");
  });

  it('"Remove from saved" takes the child off the record with the pass, and empties the place', () => {
    expect(page).toContain('publicApi.savedChildrenSave({ phone, branch: park, pass, children: [], remove: [childId] })');
    expect(page).not.toContain('const handleRemoveSaved = (slotId: string, _childId: string) => {\n    handleMarkNew(slotId);\n  };');
    // The emptied place stays empty: the removed child is held beside the
    // member, so the pre-fill does not re-run and put another child into it,
    // and it is never offered or pre-filled again on this page.
    expect(page).toContain('removedSaved.current.add(childId);\n        handleMarkNew(slotId);');
    expect(page).toContain('const saved = (member?.savedChildren ?? []).filter((c) => !removedSaved.current.has(c.id));');
    expect(page).toContain('savedChildren={liveSavedChildren(member)}');
  });

  it('the booking carries the pass and each supervised child\'s saved id', () => {
    expect(page).toContain("...(pass ? { familyPass: pass } : {}),");
    expect(page).toContain('...bookingLineSavedChildId(superSlots.find((s) => s.id === l.id), pass),');
  });

  it('the review on the site names its store and speaks the family\'s language', () => {
    expect(page).toContain('detailsStore="family-record-online"');
    expect(page).toMatch(/detailsStore="family-record-online"[\s\S]{0,300}lang=\{lang\}/);
  });
});

describe('SCRUM-1011 (3): the words', () => {
  const review = (lang: 'en' | 'ru') => {
    const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
      Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
    return words(renderHook(() => SavedChildrenReview({
      slots: [{ id: 'a', savedChildId: 'zz-child-1', name: 'ZZ TEST Aya', age: '6', dateOfBirth: '2020-01-01' }],
      savedChildren: [{ id: 'zz-child-1', childName: 'ZZ TEST Aya', dateOfBirth: '2020-01-01', childAge: 6 }],
      confirmedIds: [], detailsStore: 'family-record-online', lang,
      onUpdateSlot: () => undefined, onConfirmSlot: () => undefined, onAssignSaved: () => undefined, onMarkNew: () => undefined,
      onRemoveSaved: () => undefined, onBack: () => undefined, onContinue: () => undefined, canContinue: false,
    })).result.current);
  };

  it('the review note says the changes are saved to the family\'s record, and when', () => {
    const text = review('en');
    expect(text).toContain("The changes you make here are saved to your family's record when you continue to payment, whether or not you pay");
    expect(text).toContain('“Remove from saved” takes a child off the record straight away.');
    expect(text).not.toContain('apply to this booking only');
    expect(review('ru')).toContain(DICTIONARY['childReview.noteBooking']!.ru);
  });

  it('every new or changed sentence is in every language of the dictionary', () => {
    const languages = Object.keys(DICTIONARY['common.back']!);
    for (const key of ['childReview.noteBooking', 'book.family.checkExpired', 'book.family.saveFailed', 'book.family.removeNeedsCheck']) {
      const entry = DICTIONARY[key]! as Record<string, string>;
      expect(Object.keys(entry).sort(), key).toEqual([...languages].sort());
      for (const lang of languages) expect(entry[lang]!.trim().length, `${key} ${lang}`).toBeGreaterThan(0);
    }
  });
});
