import { describe, expect, it } from 'vitest';
import {
  GATE_MESSAGE_CASES,
  GATE_MESSAGE_CASE_INFO,
  GATE_MESSAGE_DEFAULT_CASES,
  GATE_MESSAGE_LABELS,
  GATE_MESSAGE_LANGS,
  GATE_READER_SCREEN,
  cleanGateText,
  composeGateScreen,
  defaultGateMessages,
  fillGateLabel,
  gateMessageLines,
  previewGateScreen,
  readGateMessagesWire,
  type GateScreenFacts,
} from '../src/gate-messages';

/** SCRUM-1078 — the gate's wording, its layout on the reader, and the wire a box reads. */

const NOW = Date.parse('2026-11-26T09:10:00Z'); // 16:10 in Bangkok
const facts = (over: Partial<GateScreenFacts> = {}): GateScreenFacts => ({
  kind: 'adult',
  ticketLabel: '2 Hours Play',
  validUntil: Date.parse('2026-11-26T10:30:00Z'), // 17:30 in Bangkok
  creditSatang: 35_000,
  now: NOW,
  timezone: 'Asia/Bangkok',
  ...over,
});

describe('the built-in wording', () => {
  it('has every case and label in every language, and English everywhere', () => {
    const texts = defaultGateMessages();
    expect(texts.languages).toEqual(['en', 'th']);
    for (const key of GATE_MESSAGE_CASES) {
      expect(Object.keys(texts.cases[key]).sort()).toEqual([...GATE_MESSAGE_LANGS].sort());
      expect(texts.cases[key].en.length).toBeGreaterThan(0);
      expect(GATE_MESSAGE_CASE_INFO[key].when.length).toBeGreaterThan(10);
    }
    for (const key of GATE_MESSAGE_LABELS) expect(texts.labels[key].en.length).toBeGreaterThan(0);
    // OVER_TIME had no Thai before; the gate shows the other languages.
    expect(texts.cases.OVER_TIME.th).toBe('');
  });

  it('is a fresh copy every time', () => {
    const one = defaultGateMessages();
    one.cases.welcome.en = 'changed';
    expect(defaultGateMessages().cases.welcome.en).toBe('Welcome');
    expect(GATE_MESSAGE_DEFAULT_CASES.welcome.en).toBe('Welcome');
  });
});

describe('composeGateScreen', () => {
  it('lays an approval out under the brand line, the first line in capitals', () => {
    expect(composeGateScreen(defaultGateMessages(), 'welcome', facts())).toBe(
      [
        'OTO PLAY PARK',
        '✅ WELCOME',
        'ยินดีต้อนรับ',
        '— — — — —',
        '👤 Adult',
        '🎟 2 Hours Play',
        '⏰ until 17:30',
        '⏳ 1 h 20 min left',
        '💰 Credit ฿350',
      ].join('\n'),
    );
  });

  it('pairs the languages line by line, and tells a guest leaving when to be back', () => {
    const screen = composeGateScreen(defaultGateMessages(), 'goodbye', facts());
    expect(screen.split('\n').slice(0, 6)).toEqual([
      'OTO PLAY PARK',
      '👋 THANK YOU',
      'ขอบคุณ',
      'See you again',
      'แล้วพบกันใหม่',
      '— — — — —',
    ]);
    expect(screen).toContain('⏰ come back before 17:30');
  });

  it('lays a refusal out under the heading and pads it with blank lines', () => {
    const screen = composeGateScreen(defaultGateMessages(), 'GATE_BUSY');
    expect(screen).toBe(['', '', '⚠️ ATTENTION', '— — — — —', 'Please wait', 'กรุณารอสักครู่'].join('\n') + '\n'.repeat(14));
    const over = composeGateScreen(defaultGateMessages(), 'OVER_TIME', facts({ validUntil: NOW - 60_000 }));
    expect(over).toContain('Your play time has ended. Please see the cashier.');
    expect(over).toContain('⏰ ended 16:09');
    expect(over).not.toContain('💰');
    expect(over).not.toContain('👤');
  });

  it('shows the languages in the park’s order, skips one with no text, and falls back to English when none has any', () => {
    const texts = defaultGateMessages();
    texts.languages = ['ru', 'en', 'fr'];
    texts.cases.ANTI_PASSBACK.fr = '';
    expect(gateMessageLines(texts, 'ANTI_PASSBACK')).toEqual(['Уже вошли', 'Already entered']);
    texts.languages = ['th'];
    expect(gateMessageLines(texts, 'OVER_TIME')).toEqual(['Your play time has ended. Please see the cashier.']);
  });

  it('takes the labels from the first language shown, and the English for an empty one', () => {
    const texts = defaultGateMessages();
    texts.languages = ['ru', 'en'];
    texts.labels.kid.ru = '';
    const screen = composeGateScreen(texts, 'welcome', facts());
    expect(screen).toContain('👤 Взрослый');
    expect(screen).toContain('⏰ до 17:30');
    expect(screen).toContain('⏳ осталось 1 h 20 min');
    expect(screen).toContain('💰 Баланс ฿350');
    expect(composeGateScreen(texts, 'KID_BAND', facts({ kind: 'kid' }))).toContain('🎟 2 Hours Play');
  });

  it('never loses a fact to a label without its mark', () => {
    expect(fillGateLabel('until', '17:30')).toBe('until 17:30');
    expect(fillGateLabel('{time} left', '45 min')).toBe('45 min left');
    expect(fillGateLabel('ended {time}', null)).toBe('ended');
  });

  it('cannot change whether the gate opens: the layout follows the case, never the text', () => {
    const texts = defaultGateMessages();
    texts.cases.NOT_A_BAND.en = 'Welcome';
    expect(composeGateScreen(texts, 'NOT_A_BAND').startsWith('\n\n⚠️')).toBe(true);
  });
});

