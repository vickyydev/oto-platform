import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

/**
 * Every dialog in the Inbox, written once (plan §4.1 "Dialogs"), on the house
 * scroll discipline of `apps/oto-app/client/src/components/ui/dialog.tsx:32-45`:
 *  - the card is capped at the window height less 1rem on each side;
 *  - only the BODY scrolls — the header and the footer stay put;
 *  - the card never scrolls sideways: its width is set by `max-w-*`, not by
 *    its widest child, and anything wider is clipped rather than given a bar.
 *
 * The look is the prototype's modals (WhatsAppDemo.tsx :1705-1764): centred,
 * `rounded-2xl`, an icon in a tinted circle, a title, then the content.
 * No dialog in this app is written without this component.
 */
export function Dialog({
  open,
  onClose,
  icon: Icon,
  iconTint = 'bg-slate-100 text-slate-600',
  title,
  subtitle,
  footer,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  icon: LucideIcon;
  iconTint?: string;
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Held in a ref so a parent re-render (the thirty-second refresh) neither
  // re-binds the key nor pulls focus back to the close button mid-choice.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-xl ${
          wide ? 'max-w-2xl' : 'max-w-md'
        }`}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-5 py-4">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconTint}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-[15px] font-semibold text-slate-900">
              {title}
            </h3>
            {subtitle && <p className="mt-0.5 text-[12.5px] text-slate-500">{subtitle}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* DialogBody: the one part that scrolls. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
