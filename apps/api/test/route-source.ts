import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reading the api's own source, for the conformance tests (SCRUM-290, SCRUM-291).
 *
 * Both of those ask a question about a route that the route registry cannot
 * answer. The registry knows a route's method, path and declared config; it
 * does not know whether the handler loads the row before it acts, or whether
 * the write happens inside a transaction. That is in the source, so this reads
 * the source.
 *
 * It is a brace matcher, not a parser, and it is honest about that: it skips
 * strings, template literals, comments and regular expressions so that a brace
 * inside one cannot throw the count off, and it does nothing else. What keeps
 * it trustworthy is not its cleverness but the assertion each test opens with —
 * every route the running app registered must have been found here, and the
 * counts must match. A parse that silently misses a file makes those fail
 * rather than making the check quietly vacuous.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ROUTES_DIR = join(SRC, 'routes');
const SERVICES_DIR = join(SRC, 'services');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export interface SourceRoute {
  /** `routes/catalog.ts`, for a failure message somebody can act on. */
  file: string;
  line: number;
  /** Upper case, as the registry spells it. */
  method: string;
  /** The path as written in the file, before the register prefix. */
  sourcePath: string;
  /** The path the app actually serves: prefix + sourcePath. */
  path: string;
  /** The text of the route's options object, `''` when it has none. */
  optionsText: string;
  /** The text of the `config: { … }` object, `''` when it has none. */
  configText: string;
  /** The text of the handler — the call's last argument. */
  handlerText: string;
}

// --- The brace matcher -------------------------------------------------------

const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Whether a `/` here opens a regular expression rather than dividing.
 *
 * Decided from the previous meaningful character, which is the usual
 * heuristic and is sound for this source: a division whose left side is a
 * literal or an identifier leaves a character this set does not contain.
 */
const REGEX_FOLLOWS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
  '\n',
]);

function endOfQuoted(src: string, start: number): number {
  const quote = src[start]!;
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
  }
  return src.length;
}

function endOfTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && src[i + 1] === '{') {
      i = matchDelimiter(src, i + 1) - 1;
      continue;
    }
  }
  return src.length;
}

function endOfRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let j = i + 1;
      while (j < src.length && /[a-z]/.test(src[j]!)) j += 1;
      return j;
    } else if (ch === '\n') return start + 1; // not a regex after all
  }
  return src.length;
}

/**
 * The index just past whatever literal or comment starts at `i`, or `i` itself
 * when nothing does.
 */
