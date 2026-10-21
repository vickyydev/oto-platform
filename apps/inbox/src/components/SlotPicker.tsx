import { ChevronDown, Plus } from 'lucide-react';
import type { Chip } from '@/lib/view';
import type { SlotOption } from '@/lib/view';

const REMOVE = '__remove__';
const CURRENT = '__current__';

/**
 * `SlotPicker` (WhatsAppDemo.tsx :753-824): a person's chip — or the dashed
 * "Add support" — with a native select laid over it. Picking someone fires
 * `onPick`; "Remove support" fires `onRemove`. The prototype's "· off"
 * availability mark is gone with the availability toggles (the IT Brief's
 * Divert replaces them).
 */
export function SlotPicker({
  slotLabel,
  current,
  options,
  onPick,
  onRemove,
  emptyLabel,
  disabled = false,
}: {
  /** "primary" or "support" (`SLOT_LABEL`, :62). */
  slotLabel: string;
  current: Chip | null;
  options: SlotOption[];
  onPick: (option: SlotOption) => void;
  /** Absent: the slot cannot be emptied (the primary, `allowRemove={false}`). */
  onRemove?: () => void;
  emptyLabel: string;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-flex max-w-full">
      {current ? (
        <span
          className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-transparent ${current.tint} cursor-pointer hover:ring-slate-300 dark:hover:ring-slate-500`}
          title={`Click to change or remove ${slotLabel}`}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/60 dark:bg-slate-900/60 text-[9px] font-semibold">
            {current.initials}
          </span>
          <span className="truncate">{current.name}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </span>
      ) : (
        <span className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:border-slate-400 dark:hover:border-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          <Plus className="h-3 w-3" />
          {emptyLabel}
        </span>
      )}
      <select
        value={current ? CURRENT : '__placeholder__'}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === REMOVE) onRemove?.();
          else {
            const picked = options.find((o) => o.value === v);
            if (picked) onPick(picked);
          }
        }}
        aria-label={`Set ${slotLabel}`}
        className="absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-wait"
      >
        {/* Hidden anchor so React always has a matching option for the current value */}
        {current ? (
          <option value={CURRENT} hidden>
            {current.name}
          </option>
        ) : (
          <option value="__placeholder__" hidden>
            Pick someone…
          </option>
        )}
        {current && onRemove && <option value={REMOVE}>Remove {slotLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
