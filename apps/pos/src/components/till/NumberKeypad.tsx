import { Delete } from 'lucide-react';

interface NumberKeypadProps {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
}

export function NumberKeypad({ value, onChange, maxLength = 10 }: NumberKeypadProps) {
  const press = (digit: string) => {
    if (value.length >= maxLength) return;
    onChange(value + digit);
  };
  const backspace = () => onChange(value.slice(0, -1));

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="grid grid-cols-3 gap-3 w-full max-w-md mx-auto">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => press(k)}
          className="h-20 rounded-2xl bg-foreground/5 border border-foreground/10 text-4xl font-bold text-foreground transition-transform active:scale-95 hover:bg-foreground/10"
        >
          {k}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange('')}
        className="h-20 rounded-2xl bg-foreground/5 border border-foreground/10 text-xl font-semibold text-foreground/70 transition-transform active:scale-95 hover:bg-foreground/10"
      >
        Clear
      </button>
      <button
        type="button"
        onClick={() => press('0')}
        className="h-20 rounded-2xl bg-foreground/5 border border-foreground/10 text-4xl font-bold text-foreground transition-transform active:scale-95 hover:bg-foreground/10"
      >
        0
      </button>
      <button
        type="button"
        onClick={backspace}
        className="h-20 rounded-2xl bg-foreground/5 border border-foreground/10 flex items-center justify-center text-foreground/70 transition-transform active:scale-95 hover:bg-foreground/10"
        aria-label="Backspace"
      >
        <Delete className="w-8 h-8" />
      </button>
    </div>
  );
}
