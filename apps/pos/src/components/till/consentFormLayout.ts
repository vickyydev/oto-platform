/**
 * SCRUM-943 — at phone width (the phone till hands this form to the parent,
 * and a narrow display) the language button would sit over the heading and
 * the bottom bar took a fifth of the screen: the heading starts below the
 * button, and the bar and its "Still needed" line are a little tighter.
 * Nothing changes at the display's or the till's own widths.
 */
export const NARROW_HEAD = 'max-[520px]:pt-14';
export const NARROW_BAR = 'max-[520px]:px-4 max-[520px]:py-3 max-[520px]:gap-2';
export const NARROW_LINE = 'max-[520px]:text-sm';

/**
 * SCRUM-954 — the phone till's form (`ConsentCapture` with `phoneScroll`): at
 * phone width the heading and the form scroll as one part (`PHONE_SCROLL` on
 * the part that holds both, `PHONE_SCROLL_FORM` on the form's own part, which
 * then grows with what it holds), so the heading leaves the screen to the form
 * as the family scrolls; the bar of "Still needed" and Done stays at the foot.
 * The heading took about 245 of the 844 pixels of a 390-wide phone, the bar
 * about 130 and "Return phone to staff" 88, which left the form under half.
 */
export const PHONE_SCROLL = 'max-[520px]:overflow-y-auto';
export const PHONE_SCROLL_FORM = 'max-[520px]:flex-none max-[520px]:overflow-visible';

/**
 * SCRUM-894 — on a short screen (a landscape tablet, 1024 by 600) the box
 * being typed in and its keys did not fit between the heading and the bottom
 * bar. Below 700 pixels of height the heading's subtitle is left out (the
 * keys are a little shorter too, `ScreenKeyboard`), so the box and its keys
 * stand in view above the bar. The counter display standing (600 by 1024)
 * and the till are taller and unchanged.
 */
export const SHORT_HIDE = '[@media(max-height:700px)]:hidden';

/**
 * SCRUM-943 / SCRUM-954 — the reconnecting line on the paired display's form
 * (`pages/Display.tsx`): laid over the top of the form, so nothing under the
 * family's finger moves as it appears and a tick pressed at that moment lands
 * (943). It lies UNDER the language button (z-30 below the button's z-40) and
 * keeps its words clear of the button's corner (the wide right padding; the
 * same on the left from 640 pixels, so the words stay centred), so the
 * language button stays in sight and can be pressed while it shows (954).
 */
export const FORM_RECONNECTING_LINE =
  'pointer-events-none absolute inset-x-0 top-0 z-30 border-b border-foreground/10 bg-background/95 py-2 pl-4 pr-36 sm:pl-36 text-center text-sm';

/**
 * SCRUM-954 — on the paired display's own form (the counter's 10-inch touch
 * monitor) every press in the bottom bar, each step pill and the language
 * button stand at least 44 pixels tall, a finger's size. The till's read-only
 * copy of the form, its own customer half and the phone keep their sizes.
 */
export const DISPLAY_TOUCH = 'min-h-11';
