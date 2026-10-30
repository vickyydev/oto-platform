import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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

/**
 * The translator for one language, outside any provider. A staff screen that
 * must stay in English whatever the customer display beside it is set to
 * (the till and its built-in display panel share one provider) reads
 * `tFor('en')` rather than the context (SCRUM-698).
 */
export function tFor(lang: SupportedLang): TFunction {
  return (key, vars) => {
    const raw = lookupMessage(lang, key) ?? lookup(key, lang);
    if (raw === undefined) return key; // missing key -> surface the key, never crash
    return interpolate(raw, vars);
  };
}

// Customer-facing language stays in memory by default. The independently
// paired display supplies its own storage key so its choice survives reload.
// Staff/admin screens remain in English.
export function LanguageProvider({ children, storageKey }: { children: ReactNode; storageKey?: string }) {
  const [lang, setLang] = useState<SupportedLang>(() => {
    if (!storageKey) return DEFAULT_LANG;
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved === 'en' || saved === 'th' || saved === 'zh' || saved === 'ru' || saved === 'fr' ? saved : DEFAULT_LANG;
    } catch { return DEFAULT_LANG; }
  });
  useEffect(() => {
    if (storageKey) {
      try { window.localStorage.setItem(storageKey, lang); } catch { /* This page still keeps its choice in memory. */ }
    }
  }, [lang, storageKey]);

  const t = useMemo<TFunction>(() => tFor(lang), [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
