/**
 * i18n scaffold — English message file (the source language, CLAUDE.md §7.5).
 * Keys mirror the prototype dictionary (`src/i18n/dictionary.ts`) so the ported
 * POS resolves scaffold keys first and falls back to its full 5-language
 * prototype dictionary for everything not yet migrated here.
 */
export const en = {
  'till.identify.membersSave': 'Members save',
  'till.identify.title': 'Are you a member?',
  'till.identify.subtitle': 'Enter your phone to get your member rate. New here? You can skip this.',
  'till.identify.phoneLabel': 'Phone Number',
  'till.identify.find': 'Find my membership',
  'till.identify.skip': "I'm not a member — skip",
  'common.language': 'Language',
} as const;

export type MessageKey = keyof typeof en;
