import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { FOCUS, TONE, type Tone } from '@/components/ui';

/**
 * Every dialog in the Inbox, written once (plan §4.1 "Dialogs"), on the house
 * scroll discipline of `apps/oto-app/client/src/components/ui/dialog.tsx:32-45`:
 *  - only the BODY scrolls — the header and the footer stay put;
 *  - the card never scrolls sideways: its width is set by `max-w-*`, not by
 *    its widest child, and anything wider is clipped rather than given a bar.
 *
 * The look is the OTO one (SCRUM-1016, BookDate.dc.html): on a phone a dialog
 * is a full-height sheet — the title large in a card header with a 44 px
 * close, the body on the cream ground, the footer's main button the footer's
 * width; from 768 px it is the centred card it always was, with its icon.
 * No dialog in this app is written without this component.
 *
 * `sheet` (SCRUM-1016, Filters.dc.html) rises from the bottom edge on a phone
 * with rounded top corners and a large title, and is the centred card from
 * 768 px; it carries no icon.
 *
 * Keyboard and screen reader (SCRUM-1016, inventory §7 item 18): the title
 * names the dialog and the subtitle describes it; focus goes to the close
 * control on opening, Tab and Shift+Tab stay inside, Escape closes, and on
 * closing focus goes back to the control that opened it. Only the top dialog
 * listens when one opens over another.
 */
