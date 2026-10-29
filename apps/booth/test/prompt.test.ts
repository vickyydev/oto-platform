import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COPY, promptFor, type PromptPhase } from '../src/copy.ts';

/**
 * SCRUM-694 — the pill under the wheel never asks anybody to sign in.
 *
 * Nobody signs in at a booth: the slip names today's roster from the Console,
 * or says "unattributed". So the pill is the press's progress, a refusal's
 * line while one is up, or the invitation to press — and nothing else.
 */

const PHASES: PromptPhase[] = ['boot', 'unpaired', 'unsynced', 'ready', 'starting', 'spinning', 'result'];

test('no phase asks anybody to sign in', () => {
  for (const phase of PHASES) {
    const line = promptFor(phase, null);
    assert.doesNotMatch(line.en, /sign|log ?in|\bPIN\b/i, `${phase}: ${line.en}`);
  }
});

test('the idle line invites a press, and the press shows its progress', () => {
  assert.deepEqual(promptFor('ready', null), COPY.pressToSpin);
  assert.deepEqual(promptFor('boot', null), COPY.starting);
  assert.deepEqual(promptFor('starting', null), COPY.starting);
  assert.deepEqual(promptFor('spinning', null), COPY.spinning);
});

test('a refusal’s line wins while it is up', () => {
  const notice = { en: 'That’s all the spins for today', th: '—' };
  assert.deepEqual(promptFor('ready', notice), notice);
});
