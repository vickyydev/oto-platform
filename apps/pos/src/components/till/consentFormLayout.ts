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