export function Dialog({
  open,
  onClose,
  icon: Icon,
  tone = 'neutral',
  title,
  subtitle,
  footer,
  children,
  wide = false,
  sheet = false,
  closeLabel = 'Close',
  lead,
}: {
  open: boolean;
  onClose: () => void;
  /** A sheet's mark before its title (a contact's face); decorative, the title names the sheet. */
  lead?: ReactNode;
  /** The header's icon from 768 px; a sheet has none. */
  icon?: LucideIcon;
  /** The icon's tint, one of the tested tones. */
  tone?: Tone;
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  sheet?: boolean;
  /** The close control's accessible name. */
  closeLabel?: string;
}) {
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Held in a ref so a parent re-render (the thirty-second refresh) neither
  // re-binds the keys nor pulls focus back to the close button mid-choice.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    return holdFocus(panel, closeRef.current, () => onCloseRef.current());
  }, [open]);

  if (!open) return null;
  const labelled = {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': subtitle ? subtitleId : undefined,
    tabIndex: -1,
  } as const;
  // The view-as banner (SCRUM-648) stays above every dialog: the backdrop starts under it.
  const backdrop = 'fixed inset-x-0 bottom-0 top-[var(--view-as-offset,0px)] z-50 flex bg-scrim';
  if (sheet) {
    return (
      <div className={`${backdrop} items-end justify-center md:items-center md:p-4`} onClick={onClose}>
        <div
          ref={panelRef}
          {...labelled}
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[calc(100%-3.5rem)] w-full flex-col overflow-hidden rounded-t-3xl bg-ground shadow-pop outline-none md:max-h-full md:max-w-lg md:rounded-3xl"
        >
          <div className="flex shrink-0 items-center gap-3 pb-1.5 pl-5 pr-2 pt-3.5">
            {/* What the sheet is about, before its title (ChatActions.dc.html: the contact's 44 px face). */}
            {lead}
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-[20px] font-extrabold tracking-[-0.02em] text-ink">
                {title}
              </h2>
              {/* The sheet's line under its title (ChatActions.dc.html: the channel, the language, the member link). */}
              {subtitle && (
                <p id={subtitleId} className="text-[12.5px] text-ink-muted">
                  {subtitle}
                </p>
              )}
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink hover:bg-wash ${FOCUS}`}
            >
              <X aria-hidden className="h-[22px] w-[22px]" />
            </button>
          </div>
          {/* DialogBody: the one part that scrolls. */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-4 pt-1">{children}</div>
          {footer && (
            <div className="flex shrink-0 items-center gap-3 border-t border-line px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
              {footer}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={`${backdrop} md:items-center md:justify-center md:p-4`} onClick={onClose}>
      <div
        ref={panelRef}
        {...labelled}
        onClick={(e) => e.stopPropagation()}
        className={`flex h-full w-full flex-col overflow-hidden bg-ground outline-none md:h-auto md:max-h-full md:rounded-2xl md:bg-card md:shadow-pop ${
          wide ? 'md:max-w-2xl' : 'md:max-w-md'
        }`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-card py-2 pl-4 pr-1 md:items-start md:border-line-soft md:py-4 md:pl-5 md:pr-3">
          {Icon && (
            <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-full md:flex ${TONE[tone]}`}>
              <Icon aria-hidden className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[18px] font-extrabold tracking-[-0.02em] text-ink md:text-[16px] md:font-bold">
              {title}
            </h2>
            {subtitle && (
              <p id={subtitleId} className="mt-0.5 text-[12.5px] text-ink-muted">
                {subtitle}
              </p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink hover:bg-wash md:h-9 md:w-9 md:text-ink-muted md:hover:bg-band md:hover:text-ink ${FOCUS}`}
          >
            <X aria-hidden className="h-[22px] w-[22px] md:h-4 md:w-4" />
          </button>
        </div>
        {/* DialogBody: the one part that scrolls. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3.5 md:px-5 md:py-4">{children}</div>
        {footer && (
          // The footer's last control is its main one: on a phone it takes the footer's width.
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-line bg-card px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 max-md:[&>*:last-child]:flex-1 md:gap-2 md:border-line-soft md:px-5 md:py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** What can take focus inside a dialog, in the page's order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The open dialogs' panels, the top one last: only it answers the keys. */
const OPEN_PANELS: HTMLElement[] = [];

function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest('[hidden], [inert]'),
  );
}

/**
 * Focus the first of `list` that takes it: a control hidden at this width
 * (`display: none`) refuses focus, so the next one is tried.
 */
function focusFirstOf(list: readonly HTMLElement[], panel: HTMLElement): void {
  for (const el of list) {
    el.focus();
    if (document.activeElement === el) return;
  }
  panel.focus();
}

/**
 * Hold focus in `panel` while it is the top dialog: focus to `start` now,
 * Tab and Shift+Tab wrap inside, a focus that lands outside is brought back,
 * Escape calls `close`. The returned clean-up hands focus back to the control
 * that had it when the dialog opened, when that control is still on the page
 * and nothing else has taken focus meanwhile.
 */
export function holdFocus(panel: HTMLElement, start: HTMLElement | null, close: () => void): () => void {
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  OPEN_PANELS.push(panel);
  const isTop = () => OPEN_PANELS[OPEN_PANELS.length - 1] === panel;
  let backwards = false;
  (start ?? panel).focus();

  const onKey = (e: KeyboardEvent) => {
    if (!isTop()) return;
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    backwards = e.shiftKey;
    const list = focusables(panel);
    if (list.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof Node && panel.contains(active) && active !== panel;
    if (e.shiftKey && (!inside || active === list[0])) {
      e.preventDefault();
      focusFirstOf([...list].reverse(), panel);
    } else if (!e.shiftKey && (!inside || active === list[list.length - 1])) {
      e.preventDefault();
      focusFirstOf(list, panel);
    }
  };
  // A last control hidden at this width lets the browser's own Tab step out:
  // focus that lands outside the top dialog is brought back in.
  const onFocusIn = (e: FocusEvent) => {
    if (!isTop()) return;
    const target = e.target;
    if (target instanceof Node && panel.contains(target)) return;
    const list = focusables(panel);
    focusFirstOf(backwards ? [...list].reverse() : list, panel);
  };
  window.addEventListener('keydown', onKey);
  document.addEventListener('focusin', onFocusIn);

  return () => {
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('focusin', onFocusIn);
    const at = OPEN_PANELS.lastIndexOf(panel);
    if (at >= 0) OPEN_PANELS.splice(at, 1);
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || panel.contains(active);
    if (lost && opener?.isConnected) opener.focus();
  };
}
