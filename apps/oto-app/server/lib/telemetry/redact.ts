import { isPgError, scrubPgError } from './scrub';

/**
 * One place decides what may be written down.
 *
 * ## Why both a key deny-list and value-shape detection
 *
 * Neither strategy is sufficient on its own, and the two fail in opposite
 * directions, which is the whole argument for running both.
 *
 * A **key deny-list** is the only thing that can catch a value with no shape.
 * A child's `medicalNotes` is free text — "peanut allergy, carries an EpiPen"
 * — and a `name` is a word. Nothing about either string distinguishes it from
 * a branch name or a job name; only the key it arrived under says it belongs
 * to a person. But a deny-list is a list somebody has to maintain, and it only
 * ever covers the keys we thought of.
 *
 * **Value-shape detection** covers the keys nobody thought of. The leak
 * S2-01a closed was exactly that shape: Postgres put a phone number in a field
 * called `detail`, which is not a word anyone would have put on a PII list.
 * The same goes for a terminal's `rawResponse`, a third party's
 * `additionalInfo`, or a phone interpolated into a message string. But shape
 * detection alone would have let every name and every medical note straight
 * through.
 *
 * So: the key rules decide whether a value survives at all, and the shape
 * rules then sweep whatever did survive, including inside strings we kept
 * because they were useful.
 *
 * ## Why it never throws and never hangs
 *
 * A redactor sits between the program and its log line. If it throws, it takes
 * the log line with it — and, from an error handler, the request too. If it
 * hangs on a cyclic or enormous object it does the same thing more slowly. So
 * every traversal is bounded (depth, node budget, keys per object, items per
 * array, string length), every property read is guarded, cycles are detected
 * along the ancestor path, and the whole call is wrapped. Truncation is always
 * *safe*: a node beyond a limit is replaced, never passed through unexamined.
 */

const REDACTED = '[redacted]';
const PHONE_MARK = '[redacted:phone]';
const EMAIL_MARK = '[redacted:email]';
const CARD_MARK = '[redacted:card]';

export interface RedactOptions {
  /** Nesting beyond this is replaced wholesale. */
  maxDepth?: number;
  /** Total nodes visited before the walk stops descending. */
  maxNodes?: number;
  /** Keys kept per object; the rest are summarised. */
  maxKeys?: number;
  /** Items kept per array; the rest are summarised. */
  maxItems?: number;
  /** Strings longer than this are cut before the shape rules run on them. */
  maxStringLength?: number;
  /** Stack frames kept on an error. */
  maxStackLines?: number;
  /** Extra keys to deny, matched the same way as the built-in exact list. */
  extraKeys?: readonly string[];
}

type Limits = Required<Omit<RedactOptions, 'extraKeys'>>;

const DEFAULTS: Limits = {
  maxDepth: 8,
  maxNodes: 2000,
  maxKeys: 64,
  maxItems: 64,
  maxStringLength: 2000,
  maxStackLines: 20,
};

/**
 * Keys are compared with punctuation and case removed, so `medical_notes`,
 * `medicalNotes` and `MEDICAL-NOTES` are one key.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Checked first, so a deliberately safe derivative of a denied value survives.
 * `phoneHash` exists precisely so a log can say "the same number failed five
 * times"; redacting it would leave nothing to correlate on.
 */
const ALLOW = new Set(['phonehash', 'emailhash', 'phonecountry', 'phoneregion']);

/**
 * Exact keys. Deliberately exact rather than substring for the name family:
 * a bare `name` beside a member or a child is a person, while `branchName`,
 * `jobName`, `stationName` and `packageName` are things the console has to be
 * able to read. Qualified person-names are listed individually instead.
 */
