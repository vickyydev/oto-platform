import { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import { LANGUAGES } from '@/i18n/types';

// Reusable top-right language pill for customer-facing screens. Reads/writes
// the single shared LanguageContext — never local state — so every
// customer-facing surface on the same device stays in sync. `variant` swaps
// the color scheme between dark customer displays (default) and the light
// /book flow.
//
// SCRUM-963 — the customer screens' list (`variant="dark"`) follows the look
// of the screen it opens on (`lib/displayTheme.ts`, the `.dark` / `.light`
// wrapper's `--cd-menu` tokens): on a dark screen it is the slate list it
// always was, on a light one the screen's cream card under its dark ink. It
// was slate under the light screen's dark ink, which could not be read.
export function LanguageSwitcher({
  variant = 'dark',
  className = '',
  buttonClassName = '',
}: {
  variant?: 'dark' | 'light';
  className?: string;
  /**
   * SCRUM-954 — added to the pill itself: the counter display's form makes it
   * a finger's height. SCRUM-963 — and to each language in its list, so the
   * choices are a finger's height there too.
   */
  buttonClassName?: string;
}) {
  const { lang, setLang, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  const pillClass =
    variant === 'dark'
      ? 'bg-foreground/10 border-foreground/15 text-foreground hover:bg-foreground/15'
      : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300';

  const menuClass =
    variant === 'dark'
      ? 'bg-(--cd-menu) border-foreground/15 text-foreground'
      : 'bg-white border-slate-200 text-slate-900';

  return (
    <div ref={ref} className={`relative z-40 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-semibold transition-colors ${pillClass}${buttonClassName ? ` ${buttonClassName}` : ''}`}
        aria-label={t('common.changeLanguage')}
      >
        <Globe className="w-4 h-4" />
        {current.nativeLabel}
      </button>
      {open && (
        <div
          className={`absolute right-0 mt-2 w-40 rounded-2xl border shadow-xl overflow-hidden ${menuClass}`}
        >
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => {
                setLang(l.code);
                setOpen(false);
              }}
              className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors ${
                l.code === lang
                  ? variant === 'dark' ? 'bg-primary/15 text-(--cd-menu-chosen)' : 'bg-primary/15 text-primary'
                  : variant === 'dark'
                  ? 'hover:bg-foreground/10'
                  : 'hover:bg-slate-50'
              }${buttonClassName ? ` ${buttonClassName}` : ''}`}
            >
              {l.nativeLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
