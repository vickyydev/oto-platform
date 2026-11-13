import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { cn } from "@/lib/utils";

export interface EditableTextHandle {
  focus: () => void;
  startEditing: () => void;
}

interface EditableTextProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  inputClassName?: string;
  displayClassName?: string;
  type?: "text" | "time" | "number";
  onTab?: () => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  /**
   * SCRUM-978 (SCRUM-968 point 7): read-only. The BEO editor passed `disabled` to its text boxes
   * (a read-only BEO's bar lines, its acts' names) and the box ignored it: a click still opened it
   * for typing. Disabled, it shows its value and never opens.
   */
  disabled?: boolean;
  "data-testid"?: string;
}

export const EditableText = forwardRef<EditableTextHandle, EditableTextProps>(({
  value,
  onChange,
  placeholder = "Click to edit...",
  multiline = false,
  className,
  inputClassName,
  displayClassName,
  type = "text",
  onTab,
  onEnter,
  autoFocus = false,
  disabled = false,
  "data-testid": testId,
}, ref) => {
  const [editingState, setEditingState] = useState(autoFocus);
  // Disabled, the box never opens for typing (nor stays open once disabled).
  const editing = editingState && !disabled;
  const setEditing = useCallback((next: boolean) => setEditingState(next && !disabled), [disabled]);
  const [localValue, setLocalValue] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      setEditing(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    startEditing: () => {
      setEditing(true);
    },
  }));

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (type === "text" && inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select();
      }
    }
  }, [editing, type]);

  const commit = useCallback(() => {
    setEditing(false);
    if (localValue !== value) {
      onChange(type === "number" ? localValue : localValue);
    }
  }, [localValue, value, onChange, type]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab" && onTab) {
      e.preventDefault();
      if (localValue !== value) {
        onChange(localValue);
      }
      setEditing(false);
      onTab();
    } else if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      if (localValue !== value) {
        onChange(localValue);
      }
      setEditing(false);
      if (onEnter) {
        onEnter();
      }
    } else if (e.key === "Escape") {
      setLocalValue(value);
      setEditing(false);
    }
  };

  if (editing) {
    const sharedProps = {
      ref: inputRef as any,
      value: localValue,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setLocalValue(e.target.value),
      onBlur: commit,
      onKeyDown: handleKeyDown,
      "data-testid": testId,
    };

    if (multiline) {
      return (
        <textarea
          {...sharedProps}
          rows={3}
          className={cn(
            "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            inputClassName,
            className,
          )}
        />
      );
    }

    return (
      <input
        {...sharedProps}
        type={type}
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring h-8",
          inputClassName,
          className,
        )}
      />
    );
  }

  const isEmpty = !value || value.trim() === "";
  const displayValue =
    type === "time" && value
      ? value
      : type === "number" && value
        ? Number(value).toLocaleString()
        : value;

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") setEditing(true);
      }}
      className={cn(
        "w-full rounded-md px-3 py-1.5 text-sm transition-colors min-h-[32px] flex items-center",
        disabled ? "cursor-default" : "cursor-text hover:bg-accent/50 hover:border-border",
        "border border-transparent",
        isEmpty && "text-muted-foreground/50",
        multiline && "items-start min-h-[60px] whitespace-pre-wrap",
        displayClassName,
        className,
      )}
      data-testid={testId}
    >
      {isEmpty ? placeholder : displayValue}
    </div>
  );
});

EditableText.displayName = "EditableText";
