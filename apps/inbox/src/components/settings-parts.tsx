// THE SETTINGS PAGES' SHARED PARTS (SCRUM-1044,
// docs/progress/plans/inbox-redesign/SETTINGS.md): built once, beside
// `atoms.tsx` and `ui.ts`, and used by every page the settings frame holds,
// so Templates and the assistant's pages read as one product with the
// Inbox. Sizes come from the one scale (SCRUM-1045), colours from the tokens
// (SCRUM-1016); every control is a 44 px target on a touch screen (`hit`),
// and every pair of words and ground is a tested token pair
// (test/settings-1044.test.ts).
import {
  Fragment,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AlertCircle, CheckCircle2, Info, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { BTN_ICON, BTN_SMALL, HINT, LABEL } from '@/components/ui';

/** The page area's gutter (SettingsFrame); the sticky action bar bleeds to it. */
export const FRAME_GUTTER = 'px-4 md:px-6';

/** A section's card: the card ground, the drawn line, the 16 px corner. Rows inside are divided by the soft line. */
export const SECTION_CARD = 'min-w-0 rounded-2xl border border-line bg-card';

/** One row of a settings list: the conversation row's gutter and rhythm (ConversationList `Row`). */
export const SETTINGS_ROW = 'flex min-w-0 gap-3 border-b border-line-soft px-pane py-row last:border-b-0';

/** An item of a three-dot menu: the menu's height, the coral focus ring drawn inside it. */
export const MENU_ITEM =
  'hit flex min-h-ctl-lg w-full items-center gap-3 rounded-xl px-3 text-left text-ui font-medium text-ink hover:bg-wash disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-coral';

/** A page's help line under its title. */
const PAGE_HELP = 'max-w-prose text-ui leading-relaxed text-ink-soft';

/**
 * The top of a settings page: an optional eyebrow (the group, "Assistant"),
 * the page's title, its main action on the right of the title (it wraps
 * under on a narrow phone), and one line of help.
 */
export function PageHeader({
  eyebrow,
  title,
  help,
  actions,
}: {
  eyebrow?: string;
  title: string;
  help?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {eyebrow && <p className="text-meta font-semibold text-ink-muted">{eyebrow}</p>}
          <h2 className="text-display font-extrabold tracking-[-0.02em] text-ink">{title}</h2>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {help && <p className={PAGE_HELP}>{help}</p>}
    </header>
  );
}

/**
 * A section of a page: a small title above a card (the desktop panel's
 * section titles, Desktop.dc.html), a count or a note at its right, an
 * optional line of help; the card holds rows (`SettingsRow`) or a form.
 */
export function SectionCard({
  title,
  aside,
  help,
  children,
}: {
  title: string;
  aside?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <div className="mb-2 flex min-w-0 items-baseline justify-between gap-3 px-1">
        <h3 id={headingId} className="min-w-0 break-words text-ui font-bold text-ink">
          {title}
        </h3>
        {aside !== undefined && <span className="shrink-0 text-meta text-ink-muted">{aside}</span>}
      </div>
      {help && <p className="-mt-1 mb-2 px-1 text-note text-ink-muted">{help}</p>}
      <div className={SECTION_CARD}>{children}</div>
    </section>
  );
}

/** One part of a row's quiet meta: its words, and an optional tone (`ask` for a thing still to do). */
export interface MetaPart {
  text: string;
  tone?: 'ask';
}

/**
 * A row's quiet meta ("Every channel · Every park · No approval needed"): the
 * parts joined by a dot, each kept whole, so a narrow row wraps between
 * parts and never leaves one word of a part alone on a line (SCRUM-1045's
 * "10m 40s" on two lines, in the settings).
 */
export function MetaLine({ parts }: { parts: readonly MetaPart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={`${i}-${p.text}`}>
          {/* The dot keeps to the part before it; the line may break after it. */}
          {i > 0 && <span aria-hidden>{' · '}</span>}
          <span className={`whitespace-nowrap ${p.tone === 'ask' ? 'font-semibold text-ask-ink' : ''}`}>{p.text}</span>
        </Fragment>
      ))}
    </>
  );
}

