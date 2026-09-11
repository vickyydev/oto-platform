import { en, type MessageKey } from './en';
import { th } from './th';

export type { MessageKey };

export const messages: Record<'en' | 'th', Record<MessageKey, string>> = { en, th };

/** Scaffold lookup: returns undefined for languages/keys not yet migrated. */
export function lookupMessage(lang: string, key: string): string | undefined {
  const table = (messages as Record<string, Record<string, string>>)[lang];
  return table?.[key];
}
