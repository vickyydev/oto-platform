import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-911 — A BOARD EDIT OF A BOOKING CANCELLED MEANWHILE.
 *
 * Another till cancels a waiting booking while this board still shows the
 * child's card. Saving an edit on that card is refused by the platform in
 * the counter's words (CHECKIN_NOT_REGISTERED, "…'s drop-off booking was
 * cancelled — register them again if they are staying.") instead of a 500.
 * The board shows the refusal and reads itself afresh, so the stale card
 * goes: the counter's board and the phone's each refresh after the save,
 * whether it was recorded or refused.
 */
const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

/** The body of `handleSaveEdit`, up to the next handler. */
function saveEditOf(source: string): string {
  const start = source.indexOf('const handleSaveEdit = async');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  };', start);
  return source.slice(start, end);
}

describe('SCRUM-911 — the board reads afresh when an edit is refused', () => {
  for (const file of ['pages/DropOff.tsx', 'components/mobile/dropoff/MobileDropOffBoard.tsx']) {
    it(`${file}: the refusal is shown in the platform's words, then the board refreshes`, () => {
      const body = saveEditOf(src(file));
      expect(body).toMatch(/catch \(err\) \{[\s\S]*title: 'Could not save',[\s\S]*description: messageOf\(err\)[\s\S]*\}\s*refresh\(\);\s*$/);
    });
  }
});
