import { Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TouchKeypadProps {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
}

/**
 * Compact, theme-styled numeric keypad for on-screen (iPad/touch) entry inside
 * dialogs and panels. For the full-screen customer display use NumberKeypad.
 */
export function TouchKeypad({ value, onChange, maxLength = 6 }: TouchKeypadProps) {
  const press = (digit: string) => {
    if (value.length >= maxLength) return;
    // Avoid leading zeros (e.g. "0", "05") which read as nonsense for a discount.
    if (value === '0') {
      onChange(digit);
      return;
    }
    onChange(value + digit);
  };
  const backspace = () => onChange(value.slice(0, -1));

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="grid grid-cols-3 gap-2">
      {keys.map((k) => (
        <Button
          key={k}
          type="button"
          variant="outline"
          className="h-14 text-2xl font-semibold"
          onClick={() => press(k)}
        >
          {k}
        </Button>
      ))}
      <Button
        type="button"
        variant="outline"
        className="h-14 text-base font-medium text-muted-foreground"
        onClick={() => onChange('')}
      >
        Clear
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-14 text-2xl font-semibold"
        onClick={() => press('0')}
      >
        0
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-14"
        onClick={backspace}
        aria-label="Backspace"
      >
        <Delete className="w-6 h-6" />
      </Button>
    </div>
  );
}