describe('previewGateScreen', () => {
  it('counts the shortest refusal at seven reader lines, the app’s own line first', () => {
    const preview = previewGateScreen(composeGateScreen(defaultGateMessages(), 'GATE_BUSY'), 'GATE_BUSY');
    expect(preview.lines[0]).toBe('java.lang.Exception:');
    expect(preview.count).toBe(7);
    expect(preview.tooLong).toBe(false);
  });

  it('warns when a text would run past the screen', () => {
    const texts = defaultGateMessages();
    texts.languages = ['en', 'th', 'ru', 'fr', 'zh'];
    texts.cases.KID_BAND.en = 'Adult band please. Kids enter with their adult and stay with them all day long';
    const preview = previewGateScreen(composeGateScreen(texts, 'KID_BAND', facts()), 'KID_BAND');
    expect(preview.count).toBeGreaterThan(GATE_READER_SCREEN.lines);
    expect(preview.tooLong).toBe(true);
  });
});

describe('cleanGateText', () => {
  it('keeps line breaks, turns a tab into a space, and drops other control characters', () => {
    expect(cleanGateText(' Hello\t there\u0007 \r\nSecond \n\n')).toBe('Hello there\nSecond');
    expect(cleanGateText('one\ntwo', true)).toBe('one two');
  });
});

describe('readGateMessagesWire', () => {
  it('reads nothing from nothing', () => {
    expect(readGateMessagesWire(undefined)).toBeNull();
    expect(readGateMessagesWire({ languages: ['de'] })).toBeNull();
    expect(readGateMessagesWire('text')).toBeNull();
  });

  it('keeps what it knows and the built-in wording for the rest', () => {
    const read = readGateMessagesWire({
      languages: ['fr', 'xx', 'fr', 'en'],
      cases: { welcome: { fr: 'Salut', en: 42 }, FUTURE_CASE: { en: 'later' } },
      labels: { adult: { fr: 'Grand\nadulte' } },
      somethingNew: true,
    });
    expect(read?.languages).toEqual(['fr', 'en']);
    expect(read?.cases.welcome.fr).toBe('Salut');
    expect(read?.cases.welcome.en).toBe('Welcome');
    expect(read?.labels.adult.fr).toBe('Grand adulte');
    expect(read?.cases.GATE_BUSY.en).toBe('Please wait');
  });
});
