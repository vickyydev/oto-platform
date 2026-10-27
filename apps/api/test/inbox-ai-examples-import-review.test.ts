import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INBOX_AI_EXAMPLE_IMPORT_MAX, InboxAiExampleImportSchema } from '@oto/shared';
import { personalDataIn } from '../src/services/inbox/personal-data';

/**
 * SCRUM-220 house review of `POST /inbox/ai/examples/import` and its screen.
 * Pure: no database, no model. Pins are what the review settled; an
 * `it.fails` FINDING states its severity and why it stands.
 */

const SERVICE = readFileSync(new URL('../src/services/inbox/ai-settings.ts', import.meta.url), 'utf8');
const importBody = SERVICE.slice(SERVICE.indexOf('export async function importExamples'), SERVICE.indexOf('// --- The controls'));
const item = { customerText: 'Do I need socks?', goodReply: 'Yes.', verdict: 'should_answer', intent: 'socks', language: 'en' };

describe('review pins', () => {
  it('PIN (review fix, MEDIUM): a number written in Thai digits is screened like any other', () => {
    expect(personalDataIn('เบอร์ ๐๘๑ ๒๓๔ ๕๖๗๘')).toBe('a phone number or another long number');
    expect(personalDataIn('ราคา ๓๕๐ บาท')).toBeNull();
  });

  it('PIN: an import can only ever write a PROPOSED example with no source and no approval', () => {
    expect(importBody).toContain("status: 'proposed'");
    expect(importBody).toContain('sourceMessageId: null');
    expect(importBody).toContain('sourceConversationId: null');
    expect(importBody).toContain('deidentifiedConfirmed: false');
    expect(importBody).not.toMatch(/approvedAt|approvedByAccountId|'approved'/);
  });

  it('PIN: every check runs before the first write, so a refusal saves nothing of the import', () => {
    const firstWrite = importBody.indexOf('.insert(aiExample)');
    for (const check of ['PERSONAL_DATA_FOUND', 'INTENT_UNKNOWN', 'GOOD_REPLY_REQUIRED', 'carry the same id']) {
      expect(importBody.indexOf(check), check).toBeGreaterThan(0);
      expect(importBody.indexOf(check), check).toBeLessThan(firstWrite);
    }
  });

  it('PIN: a refusal names the kind of data, never the words it found', () => {
    const kinds = new Set(
      ['call 0812345678', 'a@b.example.com', 'https://x.example/p?id=1', 'line: @abc'].map((t) => personalDataIn(t)),
    );
    expect([...kinds].sort()).toEqual(
      ['a messaging handle', 'a phone number or another long number', 'a web address with a query string', 'an e-mail address'].sort(),
    );
  });

  it('PIN: the body holds 1 to 50 examples, each with an intent and a content language', () => {
    expect(InboxAiExampleImportSchema.safeParse({ examples: [item] }).success).toBe(true);
    expect(InboxAiExampleImportSchema.safeParse({ examples: [] }).success).toBe(false);
    expect(InboxAiExampleImportSchema.safeParse({ examples: Array(INBOX_AI_EXAMPLE_IMPORT_MAX + 1).fill(item) }).success).toBe(false);
    expect(InboxAiExampleImportSchema.safeParse({ examples: [{ ...item, intent: undefined }] }).success).toBe(false);
    expect(InboxAiExampleImportSchema.safeParse({ examples: [{ ...item, language: 'de' }] }).success).toBe(false);
  });
});

describe('review findings', () => {
  /**
   * FINDING (LOW, stands by design): a name or a child's detail written in
   * plain words passes the pattern screen. No pattern can know a name; the
   * history tool takes out the names it can see (display names, sign-offs,
   * introductions), and the example still lands only PROPOSED: a person must
   * tick "contains no personal data" before approving it — the rule of
   * `docs/progress/plans/inbox-ai-build/PLAN.md` §D.5 / §E, held by the
   * database's `ai_example_approved_check`. Prescribed fix: none.
   */
  it.fails('FINDING: "my son Tom is 4" is refused by the screen', () => {
    expect(personalDataIn('Can my son Tom (4) come with his nanny?')).not.toBeNull();
  });
});
