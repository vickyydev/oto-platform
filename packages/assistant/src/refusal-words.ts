/**
 * REFUSALS IN PLAIN WORDS (SCRUM-591, test night 2026-10-21, finding W3).
 *
 * The refusal LINE under an answer stays the route's own sentence, verbatim
 * (plan §D.4): "Platform: Missing permission inbox:conversation:read". The
 * answer's PROSE must not repeat it: on the night the model wrote "Missing
 * permission inbox:conversation:read. That's the same answer the screen
 * gives." — a permission string, read by reception. Two halves, both pure:
 *
 *   plainRefusal        the sentence the engine hands the model beside the
 *                       envelope (`error.plain`): what the person cannot see,
 *                       in words ("You don't have access to the team inbox").
 *   softenRefusalProse  the server's own belt and braces over the final
 *                       prose: a refusal's verbatim message becomes its plain
 *                       sentence, a "Missing permission X" phrase becomes the
 *                       plain sentence for X, and any bare permission token
 *                       left (`a:b:c`) becomes "that access". Counts what it
 *                       changed, for the audit's words; the line is untouched.
 */

export interface RefusalWords {
  system: 'platform' | 'oto_app';
  status: number;
  code: string | null;
  message: string;
}

/** What a platform permission's resource is, as a person would name it. */
const RESOURCE_WORDS: Readonly<Record<string, string>> = {
  'inbox:conversation': 'the team inbox',
  'inbox:dashboard': 'the Inbox dashboard',
  'inbox:template': 'the Inbox templates',
  'inbox:channel': 'the Inbox channels',
  'pos:member': 'the member register',
  'pos:child': "a child's record",
  'pos:visit': 'the visit register',
  'pos:checkin': 'the check-in board and the park count',
  'pos:booking': 'the bookings',
  'pos:sale': 'the sales',
  'pos:cash': 'the cash drawer',
  'pos:wallet': 'the wallets',
  'pos:stock': 'the stock screens',
  'pos:event': 'the events',
  'admin:audit': 'the audit trail',
  'admin:branch': 'the branch list',
  'admin:health': 'the platform health screens',
  'admin:station': 'the stations and devices',
  'admin:account': 'the staff accounts',
  'admin:role': 'the roles',
  'admin:benefit': 'the staff benefits',
  'admin:booth': 'the booths and vouchers',
  'assistant:log': "the assistant's log",
  'app:oto_app': 'the OTO App',
  'app:console': 'the Console',
  'app:inbox': 'the Inbox',
  'app:pos': 'the till',
  'app:booth': 'the booth',
};

const PERMISSION_TOKEN = /\b([a-z_]+:[a-z_]+):[a-z_]+\b/g;
const MISSING_PERMISSION = /^Missing permission ([a-z_]+:[a-z_]+):([a-z_]+)$/;
const HOLD_BUT_NOT_AT = /^You hold [a-z_:]+, but not at (.+)$/;

function resourceWords(resource: string): string {
  return RESOURCE_WORDS[resource] ?? 'that screen';
}

/**
 * The plain sentence for a refusal: what the person cannot see, with no
 * permission string, role name or code in it. The platform's own two shapes
 * (`session.ts`, `access-control.ts`) and the OTO App's words are read by
 * pattern; anything else gets the status's own sentence.
 */
export function plainRefusal(r: RefusalWords): string {
  const missing = MISSING_PERMISSION.exec(r.message);
  if (missing) return `You don't have access to ${resourceWords(missing[1]!)}.`;
  const held = HOLD_BUT_NOT_AT.exec(r.message);
  if (held) return `That branch (${held[1]}) is not on your access.`;
  if (r.system === 'oto_app') {
    if (r.code === 'not_provisioned') return "You don't have an OTO App user yet, so the OTO App cannot answer for you.";
    if (r.code === 'disabled') return 'Your OTO App user is disabled, so the OTO App cannot answer for you.';
    if (/payroll roles only/i.test(r.message)) return 'Salary details need the payroll role.';
    if (/insufficient permissions/i.test(r.message)) return "That needs a manager's access in the OTO App.";
    if (/access denied to this employee|not allowed|denied/i.test(r.message)) return 'That person is not on your access in the OTO App.';
  }
  if (r.status === 401) return 'You are not signed in there.';
  if (r.status === 404) return 'That record is not one you can see.';
  if (r.status === 423) return 'Your session is locked.';
  return 'That is not in your access.';
}

export interface SoftenedProse {
  text: string;
  /** How many refusal sentences, "Missing permission" phrases and bare permission tokens were rewritten. */
  rewrites: number;
}

/**
 * The final prose with every permission string gone. Pure in the refusals
 * the ask recorded: their verbatim messages (any system) become their plain
 * sentences first, so a model that pasted "Missing permission X. That's the
 * same answer the screen gives." reads "You don't have access to the team
 * inbox. That's the same answer the screen gives."
 */
export function softenRefusalProse(text: string, refusals: readonly RefusalWords[] = []): SoftenedProse {
  let out = text;
  let rewrites = 0;
  for (const r of refusals) {
    if (!r.message || !out.includes(r.message)) continue;
    // The plain sentence ends in a full stop; the one the prose put after the message is absorbed.
    const verbatim = new RegExp(`${r.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?`, 'g');
    out = out.replace(verbatim, plainRefusal(r));
    rewrites += 1;
  }
  out = out.replace(/Missing permission ([a-z_]+:[a-z_]+):[a-z_]+/g, (_m, resource: string) => {
    rewrites += 1;
    return `You don't have access to ${resourceWords(resource)}`;
  });
  out = out.replace(PERMISSION_TOKEN, () => {
    rewrites += 1;
    return 'that access';
  });
  return { text: out, rewrites };
}
