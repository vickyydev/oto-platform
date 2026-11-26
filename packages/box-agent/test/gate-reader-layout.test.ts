import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GATE_MESSAGES } from '../src/gate/decision';
import {
  READER_BRAND_LINE,
  READER_REFUSAL_PADDING_LINES,
  readerScreen,
} from '../src/gate/reader-layout';

/**
 * SCRUM-68 — how a reply is laid out on the reader's screen, as measured at
 * the park's gates on 26 November 2026: one fact a line, the brand first, and
 * a refusal arranged so the reader app's own error text falls off the screen.
 */

test('an approval at the entrance: brand, welcome, then one fact a line', () => {
  const out = readerScreen(
    '1',
    `${GATE_MESSAGES.welcome} · Adult · 2 Hours Play · until 17:30 · 1 h 20 min left · Credit ฿350`,
    'entry',
  );
  assert.deepEqual(out.split('\n'), [
    READER_BRAND_LINE,
    '✅ WELCOME',
    'ยินดีต้อนรับ',
    '— — — — —',
    '👤 Adult',
    '🎟 2 Hours Play',
    '⏰ until 17:30',
    '⏳ 1 h 20 min left',
    '💰 Credit ฿350',
  ]);
});

test('an approval at the exit thanks the guest instead of welcoming them', () => {
  const out = readerScreen('1', `${GATE_MESSAGES.goodbye} · Adult · 2 Hours Play · until 17:30 · 40 min left`, 'exit');
  assert.deepEqual(out.split('\n'), [
    READER_BRAND_LINE,
    '👋 THANK YOU',
    'ขอบคุณ',
    'See you again',
    'แล้วพบกันใหม่',
    '— — — — —',
    '👤 Adult',
    '🎟 2 Hours Play',
    '⏰ come back before 17:30',
    '⏳ 40 min left',
  ]);
  assert.ok(!out.includes('WELCOME'));
});

test('an approval with nothing known is the brand and the greeting alone', () => {
  assert.equal(readerScreen('1', GATE_MESSAGES.welcome, 'entry'), `${READER_BRAND_LINE}\n✅ WELCOME\nยินดีต้อนรับ`);
});

test('a refusal starts on a fresh line under ATTENTION and ends in blank lines', () => {
  const out = readerScreen('0', `${GATE_MESSAGES.OVER_TIME} · 2 Hours Play · time ended 17:30`, 'exit');
  const lines = out.split('\n');
  // The reader app writes "java.lang.Exception: " in front: our text begins two lines down.
  assert.deepEqual(lines.slice(0, 8), [
    '',
    '',
    '⚠️ ATTENTION',
    '— — — — —',
    GATE_MESSAGES.OVER_TIME,
    '— — — — —',
    '🎟 2 Hours Play',
    '⏰ ended 17:30',
  ]);
  // …and its stack trace after: the blank lines push it below the screen.
  assert.ok(out.endsWith('\n'.repeat(READER_REFUSAL_PADDING_LINES)));
  assert.equal(lines.slice(8).join(''), '');
});

test('a refusal in two languages puts each on its own line', () => {
  const lines = readerScreen('0', GATE_MESSAGES.ANTI_PASSBACK, 'entry').split('\n');
  assert.deepEqual(lines.slice(2, 6), ['⚠️ ATTENTION', '— — — — —', 'Already entered', 'สายรัดนี้เข้าแล้ว']);
});

test('a refusal never carries the approval’s brand line or a welcome', () => {
  for (const reason of ['KID_BAND', 'BAND_INVALID', 'GATE_NOT_READY', 'NOT_A_BAND'] as const) {
    const out = readerScreen('0', GATE_MESSAGES[reason], 'entry');
    assert.ok(!out.includes(READER_BRAND_LINE), reason);
    assert.ok(!out.includes('WELCOME'), reason);
  }
});
