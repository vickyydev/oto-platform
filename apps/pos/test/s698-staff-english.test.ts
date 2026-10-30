import { describe, expect, it } from 'vitest';
import { tFor } from '@/i18n/LanguageContext';
import { ticketCardCopy } from '@/lib/ticketCardCopy';

/**
 * SCRUM-698: the till and its built-in customer-display panel share one
 * language setting. The staff ticket card must show the original name and
 * English captions whatever that setting is; a customer surface that names
 * its language gets the translation.
 */
const ticket = {
  name: '1 Hour Play',
  translations: { ru: { name: 'Игра 1 час' }, th: { name: 'เล่น 1 ชั่วโมง' } },
};

describe('the staff till stays in English', () => {
  it('a card with no language named shows the original name and "per person"', () => {
    expect(ticketCardCopy(ticket)).toEqual({ name: '1 Hour Play', perPerson: 'per person' });
  });

  it('a customer surface that names Russian gets the translated name and caption', () => {
    expect(ticketCardCopy(ticket, 'ru')).toEqual({ name: 'Игра 1 час', perPerson: 'с человека' });
  });

  it('a language with no translation falls back to the original name', () => {
    expect(ticketCardCopy(ticket, 'fr').name).toBe('1 Hour Play');
  });

  it('tFor answers each language on its own, outside any provider', () => {
    expect(tFor('en')('book.tickets.perPerson')).toBe('per person');
    expect(tFor('th')('book.tickets.perPerson')).toBe('ต่อคน');
    expect(tFor('en')('no.such.key')).toBe('no.such.key');
  });
});
