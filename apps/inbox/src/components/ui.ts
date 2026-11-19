// THE CONTROLS' LOOK (SCRUM-1016, BookDate.dc.html and the other screens):
// one set of class strings for the buttons, fields and badges of the
// dialogs and the settings pages, all on the tokens of `index.css`, so no
// dialog carries a palette class of its own. Sizes come from the one scale
// (SCRUM-1045): 44 to 48 px on a phone, 28 to 38 px on a tablet or a
// desktop, and `hit` keeps every one a 44 px target on a touch screen.

/** The focus ring every control wears: coral, 3 : 1 against every ground (tokens-1016). */
export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral';

/**
 * The one main button (Book the date, Yes, mark as handled, Save): deep coral
 * with white words. Disabled it turns to the band's ground with muted words,
 * never coral at 60 %, which no one could read.
 */
export const BTN_MAIN = `hit inline-flex min-h-ctl-lg items-center justify-center gap-2 rounded-[14px] bg-coral px-4 text-action font-bold text-on-coral hover:bg-coral/90 disabled:cursor-not-allowed disabled:bg-band disabled:text-ink-muted md:rounded-xl md:px-3.5 ${FOCUS}`;

/** A dialog footer's main button: it takes the footer's width on a phone (BookDate.dc.html). */
export const BTN_FOOTER_MAIN = `${BTN_MAIN} max-md:flex-1`;

/** A confirmation that cannot be undone (Start over): the refusal's red, filled. */
export const BTN_DANGER = `hit inline-flex min-h-ctl-lg items-center justify-center gap-2 rounded-[14px] bg-danger-ink px-4 text-action font-bold text-danger hover:bg-danger-ink/90 disabled:opacity-60 max-md:flex-1 md:rounded-xl md:px-3.5 ${FOCUS}`;

/** Cancel, Clear, Back: words with no box. */
export const BTN_QUIET = `hit inline-flex min-h-ctl-lg items-center justify-center gap-1.5 rounded-xl px-4 text-action font-semibold text-ink hover:bg-wash disabled:opacity-60 md:px-3 ${FOCUS}`;

/** A second action beside the main one (Create BEO, Check payment): an outlined card. */
export const BTN_OUTLINE = `hit inline-flex min-h-ctl items-center justify-center gap-1.5 rounded-xl border border-edge bg-card px-3.5 text-ui font-semibold text-ink hover:bg-wash disabled:opacity-60 md:px-3 ${FOCUS}`;

/** An action on a card in a list (Edit, Archive, Approve, Insert): the control edge, 3 : 1 (SCRUM-1043). */
export const BTN_SMALL = `hit inline-flex min-h-ctl-sm items-center justify-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-note font-semibold text-ink-soft hover:bg-wash hover:text-ink disabled:opacity-60 md:px-2.5 ${FOCUS}`;

/** An icon-only button: 44 px on a phone, the scale's `icon` size elsewhere, its name in `aria-label`. */
export const BTN_ICON = `hit inline-flex size-icon shrink-0 items-center justify-center rounded-xl text-ink-soft hover:bg-wash hover:text-ink disabled:opacity-60 ${FOCUS}`;

/** A field (BookDate.dc.html): 48 px on a phone, the field border, ink on focus. */
export const INPUT =
  'min-h-ctl-lg w-full min-w-0 rounded-xl border border-field bg-card px-3 text-body text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink disabled:bg-band disabled:text-ink-muted';

/** A field's label over it. */
export const LABEL = 'text-note font-semibold text-ink';

/** A quiet line under a field. */
export const HINT = 'text-meta text-ink-muted';

/** A checkbox or a radio with its words: the whole line is the 44 px target. */
export const CHECK_LINE = 'hit inline-flex min-h-ctl cursor-pointer items-center gap-2.5 text-ui text-ink-soft';
export const CHECK_BOX = 'h-5 w-5 shrink-0 accent-coral md:h-4 md:w-4';

/**
 * The tints a badge or a dialog's icon wears, each a tested text pair
 * (tokens-1016): the neutral band, the assistant's mint, money's green, the
 * amber of a choice or a draft, the coral of what needs a person, and red.
 */
export const TONE = {
  neutral: 'bg-band text-ink-soft',
  assistant: 'bg-mint text-teal',
  money: 'bg-money-badge text-money-ink',
  ask: 'bg-ask text-ask-ink',
  needs: 'bg-needs text-needs-ink',
  danger: 'bg-danger text-danger-ink',
} as const;
export type Tone = keyof typeof TONE;

/** A small badge (a language, an approval, Draft): 8 px corners, a tone. */
export const BADGE = 'inline-flex items-center rounded-lg px-2 py-0.5 text-caption font-semibold';

/**
 * The focus ring for a control whose real input is hidden inside it (a file
 * picker in a label, a native select laid over a row): the ring is drawn on
 * the part a person sees when the hidden control holds focus.
 */
export const FOCUS_WITHIN =
  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-coral';

/** A settings page's eyebrow ("Settings · Templates"). */
export const PAGE_EYEBROW = 'flex items-center gap-2 text-meta font-bold uppercase tracking-[0.14em] text-ink-muted';

/** A settings page's line under its eyebrow. */
export const PAGE_LINE = 'mt-1 max-w-3xl text-ui leading-relaxed text-ink-soft';

/** A segment of a switch (the assistant's sections, the queues, a number's mode): 44 px on a phone. */
export const SEGMENT = `hit inline-flex min-h-ctl items-center rounded-lg px-3 text-ui font-semibold transition disabled:opacity-60 md:px-2.5 ${FOCUS}`;
/** The chosen segment: lighter than the band in both themes (`--oto-segment`, Dark.dc.html). */
export const SEGMENT_ON = 'bg-segment text-ink shadow-sm ring-1 ring-line';
export const SEGMENT_OFF = 'text-ink-soft hover:text-ink';

/** A settings page's card: the card ground, the line, the 16 px corner. */
export const PAGE_CARD = 'rounded-2xl border border-line bg-card p-4 sm:p-5';

/** An item card inside a settings page (a template, an entry, a rule). */
export const ITEM_CARD = 'min-w-0 rounded-2xl border border-line bg-card p-3.5';
