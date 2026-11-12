import { Delete } from 'lucide-react';
import { cn } from '@/lib/utils';

const LETTER_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'] as const;

/**
 * NumberKeypad's key, at the size a row of ten can hold. SCRUM-894 — a little
 * shorter on a short screen (below 700 pixels of height), so the box being
 * typed in and its keys fit above the form's bottom bar.
 */
const SHORT = '[@media(max-height:700px)]:h-10';
const KEY =
  `h-12 ${SHORT} min-w-0 flex-1 rounded-xl bg-foreground/5 border border-foreground/10 text-xl font-bold text-foreground transition-transform active:scale-95 hover:bg-foreground/10`;

interface ScreenKeyboardProps {
  value: string;
  onChange: (next: string) => void;
  onDone: () => void;
  doneLabel: string;
  spaceLabel?: string;
  backspaceLabel?: string;
  /** The same bound the display's intent accepts for a nickname. */
  maxLength?: number;
}

/**
 * The on-screen keyboard for a screen with no other (SCRUM-711): letters, space,
 * backspace, done; English only. Names read as names, so a word starts with a
 * capital and carries on in lower case. The number keypad's companion, in its
 * design language.
 */
export function ScreenKeyboard({ value, onChange, onDone, doneLabel, spaceLabel = 'Space', backspaceLabel = 'Backspace', maxLength = 100 }: ScreenKeyboardProps) {
  const add = (text: string) => {
    if (value.length + text.length > maxLength) return;
    onChange(value + text);
  };
  const letter = (key: string) => add(value === '' || value.endsWith(' ') ? key : key.toLowerCase());
  // By whole characters: the till may have handed this field a name with an emoji in it.
  const backspace = () => onChange(Array.from(value).slice(0, -1).join(''));

  const letterKey = (key: string) => (
    <button key={key} type="button" onClick={() => letter(key)} className={KEY}>
      {key}
    </button>
  );

  return (
    // A press keeps the focus and the caret in the field it is typing into.
    <div
      className="mt-3 space-y-1.5 select-none"
      data-testid="screen-keyboard"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex gap-1.5">{Array.from(LETTER_ROWS[0], letterKey)}</div>
      <div className="flex gap-1.5 px-[5%]">{Array.from(LETTER_ROWS[1], letterKey)}</div>
      <div className="flex gap-1.5 px-[5%]">
        {Array.from(LETTER_ROWS[2], letterKey)}
        <button
          type="button"
          onClick={backspace}
          aria-label={backspaceLabel}
          className={cn(KEY, 'flex-[2] flex items-center justify-center text-foreground/70')}
        >
          <Delete className="w-6 h-6" />
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => add(' ')}
          aria-label={spaceLabel}
          className={cn(KEY, 'flex-[3] text-lg font-semibold text-foreground/70')}
        >
          {spaceLabel}
        </button>
        <button
          type="button"
          onClick={onDone}
          className={`h-12 ${SHORT} min-w-0 flex-1 rounded-xl bg-primary text-primary-foreground text-lg font-bold transition-transform active:scale-95 hover:bg-primary/90`}
        >
          {doneLabel}
        </button>
      </div>
    </div>
  );
}