/** One action of a row: a button at the row's end from 768 px, an item of its menu on a phone. */
export interface RowAction {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * A row of a settings list, in the conversation row's rhythm: the main text,
 * a preview clamped to two lines, then at most one badge beside quiet meta.
 * The actions come from ONE list: buttons at the row's end from 768 px, the
 * three-dot menu below it, so the two can never offer different things.
 * `name` says which row an action belongs to, for a screen reader.
 */
export function SettingsRow({
  title,
  name,
  preview,
  badge,
  meta,
  actions = [],
  children,
}: {
  title: ReactNode;
  /** The row's name in its actions' accessible names ("Edit: Welcome, English"). */
  name: string;
  preview?: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: readonly RowAction[];
  /** What the row carries under its lines (the birthday brochure). */
  children?: ReactNode;
}) {
  return (
    <li className={SETTINGS_ROW}>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="min-w-0 break-words text-body font-semibold leading-tight text-ink">{title}</div>
        {preview && <p className="line-clamp-2 break-words text-ui leading-snug text-ink-soft">{preview}</p>}
        {/* One flow of words: the badge, then the meta's parts, wrapping between parts. */}
        {(badge || meta) && (
          <div className="mt-[3px] min-w-0 break-words text-meta leading-relaxed text-ink-muted">
            {badge && <span className="mr-2 inline-flex align-middle">{badge}</span>}
            {meta}
          </div>
        )}
        {children}
      </div>
      {actions.length > 0 && (
        <div className="flex shrink-0 items-start">
          <div className="hidden items-center gap-1.5 md:flex">
            {actions.map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onSelect}
                  disabled={a.disabled}
                  aria-label={`${a.label}: ${name}`}
                  className={BTN_SMALL}
                >
                  {Icon && <Icon aria-hidden className="h-3.5 w-3.5" />}
                  {a.label}
                </button>
              );
            })}
          </div>
          <div className="-mr-2 -mt-1.5 md:hidden">
            <RowMenu label={`Actions: ${name}`} items={actions} />
          </div>
        </div>
      )}
    </li>
  );
}