const DENY_EXACT = new Set([
  // people
  'name',
  'firstname',
  'lastname',
  'fullname',
  'givenname',
  'familyname',
  'middlename',
  'nickname',
  'displayname',
  'childname',
  'childrennames',
  'membername',
  'guardianname',
  'holdername',
  'cardholdername',
  'contactname',
  'staffname',
  'employeename',
  // free text about a person
  'notes',
  'note',
  'membernotes',
  'childnotes',
  'remark',
  'remarks',
  'comment',
  'comments',
  // where they live
  'address',
  'addressline1',
  'addressline2',
  'street',
  'postcode',
  'postalcode',
  'zip',
  // credentials carried on a request
  'cookie',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'credentials',
  'handoff',
  // the request itself — a body or a query string is untyped by definition
  'body',
  'rawbody',
  'payload',
  'query',
  'querystring',
  'search',
  'searchterm',
  'q',
  // card data
  'pan',
  'cvv',
  'cvc',
  'expiry',
  'expirydate',
  'iccdata',
  'emvdata',
  'dob',
  'pin',
]);

/**
 * Substrings. Used only where the fragment cannot mean anything else:
 * a key containing `phone`, `allerg` or `password` is never about a branch.
 */
const DENY_CONTAINS = [
  'phone',
  'mobile',
  'msisdn',
  'telephone',
  'email',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'privatekey',
  'signingkey',
  'devicekey',
  'allerg',
  'medical',
  'dateofbirth',
  'birthdate',
  'birthday',
  'passport',
  'nationalid',
  'idcard',
  'cardnumber',
  'cardholder',
  'track1',
  'track2',
  'pincode',
  'otp',
];

/** Unambiguously a credential whatever it looks like. */
const DENY_CODE_KEYS = new Set([
  'authcode',
  'approvalcode',
  'approvalnumber',
  'verificationcode',
  'resetcode',
  'setupcode',
  'smscode',
  'accesscode',
  'securitycode',
  'confirmationcode',
]);

/**
 * `code` alone is ambiguous and far too useful to blanket-redact: it is the
 * error code on every envelope we send (`MEMBER_PHONE_EXISTS`), the SQLSTATE
 * on a pg error and the `ECONNREFUSED` on a socket. It is redacted only when
 * the value has the shape of a verification code — a short run of digits as a
 * string, which is how ours are minted and stored. A numeric `code` is left
 * alone; nothing issues a verification code as a number.
 */
const VERIFICATION_CODE_VALUE = /^\d{4,8}$/;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** Four or more groups of digits, the way a card is written out. */
const GROUPED_DIGITS_RE = /(?<![\d-])\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,4})?(?![\d-])/g;
/**
 * An unbroken card-length run. Luhn is what separates it from an id, so the
 * boundary only has to exclude a longer number or a decimal — letters are
 * allowed on either side, because that is how a card arrives inside track
 * data (`;4111111111111111=2512…?`) and inside a terminal's raw response.
 */
const BARE_CARD_RE = /(?<![\d.])\d{14,19}(?![\d.])/g;
/** `+66811111111`, `+66 81 111 1111`, `+44 7911 123456`. */
const INTL_PHONE_RE = /\+\d[\d\s().-]{6,18}\d/g;
/** Thai local trunk form. A leading zero is not something JSON produces. */
const LOCAL_PHONE_RE = /(?<![\w+])0\d{8,9}(?![\w])/g;
/** The same number with the country code and no plus. */
const BARE_TH_PHONE_RE = /(?<![\w+.])66[689]\d{8}(?![\w.])/g;

/** A card passes Luhn; a timestamp or an id almost never does. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The shape sweep. Values are replaced in place rather than the whole string
 * being dropped, so `duplicate key value violates unique constraint
 * "member_phone_unique"` stays readable while the number inside `Key
 * (operator_id, phone)=(…, +66811111111)` does not survive.
 *
 * Order matters: the card patterns run before the phone patterns so a grouped
 * card is not mistaken for an international number, and every replacement is
 * letters and brackets, so a later pattern cannot match inside one.
 */
