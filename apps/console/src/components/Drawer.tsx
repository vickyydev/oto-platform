import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * The detail of one row, beside the list rather than instead of it.
 *
 * A slide-over keeps the list on screen on a desktop, which is what someone
 * comparing three failures actually needs. On a phone it becomes a full sheet,
 * because 390px has no room for both.
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The list behind must not scroll under the sheet on a phone.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full sm:max-w-xl bg-background border-l shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        <div className="flex items-start gap-3 border-b px-4 sm:px-6 py-4 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold tracking-tight break-words">{title}</h2>
            {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border text-foreground/70 hover:text-foreground shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-5">{children}</div>
        {footer && <div className="border-t px-4 sm:px-6 py-3 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}
