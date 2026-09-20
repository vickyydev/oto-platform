/**
 * `no-pii-in-logs` — refuse a log object literal that names a person.
 *
 * ## Why a rule at all, given the redactor
 *
 * The redactor is the guarantee; this is the nudge. They do different jobs and
 * both are cheap. `redact()` stops the value at run time, but it only sees the
 * object that actually reaches the logger — and the same literal gets copied
 * into a Sentry context, an `ops_run` payload, a device request body or a test
 * fixture, where no redactor is watching. Failing the line at author time is
 * what keeps `{ phone }` from being written in the first place, and it says so
 * with a message naming the alternative (`phoneHash`, an id) rather than
 * leaving the author to guess.
 *
 * ## Why this is small on purpose
 *
 * It matches one syntactic shape — a logger call whose first argument is an
 * object literal — against a short list of keys. It does not need type
 * information, it has no dependencies beyond ESLint's own AST, and it is about
 * a hundred lines. A rule that tried to follow a variable into a logger call
 * would need the type checker, would be slow on every file, and would be
 * abandoned the first time it was wrong. This one is worth maintaining because
 * there is almost nothing to maintain.
 *
 * The key list here is deliberately shorter than the redactor's: these are the
 * keys nobody has a legitimate reason to log, so a report is always right. The
 * redactor's broader list can afford false positives — a redacted binding is a
 * lost debugging detail — where a lint error would just be argued with.
 */

/**
 * The keys the ticket names, minus one. `code` is **not** in this list, and
 * that is a deliberate departure: running the rule over the api turned up
 * `log.error({ code: info.code }, 'alert delivery failed')`, which is an error
 * code and exactly what a failure line should carry. A linter cannot see the
 * value, so it would have to refuse every `code` or none — and a rule that
 * fires on the most common legitimate key in the codebase is a rule somebody
 * switches off. The redactor does know the value and redacts `code` when it
 * has the shape of a verification code, so the guarantee is kept where it can
 * be made properly. Unambiguous code keys (`verificationCode`, `authCode`,
 * `otp`) stay here.
 */
const DEFAULT_CONTAINS = [
  'phone',
  'email',
  'allergies',
  'allergy',
  'medicalnotes',
  'password',
  'token',
  'secret',
  'verificationcode',
  'approvalcode',
  'authcode',
  'resetcode',
  'setupcode',
  'cardnumber',
  'cardholder',
];
const DEFAULT_EXACT = ['name', 'notes', 'dateofbirth', 'dob', 'pan', 'cvv', 'otp', 'pin', 'address'];

/** Derivatives that exist to be logged. */
const DEFAULT_ALLOW = ['phonehash', 'emailhash'];

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'child', 'log']);

function normalize(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `req.log.info`, `logger.warn`, `this.log.error`, `app.log.child`, `console.log`. */
function isLoggerCall(node) {
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
  const method = callee.property.type === 'Identifier' ? callee.property.name : null;
  if (!method || !LOG_METHODS.has(method)) return false;

  const target = callee.object;
  if (target.type === 'Identifier') {
    const n = target.name.toLowerCase();
    return n === 'console' || n.endsWith('log') || n.endsWith('logger');
  }
  if (target.type === 'MemberExpression' && !target.computed && target.property.type === 'Identifier') {
    const n = target.property.name.toLowerCase();
    return n.endsWith('log') || n.endsWith('logger');
  }
  return false;
}

function propertyKeyName(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid personal data keys in a log object literal',
    },
    schema: [
      {
        type: 'object',
        properties: {
          contains: { type: 'array', items: { type: 'string' } },
          exact: { type: 'array', items: { type: 'string' } },
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      pii:
        '"{{key}}" is personal data and must not be written to a log. ' +
        'Log the entity id instead, or phoneHash(phone) from @oto/telemetry/node for a number.',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const contains = (options.contains ?? DEFAULT_CONTAINS).map(normalize);
    const exact = new Set((options.exact ?? DEFAULT_EXACT).map(normalize));
    const allow = new Set((options.allow ?? DEFAULT_ALLOW).map(normalize));

    function offends(key) {
      const k = normalize(key);
      if (!k || allow.has(k)) return false;
      if (exact.has(k)) return true;
      return contains.some((fragment) => k.includes(fragment));
    }

    /** Nested literals count: `log.info({ member: { phone } })` is the same line. */
    function inspect(node, seen) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.type === 'ObjectExpression') {
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const key = propertyKeyName(property);
          if (key && offends(key)) {
            context.report({ node: property.key, messageId: 'pii', data: { key } });
          }
          inspect(property.value, seen);
        }
        return;
      }
      if (node.type === 'ArrayExpression') {
        for (const element of node.elements) inspect(element, seen);
      }
    }

    return {
      CallExpression(node) {
        if (!isLoggerCall(node)) return;
        inspect(node.arguments[0], new Set());
      },
    };
  },
};