function sweepValues(text: string): string {
  return text
    .replace(EMAIL_RE, EMAIL_MARK)
    .replace(GROUPED_DIGITS_RE, CARD_MARK)
    .replace(BARE_CARD_RE, (m) => (passesLuhn(m) ? CARD_MARK : m))
    .replace(INTL_PHONE_RE, PHONE_MARK)
    .replace(LOCAL_PHONE_RE, PHONE_MARK)
    .replace(BARE_TH_PHONE_RE, PHONE_MARK);
}

interface State {
  limits: Limits;
  deny: Set<string>;
  nodes: number;
  /** Ancestors on the current path, so a shared child is not called a cycle. */
  path: Set<object>;
}

function overBudget(s: State): boolean {
  return s.nodes >= s.limits.maxNodes;
}

/** A property read can throw: a getter, a proxy, a revoked reference. */
function read(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return '[unreadable]';
  }
}

function keyVerdict(key: string, value: unknown, s: State): 'deny' | 'keep' {
  const k = normalizeKey(key);
  if (!k || ALLOW.has(k)) return 'keep';
  if (s.deny.has(k) || DENY_CODE_KEYS.has(k)) return 'deny';
  if (k === 'code') {
    return typeof value === 'string' && VERIFICATION_CODE_VALUE.test(value) ? 'deny' : 'keep';
  }
  for (const fragment of DENY_CONTAINS) {
    if (k.includes(fragment)) return 'deny';
  }
  return 'keep';
}

function walkString(text: string, s: State): string {
  // Cut first, then sweep: a megabyte of text should not also cost a
  // megabyte of regex, and anything past the cut is gone either way.
  const cut =
    text.length > s.limits.maxStringLength
      ? `${text.slice(0, s.limits.maxStringLength)}[truncated ${text.length} chars]`
      : text;
  return sweepValues(cut);
}

function isErrorLike(value: object): boolean {
  if (value instanceof Error) return true;
  const v = value as { message?: unknown; stack?: unknown };
  return typeof v.message === 'string' && typeof v.stack === 'string';
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function byteLength(value: object): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  return ArrayBuffer.isView(value) ? value.byteLength : 0;
}

function walkEntry(key: string, value: unknown, depth: number, s: State): unknown {
  return keyVerdict(key, value, s) === 'deny' ? REDACTED : walk(value, depth, s);
}

function walkError(err: object, depth: number, s: State): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = read(err, 'name');
  // `type`, not `name`: `name` is a denied key, and an error's class name is
  // one of the few things worth keeping on a failure line.
  out.type = typeof type === 'string' ? type : 'Error';
  out.message = walkEntry('message', read(err, 'message'), depth, s);
  const code = read(err, 'code');
  if (code !== undefined) out.code = walkEntry('code', code, depth, s);
  const statusCode = read(err, 'statusCode');
  if (statusCode !== undefined) out.statusCode = walkEntry('statusCode', statusCode, depth, s);
  const details = read(err, 'details');
  if (details !== undefined) out.details = walkEntry('details', details, depth, s);
  const stack = read(err, 'stack');
  if (typeof stack === 'string') {
    const lines = stack.split('\n').slice(0, s.limits.maxStackLines);
    out.stack = sweepValues(lines.join('\n'));
  }
  const cause = read(err, 'cause');
  // The cause chain is walked like any other branch, so its depth, its cycles
  // and its budget are the same ones bounding everything else.
  if (cause !== undefined) out.cause = walk(cause, depth + 1, s);
  return out;
}

function walk(value: unknown, depth: number, s: State): unknown {
  s.nodes += 1;
  if (overBudget(s)) return '[truncated: size]';

  switch (typeof value) {
    case 'string':
      return walkString(value, s);
    case 'number':
    case 'boolean':
    case 'undefined':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return '[function]';
  }
  if (value === null) return null;

  const obj = value as object;
  if (depth >= s.limits.maxDepth) return '[truncated: depth]';
  if (s.path.has(obj)) return '[circular]';

  // Even deciding what kind of thing this is can throw — a revoked proxy
  // rejects every property access, including the ones the type checks make.
  // One unreadable node must not cost the whole log line.
  try {
    return walkObject(obj, depth, s);
  } catch {
    return '[unreadable]';
  }
}

