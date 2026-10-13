import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Calendar as CalendarIcon, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import type { DateRange } from "react-day-picker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateRangePickerProps {
  from?: string;
  to?: string;
  onChange: (range: { from?: string; to?: string }) => void;
  className?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

export function DateRangePicker({
  from,
  to,
  onChange,
  className,
  disabled,
  "data-testid": testId,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      const f = from ? parseISO(from) : undefined;
      const t = to ? parseISO(to) : undefined;
      setDraft(f ? { from: f, to: t } : undefined);
    }
    setOpen(newOpen);
  };

  const handleSelect = (range: DateRange | undefined) => {
    setDraft(range);
  };

  const handleConfirm = () => {
    onChange({
      from: draft?.from ? format(draft.from, "yyyy-MM-dd") : undefined,
      to: draft?.to ? format(draft.to, "yyyy-MM-dd") : undefined,
    });
    setOpen(false);
  };

  const rangeComplete = !!draft?.from && !!draft?.to;

  const label =
    from && to
      ? `${format(parseISO(from), "dd/MM/yyyy")} → ${format(parseISO(to), "dd/MM/yyyy")}`
      : from
        ? `${format(parseISO(from), "dd/MM/yyyy")} → ...`
        : "Pick date range";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            "justify-start text-left font-normal",
            !from && "text-muted-foreground",
            className
          )}
          data-testid={testId}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="h-[300px]">
          <Calendar
            mode="range"
            selected={draft}
            onSelect={handleSelect}
            defaultMonth={new Date()}
            weekStartsOn={1}
            numberOfMonths={1}
            classNames={{
              day_selected: "",
              day_range_start: "rdp-range-start",
              day_range_end: "rdp-range-end",
              day_range_middle: "rdp-range-middle",
            }}
          />
        </div>
        <div className="border-t px-3 py-2 flex justify-end">
          <Button
            size="sm"
            disabled={!rangeComplete}
            onClick={handleConfirm}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            <Check className="mr-1 h-4 w-4" />
            Confirm
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
