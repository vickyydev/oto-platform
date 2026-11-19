import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLanguage } from '@/i18n/LanguageContext';
import { kioskFlags } from '@/lib/kioskFlags';
import { cn } from '@/lib/utils';
import { ScreenKeyboard } from './ScreenKeyboard';

/**
 * A TEXT BOX THAT OPENS THE ON-SCREEN KEYBOARD ON A SCREEN WITH NONE (SCRUM-711).
 *
 * The family's drop-off and nanny form (SCRUM-764) on the counter's touch
 * monitor, which has no keyboard: a touch on a box opens the same keys the
 * nickname box on the first screen opens (`NicknameField`), under the box,
 * and Done puts them away. Everywhere else it is the plain box.
 *
 * SCRUM-893 — every text box of the form is one of these, the allergies and
 * medical box included (`multiline`), on the paired display and on the till's
 * customer half, so a family can type a child's allergies with no keyboard.
 *
 * SCRUM-894 — the box and its keys are scrolled into view when the keys open,
 * as the nickname box is, so on a short screen the box being typed in sits
 * above its keys and the form's bottom bar never covers it. One set of keys is
 * open at a time: opening the keys of another box puts these away.
 */
const opened = new Set<(owner: symbol) => void>();

/**
 * SCRUM-1059 — WHAT IS TYPED IS THE BOX'S OWN SIZE AT EVERY WIDTH.
 *
 * The till's plain `Input` and `Textarea` drop their type to `md:text-sm` from
 * 768px up, and a size in the box's class (`text-2xl` for a name, `text-lg`
 * for the allergies) does not override a breakpoint: on the 768 and 1024
 * displays a family's typing was small inside the large box, and full size
 * only on the 600 counter display (staging's m3, m4, m5). The box's own size
 * is repeated at `md:`, so the plain box and the one with the on-screen keys
 * draw what is typed as the box is drawn; a class with no size is left alone.
 */
const TYPE_SIZE = /^text-(xs|sm|base|lg|xl|[2-9]xl)$/;
export function typedTextClass(className?: string): string | undefined {
  const size = className?.split(/\s+/).find((name) => TYPE_SIZE.test(name));
  return size ? cn(className, `md:${size}`) : className;
}
function announceOpen(owner: symbol): void {
  for (const listener of [...opened]) listener(owner);
}

/** The box and its keys, in view inside whatever scrolls them (SCRUM-894). */
export function keepKeysInView(holder: HTMLElement | null): void {
  if (!holder || typeof holder.scrollIntoView !== 'function') return;
  holder.scrollIntoView({ block: 'nearest' });
}

export function TouchText({ value, onChange, placeholder, className, id, disabled, maxLength, multiline = false,
  screenKeyboard = kioskFlags.screenKeyboard, testId }: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  maxLength?: number;
  /** The allergies and medical box: several lines, drawn as the textarea it always was. */
  multiline?: boolean;
  /** Whether this screen brings its own keyboard; the page's `keyboard=screen` flag unless the caller knows better. */
  screenKeyboard?: boolean;
  testId?: string;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const owner = useRef(Symbol('touch-text'));
  useEffect(() => {
    const listener = (who: symbol) => { if (who !== owner.current) setOpen(false); };
    opened.add(listener);
    return () => { opened.delete(listener); };
  }, []);
  useEffect(() => {
    if (!open) return;
    announceOpen(owner.current);
    keepKeysInView(holder.current);
  }, [open]);

  const typed = typedTextClass(className);
  if (!screenKeyboard) {
    return multiline
      ? <Textarea id={id} value={value} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)} className={typed} data-testid={testId} />
      : <Input id={id} value={value} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)} className={typed} data-testid={testId} />;
  }
  // A press, not a focus: Done leaves the focus in the box, and the next touch
  // must still open the keys. inputMode none keeps the system's own keyboard
  // away; autocomplete off keeps the last family's words off the screen.
  const press = () => {
    if (open) keepKeysInView(holder.current);
    else setOpen(true);
  };
  return (
    <div ref={holder} data-testid={testId ? `${testId}-holder` : undefined}>
      {multiline
        ? <Textarea id={id} value={value} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)} onClick={press}
          className={typed} inputMode="none" autoComplete="off" spellCheck={false} data-testid={testId} />
        : <Input id={id} value={value} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)} onClick={press}
          className={typed} inputMode="none" autoComplete="off" spellCheck={false} data-testid={testId} />}
      {open && !disabled && (
        <ScreenKeyboard value={value} onChange={(next) => onChange(maxLength ? next.slice(0, maxLength) : next)}
          onDone={() => setOpen(false)} doneLabel={t('display.keyboard.hide')} maxLength={maxLength}
          spaceLabel={t('display.keyboard.space')} backspaceLabel={t('display.keyboard.backspace')} />
      )}
    </div>
  );
}
