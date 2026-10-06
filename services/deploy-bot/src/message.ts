/** Everything that turns a day's changes into the words posted to the group. Pure. */

export interface CommitInfo {
  sha: string;
  /** Full message: subject, blank line, body. */
  message: string;
}

export interface Section {
  title: string;
  bullets: string[];
}

/** `oto-api-staging` → `API`; `oto-console-staging` → `Console`; `oto-app-staging` → `OTO App`. */
export function serviceLabel(name: string): string {
  const core = name
    .replace(/^oto-/, '')
    .replace(/-(staging|production|prod|dev)$/, '')
    .replace(/-/g, ' ');
  if (core === 'app') return 'OTO App';
  if (core.length <= 3) return core.toUpperCase();
  return core.replace(/\b\w/g, (c) => c.toUpperCase());
}

const INTERNAL_TYPES = new Set(['docs', 'test', 'chore', 'ci', 'build', 'refactor', 'style']);

export interface ParsedSubject {
  type: string | null;
  text: string;
  internal: boolean;
}

/** Split a conventional-commit subject into its type and its sentence. */
export function parseSubject(message: string): ParsedSubject {
  const subject = (message.split('\n')[0] ?? '').trim();
  const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject);
  if (!m) return { type: null, text: capitalise(subject), internal: false };
  const type = (m[1] ?? '').toLowerCase();
  return { type, text: capitalise(m[2] ?? ''), internal: INTERNAL_TYPES.has(type) };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * WhatsApp reads `*`, `_`, `~` and backticks as formatting. A stray one in a
 * bullet would bold or strike half the message, so text that did not come from
 * this file has them removed before it is placed in one.
 */
export function plain(text: string): string {
  return text
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const FALLBACK_MAX_BULLETS = 12;

/**
 * The sections used when no summary could be written: the commit subjects
 * without their prefixes, housekeeping counted rather than listed.
 */
export function sectionsFromCommits(commits: CommitInfo[]): Section[] {
  const parsed = commits.map((c) => parseSubject(c.message)).filter((p) => p.text);
  const visible = parsed.filter((p) => !p.internal);
  const shown = (visible.length > 0 ? visible : parsed).slice(0, FALLBACK_MAX_BULLETS);
  const bullets = shown.map((p) => p.text);
  const rest = parsed.length - shown.length;
  if (rest > 0) bullets.push(`…and ${rest} smaller or internal change${rest === 1 ? '' : 's'}`);
  return bullets.length > 0 ? [{ title: 'What changed', bullets }] : [];
}

export function formatDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(at);
}

export interface DigestInput {
  envLabel: string;
  at: Date;
  timeZone: string;
  sections: Section[];
  /** Raw service names that had a deploy go live. */
  services: string[];
  commitCount: number;
  rollback: boolean;
  maxChars: number;
  maxParts: number;
}

/**
 * The digest as one or more messages, each within `maxChars`.
 *
 * A long digest is cut between bullets, never inside one, and a section that
 * runs over carries its title into the next part. If even `maxParts` parts are
 * not enough, the tail is dropped and counted — the limit exists so a busy day
 * cannot turn into a stream of messages from a number WhatsApp is watching.
 */
export function digestParts(i: DigestInput): string[] {
  const footerLines: string[] = [];
  if (i.rollback) footerLines.push('_Includes a roll-back to an earlier version._');
  const labels = [...new Set(i.services.map(serviceLabel))].sort();
  const count =
    i.commitCount > 0 ? ` · ${i.commitCount} change${i.commitCount === 1 ? '' : 's'}` : '';
  footerLines.push(`_Updated: ${labels.join(', ')}${count}_`);
  const footer = footerLines.join('\n');

  const headerFor = (n: number, of: number) =>
    [
      `🚀 *${i.envLabel} — what's new*`,
      `_${formatDay(i.at, i.timeZone)}${of > 1 ? ` · part ${n} of ${of}` : ''}_`,
    ].join('\n');
  // Every part is sized as if it carried the longest header, the footer and
  // the "and N more" line, so none of them can push a part over the limit.
  const budget =
    i.maxChars - headerFor(9, 9).length - footer.length - '…and 99 more changes'.length - 5;

  type Line = { text: string; title: string | null };
  const lines: Line[] = [];
  for (const section of i.sections) {
    const bullets = section.bullets.map(plain).filter(Boolean);
    if (bullets.length === 0) continue;
    lines.push({ text: `*${plain(section.title)}*`, title: plain(section.title) });
    for (const b of bullets) lines.push({ text: `• ${b}`, title: null });
  }

  const bodies: string[] = [];
  let current: string[] = [];
  let currentTitle: string | null = null;
  let dropped = 0;
  const size = (extra: string[]) => [...current, ...extra].join('\n').length;

  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]!;
    // A title always travels with its first bullet.
    const unit =
      line.title !== null && lines[n + 1] ? [line.text, lines[n + 1]!.text] : [line.text];
    const lead = line.title !== null && current.length > 0 ? [''] : [];

    if (current.length > 0 && size([...lead, ...unit]) > budget) {
      if (bodies.length + 1 >= i.maxParts) {
        dropped = lines.slice(n).filter((l) => l.title === null).length;
        break;
      }
      bodies.push(current.join('\n'));
      current = line.title === null && currentTitle ? [`*${currentTitle} (cont.)*`] : [];
    } else {
      current.push(...lead);
    }
    current.push(line.text);
    if (line.title !== null) currentTitle = line.title;
  }
  if (dropped > 0) current.push(`…and ${dropped} more change${dropped === 1 ? '' : 's'}`);
  if (current.length > 0) bodies.push(current.join('\n'));
  if (bodies.length === 0) bodies.push('');

  return bodies.map((body, idx) => {
    const last = idx === bodies.length - 1;
    return [headerFor(idx + 1, bodies.length), body, ...(last ? [footer] : [])]
      .filter((block) => block !== '')
      .join('\n\n');
  });
}
