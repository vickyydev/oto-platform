import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LANG, type SupportedLang } from './types';
import { lookup } from './dictionary';
// Sprint 1 rebuild (SCRUM-17): the shared i18n scaffold (@oto/shared, en+th
// message files) is consulted FIRST; the prototype's full 5-language
// dictionary remains the fallback so zh/ru/fr keep rendering (Q2/D4).
import { lookupMessage } from '@oto/shared/i18n';

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

interface LanguageContextValue {
  lang: SupportedLang;
  setLang: (lang: SupportedLang) => void;
  t: TFunction;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match
  );
}

// App-wide language selection for CUSTOMER-FACING chrome only. React state
// only (no persistence) — a full reload always resets to English, matching
// the project's no-browser-storage rule. Staff/admin screens never call t()
// so they render in English regardless of the selected language.
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<SupportedLang>(DEFAULT_LANG);

  const t = useMemo<TFunction>(
    () => (key, vars) => {
      const raw = lookupMessage(lang, key) ?? lookup(key, lang);
      if (raw === undefined) return key; // missing key -> surface the key, never crash
      return interpolate(raw, vars);
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
