import type { SupportedLang } from '@/i18n/types';
import { tFor } from '@/i18n/LanguageContext';
import { resolveName } from '@/i18n/resolveTranslation';
import type { TicketType } from '@/types';

/**
 * The words a ticket card shows: the name and the "per person" caption.
 *
 * A customer-facing surface (the booking site's picker) names its language
 * and gets the catalog's translation. A staff surface names none and gets the
 * original name and English, whatever the customer display beside it is set
 * to — the approved prototype's till showed the plain ticket name (SCRUM-698).
 */
export function ticketCardCopy(
  ticket: Pick<TicketType, 'name' | 'translations'>,
  lang?: SupportedLang,
): { name: string; perPerson: string } {
  const t = tFor(lang ?? 'en');
  return {
    name: lang ? resolveName(ticket, lang) : ticket.name,
    perPerson: t('book.tickets.perPerson'),
  };
}