function skipAtomic(src: string, i: number, prev: string): number {
  const ch = src[i]!;
  if (ch === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl;
  }
  if (ch === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (ch === '"' || ch === "'") return endOfQuoted(src, i);
  if (ch === '`') return endOfTemplate(src, i);
  if (ch === '/' && REGEX_FOLLOWS.has(prev)) return endOfRegex(src, i);
  return i;
}

/** The index just past the delimiter closing the one at `open`. */
export function matchDelimiter(src: string, open: number): number {
  const stack: string[] = [];
  let prev = '';
  let i = open;
  while (i < src.length) {
    const skipped = skipAtomic(src, i, prev);
    if (skipped > i) {
      i = skipped;
      prev = 'x';
      continue;
    }
    const ch = src[i]!;
    if (ch in CLOSERS) {
      stack.push(CLOSERS[ch]!);
      prev = ch;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const want = stack.pop();
      if (want !== ch) {
        throw new Error(`unbalanced at index ${i}: expected ${want ?? 'nothing'}, found ${ch}`);
      }
      i += 1;
      if (stack.length === 0) return i;
      prev = ch;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    else if (ch === '\n') prev = prev === '' ? '' : prev;
    i += 1;
  }
  throw new Error(`unbalanced delimiter opened at index ${open}`);
}

/** The call's arguments, as source text, split at top-level commas. */
export function splitArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let start = open + 1;
  let prev = '';
  let i = start;
  while (i < src.length) {
    const skipped = skipAtomic(src, i, prev);
    if (skipped > i) {
      i = skipped;
      prev = 'x';
      continue;
    }
    const ch = src[i]!;
    if (ch in CLOSERS) {
      i = matchDelimiter(src, i);
      prev = 'x';
      continue;
    }
    if (ch === ')') {
      const last = src.slice(start, i);
      // A trailing comma is punctuation, not an argument — and prettier puts
      // one after every handler in this codebase, so without this the last
      // argument of every route call would read as empty.
      if (last.trim() !== '' || args.length === 0) args.push(last);
      return args;
    }
    if (ch === ',') {
      args.push(src.slice(start, i));
      i += 1;
      start = i;
      prev = ',';
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  throw new Error(`unterminated argument list at index ${open}`);
}

/** The text of an object property whose value is an object literal. */
export function objectProperty(text: string, key: string): string {
  const pattern = new RegExp(`(^|[^\\w$.])${key}\\s*:\\s*\\{`);
  const found = pattern.exec(text);
  if (!found) return '';
  const brace = text.indexOf('{', found.index + found[0].length - 1);
  if (brace < 0) return '';
  return text.slice(brace, matchDelimiter(text, brace));
}

const stripQuotes = (text: string): string | null => {
  const trimmed = text.trim();
  const first = trimmed[0];
  if ((first !== "'" && first !== '"' && first !== '`') || trimmed.at(-1) !== first) return null;
  return trimmed.slice(1, -1);
};

// --- Where each route file is mounted ---------------------------------------

/**
 * The prefix every route file is registered under, derived from `app.ts`
 * rather than restated here — a second copy of that mapping would go stale the
 * first time a prefix moved, and every path in this module would be quietly
 * wrong. If the derivation itself fails, the paths stop matching the registry
 * and the route-matching assertion each test opens with says so.
 */
export function readPrefixes(): Map<string, string> {
  const app = readFileSync(join(SRC, 'app.ts'), 'utf8');
  const symbolToFile = new Map<string, string>();
  for (const m of app.matchAll(/import\s*\{\s*([\w$]+)\s*\}\s*from\s*'\.\/routes\/([\w-]+)'/g)) {
    symbolToFile.set(m[1]!, `${m[2]!}.ts`);
  }
  const prefixes = new Map<string, string>();
  for (const m of app.matchAll(
    /app\.register\(\s*([\w$]+)\s*(?:,\s*\{[^}]*prefix:\s*'([^']*)'[^}]*\})?\s*\)/g,
  )) {
    const file = symbolToFile.get(m[1]!);
    if (file) prefixes.set(file, m[2] ?? '');
  }
  return prefixes;
}

// --- Routes ------------------------------------------------------------------

export function readRoutes(): SourceRoute[] {
  const prefixes = readPrefixes();
  const routes: SourceRoute[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const prefix = prefixes.get(file) ?? '';
    let prev = '';
    let i = 0;
    while (i < src.length) {
      const skipped = skipAtomic(src, i, prev);
      if (skipped > i) {
        i = skipped;
        prev = 'x';
        continue;
      }
      const method = HTTP_METHODS.find((m) => src.startsWith(`app.${m}(`, i));
      if (!method) {
        const ch = src[i]!;
        if (!/\s/.test(ch)) prev = ch;
        i += 1;
        continue;
      }
      const open = i + `app.${method}`.length;
      const args = splitArgs(src, open);
      const sourcePath = stripQuotes(args[0] ?? '');
      if (sourcePath === null) {
        // A route whose path is not a literal cannot be resolved here. The
        // count assertion in each test is what makes that visible rather than
        // silently dropped.
        i = matchDelimiter(src, open);
        prev = 'x';
        continue;
      }
      const optionsText = args.length >= 3 ? args[1]! : '';
      routes.push({
        file: `routes/${file}`,
        line: src.slice(0, i).split('\n').length,
        method: method.toUpperCase(),
        sourcePath,
        path: sourcePath === '/' ? prefix || '/' : `${prefix}${sourcePath}`,
        optionsText,
        configText: objectProperty(optionsText, 'config'),
        handlerText: args.at(-1) ?? '',
      });
      i = matchDelimiter(src, open);
      prev = 'x';
    }
  }
  return routes;
}

// --- Functions, so a handler can be followed into the service it calls -------

export interface SourceFunction {
  file: string;
  name: string;
  body: string;
}

const FUNCTION_FORMS = [
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*[(<]/g,
  /(?:^|\n)\s*(?:export\s+)?const\s+([\w$]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?[(<]/g,
];

/**
 * Every `.ts` under a directory, its subdirectories included, as
 * `<label>/<path>` pairs.
 *
 * SUBDIRECTORIES WERE NOT WALKED UNTIL S2-10a, and the consequence was
 * invisible rather than loud: `services/payments/` — the attempt ledger, the
 * cash drawer and the QR gateway, which between them are every write that
 * moves money — was not in the index at all, so a route whose transaction sits
 * in one of them read as a route with no transaction. The conformance check
 * failed safe (it names a route rather than passing it), which is why nobody
 * noticed; but a service directory that grows a subdirectory should not
 * silently leave the walk.
 */
function tsFilesUnder(dir: string, label: string, prefix = ''): Array<{ path: string; file: string }> {
  const out: Array<{ path: string; file: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...tsFilesUnder(join(dir, entry.name), label, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push({ path: join(dir, entry.name), file: `${label}/${prefix}${entry.name}` });
    }
  }
  return out;
}

/**
 * Every named function in the routes and services, by name, with its body.
 *
 * Names are global across both directories, so two functions sharing a name
 * are both recorded and a lookup returns both. That is deliberate: for the
 * question these tests ask — does anything on this path open a transaction —
 * an over-broad answer fails safe towards "yes", and a name collision is
 * therefore a reason to trust a PASS less, never a reason to doubt a failure.
 */
export function readFunctions(): Map<string, SourceFunction[]> {
  const index = new Map<string, SourceFunction[]>();
  for (const [dir, label] of [
    [ROUTES_DIR, 'routes'],
    [SERVICES_DIR, 'services'],
  ] as const) {
    for (const { path, file } of tsFilesUnder(dir, label)) {
      const src = readFileSync(path, 'utf8');
      for (const form of FUNCTION_FORMS) {
        form.lastIndex = 0;
        for (const m of src.matchAll(form)) {
          const name = m[1]!;
          const brace = findBodyBrace(src, m.index + m[0].length);
          if (brace < 0) continue;
          let body: string;
          try {
            body = src.slice(brace, matchDelimiter(src, brace));
          } catch {
            continue;
          }
          index.set(name, [...(index.get(name) ?? []), { file, name, body }]);
        }
      }
    }
  }
  return index;
}

/** The same walk, for the checks that read whole files rather than functions. */
export function readSourceFiles(): Array<{ file: string; src: string }> {
  return [
    ...tsFilesUnder(ROUTES_DIR, 'routes'),
    ...tsFilesUnder(SERVICES_DIR, 'services'),
  ].map(({ path, file }) => ({ file, src: readFileSync(path, 'utf8') }));
}

/**
 * The `{` that opens a function body, from just inside its parameter list.
 * Returns -1 for an arrow with an expression body, which has none.
 *
 * The return type is the trap, and it cost a first draft of this module its
 * answer: `async function standing(…): Promise<{ row: StationRow }> {` has TWO
 * open braces after the parameters, and taking the first one indexed the type
 * as the body — so six routes that do load-then-check through that helper read
 * as doing nothing at all. The body brace is the first one that is not inside
 * angle brackets, which is what the depth count below is for.
 */
function findBodyBrace(src: string, afterName: number): number {
  let i = afterName - 1;
  // Step over any type parameters, then the parameter list.
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '<') {
      i = skipAngles(src, i);
      continue;
    }
    if (ch === '(') {
      i = matchDelimiter(src, i);
      continue;
    }
    break;
  }
  for (let j = i; j < src.length && j < i + 2_000; j += 1) {
    const ch = src[j]!;
    if (ch === '<') {
      j = skipAngles(src, j) - 1;
      continue;
    }
    if (ch === '(') {
      j = matchDelimiter(src, j) - 1;
      continue;
    }
    if (ch === '{') return j;
    // An overload signature, or a declaration with no body at all.
    if (ch === ';') return -1;
  }
  return -1;
}

/** The index just past the `>` that closes the `<` at `open`. */
function skipAngles(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src.startsWith('=>', i)) {
      // A function type inside the generic — its `>` is not a closer.
      i += 1;
      continue;
    }
    const ch = src[i]!;
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return open + 1;
}

/**
 * The same text with every `audit.record(…)` call removed.
 *
 * An audit row names the operator the ACTOR belongs to. That is provenance,
 * and it is not the same claim as "this row is ours" — the two look identical
 * to a text search, and the difference is the whole of SCRUM-281. The alert
 * route acknowledged another operator's alert while writing
 * `operatorId: auth.operatorId` into its audit row four lines below, which is
 * precisely how the wrong operator ended up on the record that exists to
 * settle who did what. A check that accepted that line as evidence of scoping
 * would have passed the bug it was written to catch.
 */
export function withoutAuditCalls(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const found = text.indexOf('audit.record(', i);
    if (found < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, found);
    const open = found + 'audit.record'.length;
    try {
      i = matchDelimiter(text, open);
    } catch {
      i = open + 1;
    }
  }
  return out;
}

/** Every identifier called as a function in this text. */
export function callsIn(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w$.])([\w$]+)\s*\(/g)) names.add(m[1]!);
  // A method call on a namespace — `audit.record(…)`, `sale.finalise(…)`.
  for (const m of text.matchAll(/(?:^|[^\w$])[\w$]+\.([\w$]+)\s*\(/g)) names.add(m[1]!);
  return names;
}

/**
 * Whether `text`, or anything it calls up to `depth` hops away, matches.
 *
 * The depth is a budget, not a proof: a transaction opened four calls deep is
 * not seen. That direction is the safe one — it reports a route as
 * non-conforming that a reader can then confirm — and a route whose write is
 * four hops from its handler is worth a look anyway.
 */
export function reachesText(
  text: string,
  matches: (body: string) => boolean,
  functions: Map<string, SourceFunction[]>,
  depth = 3,
): boolean {
  if (matches(text)) return true;
  if (depth <= 0) return false;
  for (const name of callsIn(text)) {
    for (const fn of functions.get(name) ?? []) {
      if (reachesText(fn.body, matches, functions, depth - 1)) return true;
    }
  }
  return false;
}
