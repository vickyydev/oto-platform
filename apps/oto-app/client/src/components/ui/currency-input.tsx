import * as React from "react";
import { cn } from "@/lib/utils";
import { formatCurrencyInput, parseCurrencyInput } from "@/lib/format-utils";

export interface CurrencyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}

const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ className, value, onChange, ...props }, ref) => {
    const [displayValue, setDisplayValue] = React.useState(() =>
      value ? formatCurrencyInput(value) : ""
    );

    React.useEffect(() => {
      if (value !== undefined && value !== null) {
        setDisplayValue(formatCurrencyInput(value));
      } else {
        setDisplayValue("");
      }
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const inputValue = e.target.value;
      const cleaned = inputValue.replace(/[^0-9,]/g, "");
      setDisplayValue(cleaned);
      
      const numValue = parseCurrencyInput(cleaned);
      onChange(numValue === 0 && cleaned === "" ? undefined : numValue);
    };

    const handleBlur = () => {
      if (value !== undefined && value !== null && value > 0) {
        setDisplayValue(formatCurrencyInput(value));
      }
    };

    return (
      <input
        type="text"
        inputMode="numeric"
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        {...props}
      />
    );
  }
);
CurrencyInput.displayName = "CurrencyInput";

export { CurrencyInput };
