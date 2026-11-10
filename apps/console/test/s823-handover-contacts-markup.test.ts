import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BIRTHDAY_MANAGER_SENTENCE,
  EMPTY_CONTACT,
  GM_CONTACT_SENTENCE,
  HandoverContactsField,
  contactBody,
  contactChanged,
  draftOf,
} from '@/components/HandoverContactsField';

/**
 * SCRUM-823 — the branch editor names who an inbox Birthdays & Events
 * hand-over tells: the birthday manager on duty (at once, in the OTO App and
 * by a ping) and the GM (once, after fifteen minutes with nobody on it).
 */

const markup = (props: Partial<Parameters<typeof HandoverContactsField>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(HandoverContactsField, {
      birthdayManager: { ...EMPTY_CONTACT },
      gm: { ...EMPTY_CONTACT },
      fieldClass: 'field',
      onBirthdayManager: () => undefined,
      onGm: () => undefined,
      ...props,
    }),
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

describe('Birthday manager on duty and GM contact', () => {
  it('shows both settings, each with a person, an OTO App user, a phone and the ping channel', () => {
    const html = markup({ birthdayManager: { name: 'ZZ TEST Manager', appUserId: 'user-1', phone: '+66812345678', channel: 'telegram' } });
    expect(html).toContain('Birthday manager on duty');
    expect(html).toContain('GM contact');
    expect(html).toContain(BIRTHDAY_MANAGER_SENTENCE);
    expect(html).toContain(GM_CONTACT_SENTENCE);
    expect(BIRTHDAY_MANAGER_SENTENCE).toMatch(/manager not notified/);
    expect(GM_CONTACT_SENTENCE).toMatch(/15 minutes/);
    // The phone ping is not promised while the sender only writes to the log.
    expect(BIRTHDAY_MANAGER_SENTENCE).toMatch(/only written to the log until the WhatsApp\/Telegram sender is live/);
    expect(GM_CONTACT_SENTENCE).toMatch(/only logged until the WhatsApp\/Telegram sender is live/);
    expect(BIRTHDAY_MANAGER_SENTENCE).not.toMatch(/by a ping to this number/);
    expect(html).toContain('value="ZZ TEST Manager"');
    expect(html).toContain('value="user-1"');
    expect(html).toContain('value="+66812345678"');
    expect(html).toContain('<option value="telegram" selected="">Telegram</option>');
  });

  it('sends a contact only when it changed, and clears one that names nobody', () => {
    const stored = { name: 'ZZ TEST Manager', appUserId: 'user-1', phone: '+66812345678', channel: 'whatsapp' as const };
    expect(contactChanged(draftOf(stored), stored)).toBe(false);
    expect(contactChanged(draftOf(null), null)).toBe(false);
    expect(contactChanged({ ...draftOf(stored), phone: '+66899999999' }, stored)).toBe(true);
    expect(contactBody({ ...EMPTY_CONTACT, name: 'Only a name' })).toBeNull();
    expect(contactBody({ ...EMPTY_CONTACT, phone: ' 081 234 5678 ' })).toEqual({ name: null, appUserId: null, phone: '081 234 5678', channel: 'whatsapp' });
  });

  it('the branch editor carries both settings and saves them with the branch', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/pages/Branches.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('<HandoverContactsField');
    expect(source).toContain('body.birthdayManagerContact = contactBody(birthdayManager)');
    expect(source).toContain('body.gmContact = contactBody(gmContact)');
  });
});
