/**
 * THE CALLER'S COUNTRY CODE (SCRUM-220 playbook): the ITU calling code of a
 * contact's E.164 phone, digits without the plus — `66` Thailand, `7` Russia —
 * for the assistant's turn context (`TurnContext.contactCountryCode`). The
 * playbook offers Thai or Russian once by the number a customer writes from,
 * and asks residency where the number says the customer may live here.
 *
 * No library call: E.164 calling codes are a prefix code (no code is the
 * start of another), so the length is read off the leading digits. Zones 1
 * and 7 are one digit; these forty-four are two; every other code is three
 * (ITU-T E.164 assignments).
 */

const TWO_DIGIT_CODES: ReadonlySet<string> = new Set([
  '20', '27',
  '30', '31', '32', '33', '34', '36', '39',
  '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86',
  '90', '91', '92', '93', '94', '95', '98',
]);

/** E.164: a plus, then up to fifteen digits, never a leading zero. */
const E164 = /^\+([1-9]\d{6,14})$/;

/** The calling code of an E.164 phone, or null when the value is not one (a scoped id, a local number). */
export function callingCodeOf(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = E164.exec(phone.trim())?.[1];
  if (!digits) return null;
  if (digits.startsWith('1') || digits.startsWith('7')) return digits.slice(0, 1);
  const two = digits.slice(0, 2);
  return TWO_DIGIT_CODES.has(two) ? two : digits.slice(0, 3);
}
