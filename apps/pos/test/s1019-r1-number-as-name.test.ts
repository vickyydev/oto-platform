import * as React from 'react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { nameForNewMember, newMemberName } from '@/lib/membershipCheck';
import { formatStoredPhone } from '@/lib/phoneUtils';
import { profileGuardianName } from '@/lib/returningFamily';
import type { Member, Sale } from '@/types';

/**
 * SCRUM-1019, R1 — A NUMBER GIVEN WITH NO NAME (the owner's answer of 19
 * November 2026, docs/progress/plans/dropoff-beo-20261119/ANSWERS.md §8): the
 * customer is made with the number itself as the name until a name is given,
 * and no "New member?" box is opened for it.
 *
 * - The till creates the member by itself with the number, in the form the
 *   till shows a number, when the family gave no name.
 * - A member still held under their number has no name yet: the drop-off and
 *   nanny forms ask for the parent's, an event pass asks staff for it, and the
 *   booking site neither greets by it nor books under it.
 * - The customer display does not read the number out as a name: the welcome
 *   screen's greeting without a name ("Welcome to Oto"), and "Member rate
 *   applied" kept where it applies.
 *
 * Demo data only: every number and name below is a ZZ TEST fixture.
 */

vi.mock('@/api/platform', () => ({ membersApi: { lookup: vi.fn(), create: vi.fn() } }));

// The unit runner has no React plugin, so the components' JSX compiles to
// the classic `React.createElement` and needs `React` in scope.
Object.assign(globalThis, { React });

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const HELD = '+66 61 919 1101';
const held: Member = { id: '0192f000-0000-7000-8000-000000011019', phone: '+66619191101', nickname: HELD };
const named: Member = { id: '0192f000-0000-7000-8000-000000011020', phone: '+66619191102', nickname: 'ZZ TEST R1 Mali' };

const saleAt = (tier: string) => ({ id: 'sale-r1', operatorId: 'acc-zz', operatorName: 'ZZ TEST Som', tier, total: 0,
  lines: [], manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: 0 }, createdAt: '', status: 'paid',
  refunds: [] }) as unknown as Sale;

/** The welcome screen as the page draws it, in English, with the real dictionary. */
const welcome = (member: Member | null, tier = 'tourist') =>
  renderToStaticMarkup(createElement(LanguageProvider, {
    children: createElement(CustomerDisplay, {
      stage: 'welcome', sale: saleAt(tier), phone: '', nickname: '', member,
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
      onCustomerDone: () => undefined,
    }),
  })).replace(/&#x27;/g, "'");

describe('R1 — the name a new member is created with', () => {
  it('is the name the family gave; with none, the number as the till shows one', () => {
    expect(nameForNewMember('  ZZ TEST R1 Mali ', '0619191101')).toBe('ZZ TEST R1 Mali');
    expect(nameForNewMember('', '0619191101')).toBe(HELD);
    expect(nameForNewMember(undefined, '+66 61-919-1101')).toBe(HELD);
    expect(nameForNewMember('   ', '0619191101')).toBe(formatStoredPhone('0619191101'));
  });

  it('a number that does not read as one, with no name, makes nobody: the till goes on as before', () => {
    expect(nameForNewMember('', 'not a number')).toBeNull();
    // The family's own name is never replaced by the number.
    expect(newMemberName('ZZ TEST R1 Mali')).toBe('ZZ TEST R1 Mali');
  });

  it('the till asks staff nothing for a number with no name: the box only after a create that failed', () => {
    const till = src('pages/Till.tsx');
    const identify = till.slice(till.indexOf('const identifyPhone = ('), till.indexOf('const handleIdentify = '));
    expect(identify).toContain('const name = !mapped && phone ? nameForNewMember(nickname, phone) : null;');
    expect(identify).toContain('mapped = await createMemberForNumber({ phone, name, channel });');
    expect(identify).not.toContain('newMemberName(');
    // Said once, as the number, when the number is the name.
    expect(identify).toContain('description: nameIsPhoneNumber(mapped.nickname) ? mapped.nickname : `${mapped.nickname} · ${mapped.phone}`');
  });
});

describe('R1 — a member still held under their number has no name yet', () => {
  it('the drop-off and nanny forms ask for the parent’s name, as for any profile with no name', () => {
    expect(profileGuardianName(held, null)).toBeNull();
    expect(profileGuardianName(named, null)).toBe('ZZ TEST R1 Mali');
    // A member created on this sale is asked, as before.
    expect(profileGuardianName(named, named.id)).toBeNull();
  });

  it('an event pass asks staff for the parent’s name rather than taking the number', () => {
    const modal = src('components/parties/AddAttendeeModal.tsx');
    expect(modal).toContain("parentName: nameIsPhoneNumber(member.nickname) ? '' : member.nickname || '',");
  });

  it('the booking site neither greets by the number nor books under it', () => {
    const book = src('pages/Book.tsx');
    expect(book).toContain('const resolvedName = found && !nameIsPhoneNumber(found.nickname) ? found.nickname : nick.trim();');
  });
});

describe('R1 — the customer display does not read the number out as a name', () => {
  it('a member held under their number is welcomed without a name', () => {
    const html = welcome(held);
    expect(html).toContain('Welcome to Oto');
    expect(html).not.toContain('Welcome back');
    expect(html).not.toContain(`${HELD}!`);
  });

  it('the header strip names nobody for them through the sale, as before such a member existed', () => {
    // The strip ("Customer  <name>") is on every screen after the number; the
    // welcome screen and the paid screen stand for the rest (one `displayName`).
    const paid = (member: Member | null, nickname = '') =>
      renderToStaticMarkup(createElement(LanguageProvider, {
        children: createElement(CustomerDisplay, {
          stage: 'payment', sale: saleAt('tourist'), phone: '', nickname, member,
          payment: { status: 'paid' } as never,
          onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
          onCustomerDone: () => undefined,
        }),
      })).replace(/&#x27;/g, "'");
    for (const html of [welcome(held), paid(held)]) {
      expect(html).not.toContain(HELD);
      expect(html).not.toContain('>Customer<');
    }
    // A member with a name, or a name typed on the first screen, is shown there as before.
    expect(welcome(named)).toContain('>ZZ TEST R1 Mali<');
    expect(paid(named)).toContain('>ZZ TEST R1 Mali<');
    expect(paid(held, 'ZZ TEST R1 Nok')).toContain('>ZZ TEST R1 Nok<');
    const display = src('components/till/CustomerDisplay.tsx');
    expect(display).toContain(
      "nickname.trim() || (member && !nameIsPhoneNumber(member.nickname) ? member.nickname : '');",
    );
  });

  it('keeps "Member rate applied" for them where their rate is the sale’s', () => {
    expect(welcome(held, 'expat')).toContain('Member rate applied');
    expect(welcome(held, 'tourist')).not.toContain('Member rate applied');
  });

  it('a member with a name is welcomed back by it, as before; a walk-in as before', () => {
    expect(welcome(named)).toContain('Welcome back, ZZ TEST R1 Mali!');
    expect(welcome(named, 'expat')).toContain('Member rate applied');
    const walkIn = welcome(null, 'expat');
    expect(walkIn).toContain('Welcome to Oto');
    expect(walkIn).not.toContain('Member rate applied');
  });
});
