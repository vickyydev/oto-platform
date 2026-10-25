import { useEffect, useRef, useState } from 'react';
import { ErrorNote } from '@/components/Panel';
import { SelectChip } from '@/components/redesign/chips';

export interface OperatorSwitchChoice {
  id: string;
  name: string;
}

export interface OperatorSwitchPickerProps {
  home: OperatorSwitchChoice;
  current: OperatorSwitchChoice | null;
  options: readonly OperatorSwitchChoice[];
  epoch: number;
  canSwitch: boolean;
  loading: boolean;
  switching: boolean;
  error: string | null;
  onSelect: (operatorId: string, epoch: number) => Promise<void>;
  onRetry: () => void;
}

/** Selection is canonical input; only the controller may confirm a new context. */
export function OperatorSwitchPicker(props: OperatorSwitchPickerProps) {
  const { home, current, options, epoch, canSwitch, loading, switching, error, onSelect, onRetry } = props;
  const key = JSON.stringify([home.id, current?.id, options.map(option => [option.id, option.name]),
    epoch, canSwitch, loading, switching, error]);
  const latest = useRef({ key, generation: 0, onSelect, onRetry, mounted: true });
  if (latest.current.key !== key || latest.current.onSelect !== onSelect || latest.current.onRetry !== onRetry) {
    latest.current = { ...latest.current, key, generation: latest.current.generation + 1, onSelect, onRetry };
  }
  const generation = latest.current.generation;
  const busy = useRef<object | null>(null);
  const [pending, setPending] = useState<object | null>(null);
  const [failure, setFailure] = useState<{ generation: number; message: string } | null>(null);
  useEffect(() => {
    latest.current.mounted = true;
    return () => { latest.current.mounted = false; };
  }, []);
  const isCurrent = () => latest.current.mounted && latest.current.generation === generation;
  const selected = current && options.some(option => option.id === current.id) ? current.id : '';
  const message = error !== null ? error || 'The operator context could not be confirmed.'
    : failure?.generation === generation ? failure.message : null;
  const disabled = !selected || loading || switching || error !== null || message !== null || pending !== null;

  const choose = async (id: string) => {
    if (!isCurrent() || !canSwitch || disabled || busy.current || id === current?.id
      || !id || !options.some(option => option.id === id)) return;
    const owner = {};
    busy.current = owner; setPending(owner); setFailure(null);
    try {
      await onSelect(id, epoch);
    } catch {
      if (isCurrent()) setFailure({ generation, message: 'The operator could not be changed. Try again.' });
    } finally {
      if (busy.current === owner) busy.current = null;
      // Settling this operation may clear only its own busy indicator, even
      // when a newer authority already replaced the result it would display.
      if (latest.current.mounted) setPending(value => value === owner ? null : value);
    }
  };
  const retry = async () => {
    if (!isCurrent() || !canSwitch || loading || switching || busy.current) return;
    setFailure(null);
    try { await onRetry(); }
    catch { if (isCurrent()) setFailure({ generation, message: 'The operators could not be read. Try again.' }); }
  };

  if (!canSwitch) return null;
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
    <p className="min-w-0 max-w-full text-sm text-muted-foreground break-words">
      Home operator: <span className="font-semibold">{home.name}</span>
    </p>
    <SelectChip label="Operator" showLabel value={selected} disabled={disabled}
      options={options.map(option => ({ value: option.id, label: option.name }))}
      anyLabel="Current operator not confirmed" onChange={id => { void choose(id); }} />
    {message !== null && <ErrorNote message={message} onRetry={loading || switching || pending !== null ? undefined : () => { void retry(); }} />}
  </div>;
}
