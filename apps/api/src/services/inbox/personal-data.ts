/**
 * A DELIBERATELY SIMPLE PERSONAL-DATA SCREEN for examples loaded from outside
 * the inbox (`POST /inbox/ai/examples/import`, SCRUM-220).
 *
 * An imported example has no thread behind it and nobody has looked at it
 * yet, so before it is even proposed its words are screened for the shapes
 * personal data most often takes in a chat. It is a net, not a guarantee: a
 * name or a child's detail passes it, which is why an imported example is
 * only ever PROPOSED and a person still approves it with the "contains no
 * personal data" confirmation (§D.5).
 *
 * What it refuses, and only this:
 *   - a phone-like number: a `+` and 8 or more digits (+66 81 234 5678), or a
 *     leading 0 and 9 or more digits (081-234-5678, 02 123 4567), up to two
 *     spaces, dashes, dots or brackets between digits; or any 8 digits in a
 *     row (a booking, card or id number). Prices ("350 450 550"), opening
 *     times ("10.00-20.00", "09.00-18.00") and dates do not take that shape;
 *   - an e-mail address;
 *   - a web address carrying a query string (`?a=b`) — the shape a booking,
 *     payment or tracking link takes. A plain address (the park's site) passes;
 *   - a messaging handle written as a contact: `line: @x`, `line id: x`,
 *     `ig: @x`, `instagram: x`, `telegram: @x`, `wechat: x`, `whatsapp: x`.
 *
 * The reason it gives names the KIND of data, never the matched text, so a
 * refusal carries no personal data into the answer or the log.
 */

/**
 * The history tool (`scripts/inbox/whatsapp-history.mjs`, plain Node) keeps a
 * copy of these patterns to de-identify before it ever sends; its own test
 * runs the same cases as this file's (`test/inbox-ai-examples-import.test.ts`).
 * Change both together.
 */
const PHONE_LIKE = /\+\d(?:[\s().-]{0,2}\d){7,}|(?<!\d)0(?:[\s().-]{0,2}\d){8,}|\d{8,}/;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i, 'an e-mail address'],
  [/\b(?:https?:\/\/|www\.)[^\s?#]*\?[^\s#]*=/i, 'a web address with a query string'],
  [/\b(?:line(?:\s*id)?|ig|instagram|telegram|tg|wechat|whatsapp)\s*[:：]\s*@?[\w.-]{2,}/i, 'a messaging handle'],
  [PHONE_LIKE, 'a phone number or another long number'],
];

/** The kind of personal data `text` still seems to hold, or null when it holds none of the screened shapes. */
export function personalDataIn(text: string | null | undefined): string | null {
  if (!text) return null;
  // Thai digits (U+0E50 to U+0E59) read as the digits they are, so a number written in Thai is caught too.
  const plain = text.replace(/[\u0e50-\u0e59]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
  for (const [pattern, kind] of PATTERNS) if (pattern.test(plain)) return kind;
  return null;
}