function walkObject(obj: object, depth: number, s: State): unknown {
  const value: unknown = obj;
  // A pg error before the generic error branch: its useful fields are the
  // structural ones, and its `detail` is the field that leaked in Sprint 1.
  if (isPgError(obj)) {
    const scrubbed = scrubPgError(obj);
    s.path.add(obj);
    try {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(scrubbed)) out[k] = walkEntry(k, v, depth + 1, s);
      return out;
    } finally {
      s.path.delete(obj);
    }
  }

  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? '[invalid date]' : value.toISOString();
  }
  if (value instanceof RegExp) return value.toString();
  // A Map's keys and a Set's members are values nobody named, so there is no
  // key rule to apply to them; they are summarised rather than guessed at.
  if (value instanceof Map) return `[Map ${value.size}]`;
  if (value instanceof Set) return `[Set ${value.size}]`;
  if (isBinary(obj)) return `[binary ${byteLength(obj)} bytes]`;

  s.path.add(obj);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      const shown = Math.min(value.length, s.limits.maxItems);
      for (let i = 0; i < shown; i += 1) {
        if (overBudget(s)) {
          out.push('[truncated: size]');
          break;
        }
        out.push(walk(value[i], depth + 1, s));
      }
      if (value.length > shown) out.push(`[+${value.length - shown} more]`);
      return out;
    }

    if (isErrorLike(obj)) return walkError(obj, depth + 1, s);

    const out: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      return '[unreadable]';
    }
    const shown = Math.min(keys.length, s.limits.maxKeys);
    for (let i = 0; i < shown; i += 1) {
      if (overBudget(s)) {
        out['[truncated]'] = 'size';
        break;
      }
      const key = keys[i] as string;
      // A key can itself be a value — an object keyed by phone number.
      const safeKey = sweepValues(key);
      out[safeKey] = walkEntry(key, read(obj, key), depth + 1, s);
    }
    if (keys.length > shown) out['[truncated]'] = `+${keys.length - shown} keys`;
    return out;
  } finally {
    s.path.delete(obj);
  }
}

function makeState(options: RedactOptions): State {
  const limits: Limits = {
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
    maxNodes: options.maxNodes ?? DEFAULTS.maxNodes,
    maxKeys: options.maxKeys ?? DEFAULTS.maxKeys,
    maxItems: options.maxItems ?? DEFAULTS.maxItems,
    maxStringLength: options.maxStringLength ?? DEFAULTS.maxStringLength,
    maxStackLines: options.maxStackLines ?? DEFAULTS.maxStackLines,
  };
  const deny = options.extraKeys?.length
    ? new Set([...DENY_EXACT, ...options.extraKeys.map(normalizeKey)])
    : DENY_EXACT;
  return { limits, deny, nodes: 0, path: new Set() };
}

/**
 * Make an arbitrary value safe to write down. Never throws: a redactor that
 * fails takes the log line — and, called from an error handler, the request —
 * with it, so the last resort is a marker rather than an exception.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  try {
    return walk(value, 0, makeState(options));
  } catch {
    return '[redaction failed]';
  }
}

/**
 * The same, shaped for a log call: always an object, so a caller that passed
 * a bare string or an error still produces a structured line.
 */
export function redactBindings(
  value: unknown,
  options: RedactOptions = {},
): Record<string, unknown> {
  const out = redact(value, options);
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    return out as Record<string, unknown>;
  }
  return { value: out };
}

/** A redactor with the limits fixed, for a package that configures them once. */
export function createRedactor(options: RedactOptions = {}) {
  return (value: unknown): unknown => redact(value, options);
}

/** Exposed so a caller can check a key before building a binding at all. */
export function isSensitiveKey(key: string, value?: unknown): boolean {
  return keyVerdict(key, value, makeState({})) === 'deny';
}

/** Exposed for tests and for scrubbing a message a caller already formatted. */
export function scrubText(text: string): string {
  return sweepValues(text);
}