/** The open menu's items, rendered on their own so the markup tests read them open. */
export function RowMenuItems({
  id,
  label,
  items,
  onChoose,
  up = false,
}: {
  id?: string;
  label: string;
  items: readonly RowAction[];
  onChoose: (a: RowAction) => void;
  up?: boolean;
}) {
  return (
    <div
      id={id}
      role="menu"
      aria-label={label}
      className={`absolute right-0 z-30 w-56 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-card p-1.5 text-ink shadow-pop ${
        up ? 'bottom-full mb-1' : 'top-full mt-1'
      }`}
    >
      {items.map((a) => {
        const Icon = a.icon;
        return (
          <button key={a.label} type="button" role="menuitem" disabled={a.disabled} onClick={() => onChoose(a)} className={MENU_ITEM}>
            {Icon && <Icon aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-soft" />}
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The menu's items, in order: every one rendered is one a person can reach. */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')] : [];
}

/**
 * The three-dot menu of a row on a phone: a 44 px button; the menu opens on a
 * press or ArrowDown, moves with the arrow keys, Home and End, closes on
 * Escape, Tab, a choice or a press outside, and gives focus back to the
 * button, so a dialog a choice opens returns focus there too. It opens
 * upward when the screen has no room below.
 */
export function RowMenu({ label, items }: { label: string; items: readonly RowAction[] }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menuItems(wrap.current)[0]?.focus();
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target) && !button.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const show = () => {
    const r = button.current?.getBoundingClientRect();
    // A menu item is at most 48 px; with the card's padding, that is the room it needs.
    if (r) setUp(window.innerHeight - r.bottom < items.length * 48 + 24 && r.top > items.length * 48 + 24);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = menuItems(wrap.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            show();
          }
        }}
        className={BTN_ICON}
      >
        <MoreHorizontal aria-hidden className="h-5 w-5" />
      </button>
      {open && (
        <div ref={wrap} onKeyDown={onKeyDown}>
          <RowMenuItems
            id={menuId}
            label={label}
            items={items}
            up={up}
            onChoose={(a) => {
              close();
              a.onSelect();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A labelled field: the label over the control, help under it, and an error
 * line in the refusal's red; help and error are tied to the control
 * (`aria-describedby`), and an error marks it invalid. `wide` takes both
 * columns of a two-column form.
 */
export function Field({
  label,
  help,
  error,
  wide = false,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  wide?: boolean;
  children: ReactElement<Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid'>>;
}) {
  const helpId = useId();
  const errorId = useId();
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })
    : children;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${wide ? 'md:col-span-2' : ''}`}>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={LABEL}>{label}</span>
        {control}
      </label>
      {help && (
        <p id={helpId} className={HINT}>
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-meta font-semibold text-danger-ink">
          <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * A form's Cancel and Save, sticky at the bottom of the page area: the card
 * ground over a line, bled to the frame's gutter; on a phone the last (main)
 * button takes the bar's width, as a dialog's footer does. `status` is a
 * quiet word on its left ("Unsaved changes").
 */
export function ActionBar({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 -mb-8 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 md:-mx-6 md:gap-2 md:px-6">
      {status && <span className="mr-auto min-w-0 text-note text-ink-muted">{status}</span>}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3 max-md:[&>*:last-child]:flex-1 md:flex-none md:gap-2">{children}</div>
    </div>
  );
}

/** Nothing here yet: a dashed frame (decoration, not a control), the thing's icon, one line, an optional way on. */
export function EmptyNote({
  icon: Icon,
  title,
  line,
  action,
}: {
  icon: LucideIcon;
  title: string;
  line?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line-deep bg-card px-6 py-10 text-center">
      <div className="flex size-ctl-lg items-center justify-center rounded-full bg-band text-ink-muted">
        <Icon aria-hidden className="h-5 w-5" />
      </div>
      <p className="text-ui font-semibold text-ink">{title}</p>
      {line && <p className="max-w-xs text-note text-ink-muted">{line}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** While a list is read: three quiet rows in the section card's shape, its words for a screen reader. */
export function LoadingNote({ label }: { label: string }) {
  return (
    <div role="status" className={SECTION_CARD}>
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden className="flex flex-col gap-2 border-b border-line-soft px-pane py-row last:border-b-0">
          <span className="h-3.5 w-1/4 rounded-full bg-band motion-safe:animate-pulse" />
          <span className="h-3 w-11/12 rounded-full bg-band motion-safe:animate-pulse" />
          <span className="h-3 w-2/5 rounded-full bg-band motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** The tones of a note on a page, each a tested pair of words on ground with its drawn edge. */
export const NOTE_TONE = {
  /** Done: saved, archived (money's green, the Inbox's emerald). */
  success: 'bg-money text-money-ink ring-money-line',
  /** What the assistant does (its mint). */
  assistant: 'bg-mint-soft text-teal ring-mint-line',
  /** Polite: "not on your access", a draft to approve. */
  ask: 'bg-ask text-ask-ink ring-ask-line',
  /** Refused (the refusal's red, the Inbox's rose). */
  danger: 'bg-danger text-danger-ink ring-danger-line',
} as const;
export type NoteTone = keyof typeof NOTE_TONE;

const NOTE_ICON: Record<NoteTone, LucideIcon> = { success: CheckCircle2, assistant: Info, ask: Info, danger: AlertCircle };

/** A note on a page: a status for a screen reader, or an alert when it is a refusal. */
export function InlineNote({ tone = 'success', children }: { tone?: NoteTone; children: ReactNode }) {
  const Icon = NOTE_ICON[tone];
  return (
    <p role={tone === 'danger' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-xl px-3 py-2 text-note ring-1 ${NOTE_TONE[tone]}`}>
      <Icon aria-hidden className="mt-px h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** A refusal said as the server said it: red, or the polite amber of "not on your access". */
export function InlineError({ text, tone = 'danger' }: { text: string; tone?: 'danger' | 'ask' }) {
  return <InlineNote tone={tone}>{text}</InlineNote>;
}

/** The focus ring of the frame's own controls, drawn inside them. */
export const FOCUS_INSIDE = 'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-coral';
