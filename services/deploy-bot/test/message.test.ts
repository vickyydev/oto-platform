import { describe, expect, it } from 'vitest';
import {
  digestParts,
  parseSubject,
  plain,
  sectionsFromCommits,
  serviceLabel,
  type DigestInput,
} from '../src/message.js';

describe('serviceLabel', () => {
  it('drops the project prefix and the environment suffix', () => {
    expect(serviceLabel('oto-api-staging')).toBe('API');
    expect(serviceLabel('oto-pos-staging')).toBe('POS');
    expect(serviceLabel('oto-console-staging')).toBe('Console');
    expect(serviceLabel('oto-app-staging')).toBe('OTO App');
    expect(serviceLabel('radar')).toBe('Radar');
  });
});

describe('parseSubject', () => {
  it('splits a conventional subject', () => {
    expect(parseSubject('feat(api): put the other suite apps on the Integrations page')).toEqual({
      type: 'feat',
      text: 'Put the other suite apps on the Integrations page',
      internal: false,
    });
  });

  it('marks housekeeping as internal', () => {
    expect(parseSubject('docs(progress): CP1 reached').internal).toBe(true);
  });

  it('keeps a subject that follows no convention', () => {
    expect(parseSubject('hotfix the gate').text).toBe('Hotfix the gate');
  });
});

describe('plain', () => {
  it('removes the characters WhatsApp reads as formatting', () => {
    expect(plain('Fixed the *till* total for `null` bands_ ~now~')).toBe(
      'Fixed the till total for null bands now',
    );
  });
});

describe('sectionsFromCommits', () => {
  it('lists visible work and counts the rest', () => {
    const sections = sectionsFromCommits([
      { sha: '1', message: 'feat(pos): choose a station on first sign-in\n\nbody' },
      { sha: '2', message: 'docs(qa): evidence for S2-04' },
      { sha: '3', message: 'fix(api): refuse a box with no branch' },
    ]);
    expect(sections).toEqual([
      {
        title: 'What changed',
        bullets: [
          'Choose a station on first sign-in',
          'Refuse a box with no branch',
          '…and 1 smaller or internal change',
        ],
      },
    ]);
  });

  it('shows internal work when that is all there is', () => {
    expect(
      sectionsFromCommits([{ sha: '1', message: 'docs(plan): who may use a station' }]),
    ).toEqual([{ title: 'What changed', bullets: ['Who may use a station'] }]);
  });
});

describe('digestParts', () => {
  const base: DigestInput = {
    envLabel: 'OTO staging',
    at: new Date('2026-09-20T02:00:00Z'),
    timeZone: 'Asia/Bangkok',
    sections: [
      { title: 'Till and reception', bullets: ['Reception can pick a station when signing in'] },
      { title: 'Admin console', bullets: ['A new Devices page lists every box and its status'] },
    ],
    services: ['oto-pos-staging', 'oto-api-staging', 'oto-api-staging'],
    commitCount: 14,
    rollback: false,
    maxChars: 1500,
    maxParts: 4,
  };

  it('writes a short digest as one message', () => {
    expect(digestParts(base)).toEqual([
      [
        "🚀 *OTO staging — what's new*",
        '_Sun 20 Sept_',
        '',
        '*Till and reception*',
        '• Reception can pick a station when signing in',
        '',
        '*Admin console*',
        '• A new Devices page lists every box and its status',
        '',
        '_Updated: API, POS · 14 changes_',
      ].join('\n'),
    ]);
  });

  const long: DigestInput = {
    ...base,
    maxChars: 400,
    sections: [
      {
        title: 'Till and reception',
        bullets: Array.from(
          { length: 8 },
          (_, n) => `Change number ${n + 1} that reception staff will notice today`,
        ),
      },
      { title: 'Admin console', bullets: ['One more thing for managers'] },
    ],
  };

  it('splits a long digest between bullets and keeps every part within the limit', () => {
    const parts = digestParts(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(400);
    expect(parts[0]).toContain(`part 1 of ${parts.length}`);
    expect(parts[1]).toContain('*Till and reception (cont.)*');
    // The footer closes the digest; it is not repeated on every part.
    expect(parts.filter((p) => p.includes('_Updated:')).length).toBe(1);
    expect(parts.at(-1)).toContain('_Updated: API, POS');
    // Nothing is lost and nothing is cut in half.
    const all = parts.join('\n');
    for (const bullet of long.sections.flatMap((s) => s.bullets))
      expect(all).toContain(`• ${bullet}`);
  });

  it('never leaves a section title stranded at the end of a part', () => {
    for (const part of digestParts(long)) {
      const lines = part.split('\n').filter((l) => l && !l.startsWith('_'));
      expect(lines.at(-1)?.startsWith('*')).toBe(false);
    }
  });

  it('stops at the part limit and says how much was left out', () => {
    const parts = digestParts({ ...long, maxParts: 1 });
    expect(parts.length).toBe(1);
    expect(parts[0]).toMatch(/…and \d+ more changes?/);
    expect(parts[0]!.length).toBeLessThanOrEqual(400);
    expect(parts[0]).not.toContain('part 1 of');
  });

  it('mentions a roll-back', () => {
    expect(digestParts({ ...base, rollback: true })[0]).toContain('roll-back');
  });
});
