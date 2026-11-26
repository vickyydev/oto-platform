import type { SupportedLang as SharedSupportedLang } from '@oto/shared/i18n';

// Supported customer-facing languages. Staff/admin surfaces are English-only
// and never read this — this is scoped to customer-facing chrome + a few
// translated catalog items (see resolveTranslation.ts).
// SCRUM-1077 — the one list is `SUPPORTED_LANGS` in @oto/shared: the language
// a guest chooses here is saved with the sale and read by the gate box.
export type SupportedLang = SharedSupportedLang;

export const DEFAULT_LANG: SupportedLang = 'en';

export interface LanguageOption {
  code: SupportedLang;
  label: string; // English name, for reference/admin
  nativeLabel: string; // shown on the switcher itself
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'th', label: 'Thai', nativeLabel: 'ไทย' },
  { code: 'ru', label: 'Russian', nativeLabel: 'Русский' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
];
