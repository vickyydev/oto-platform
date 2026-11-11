/**
 * A photo's or video's width, height or length in seconds, as an attachment
 * row can hold it: a whole number above nothing, or not known (SCRUM-855).
 *
 * A browser does not always know. A recording made in the page carries no
 * length, and the browser reports `Infinity`; a file it cannot read gives
 * `NaN` or 0. None of those is a measure, and the columns are integers: sent
 * on as they were, one of them refused the whole attachment after its file
 * was already stored. So both ends ask here. The browser sends a measure
 * only when this gives one, and the server stores what this gives, whatever
 * it was sent.
 *
 * A number, or a plain decimal as a form field carries it, rounded to the
 * nearest whole number. Anything else is not known: text, a negative, an
 * exponent, a clip shorter than half a second, a number past what the column
 * holds.
 */
const LARGEST_INTEGER_COLUMN = 2_147_483_647;

export function wholeMeasure(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())
      ? Number(value)
      : NaN;
  if (!Number.isFinite(number)) return null;
  const whole = Math.round(number);
  return whole > 0 && whole <= LARGEST_INTEGER_COLUMN ? whole : null;
}
