import { ChevronRight, Globe } from 'lucide-react';
import { tFor, useLanguage } from '@/i18n/LanguageContext';
import { LANGUAGES, type SupportedLang } from '@/i18n/types';

/**
 * SCRUM-763 — THE FIRST SCREEN OF A SALE: THE GUEST'S LANGUAGE.
 *
 * The five languages, each named in its own language (the names the language
 * button already shows), each with a line in that same language, so a guest
 * finds theirs without reading any other. The heading reads in the screen's
 * language, and the line under it says the same in the other four: the screen
 * may still be in the last guest's language when the next one walks up.
 *
 * A press sets the display's language for this visit — the same language
 * every screen after it reads in — and hands on to the phone-number step.
 * Laid out as the phone-number step is: its heading above, its column below.
 */
export function CustomerLanguageChoice({ onChosen }: { onChosen?: (lang: SupportedLang) => void }) {
  const { lang, setLang, t } = useLanguage();
  const others = LANGUAGES.filter((option) => option.code !== lang);
  return (
    <div
      className="flex-1 flex flex-col p-8 overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-300"
      data-testid="language-choice"
    >
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 text-primary mb-2">
          <Globe className="w-6 h-6" />
          <span className="uppercase tracking-widest text-sm font-bold">{t('common.language')}</span>
        </div>
        <h2 className="text-5xl font-black">{t('display.language.title')}</h2>
        <p className="text-foreground/60 text-lg mt-2">
          {others.map((option, index) => (
            <span key={option.code} lang={option.code}>
              {index > 0 && <span aria-hidden="true"> · </span>}
              {tFor(option.code)('display.language.title')}
            </span>
          ))}
        </p>
      </div>

      <div className="mx-auto w-full max-w-xl space-y-3">
        {LANGUAGES.map((option) => (
          <button
            key={option.code}
            type="button"
            lang={option.code}
            data-testid={'language-choice-' + option.code}
            onClick={() => {
              setLang(option.code);
              onChosen?.(option.code);
            }}
            className="w-full flex items-center gap-4 rounded-3xl border border-foreground/10 bg-foreground/5 px-6 py-5 text-left transition-colors hover:bg-foreground/10 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-3xl font-black">{option.nativeLabel}</span>
              <span className="block text-base text-foreground/60 mt-1">
                {tFor(option.code)('display.language.continue')}
              </span>
            </span>
            <ChevronRight className="w-7 h-7 shrink-0 text-primary" />
          </button>
        ))}
      </div>
    </div>
  );
}
