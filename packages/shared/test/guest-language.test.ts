import { describe, expect, it } from 'vitest';
import {
  GATE_MESSAGE_CASES,
  GATE_MESSAGE_CASE_INFO,
  GATE_MESSAGE_LANGS,
  GATE_READER_RULE,
  composeGateScreen,
  composeGuestGateScreen,
  defaultGateMessages,
  type GateScreenFacts,
} from '../src/gate-messages';
import {
  GUEST_LANGUAGES,
  GuestLanguageSchema,
  isGuestLanguage,
  readGuestLanguage,
} from '../src/guest-language';
import { SUPPORTED_LANGS } from '../src/i18n/index';

/**
 * SCRUM-1077 — the language the guest chose at the till, and the gate screen
 * for a band that carries one: that language only, one English line under a
 * refusal, no Thai added, the park's wording first, and null (the park's own
 * list) when that language has no text for the case.
 */

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

/** The screen without the refusal's padding, as lines. */
const shown = (screen: string | null) => (screen ?? '').replace(/\n+$/, '').split('\n');

describe('the guest language', () => {
  it('is one of the customer display’s five, in its order', () => {
    expect(GUEST_LANGUAGES).toEqual(['en', 'zh', 'th', 'ru', 'fr']);
    expect(GUEST_LANGUAGES).toBe(SUPPORTED_LANGS);
    expect(GuestLanguageSchema.options).toEqual([...SUPPORTED_LANGS]);
    expect(GATE_MESSAGE_LANGS).toBe(GUEST_LANGUAGES);
  });

  it('reads anything else as none', () => {
    for (const lang of GUEST_LANGUAGES) {
      expect(isGuestLanguage(lang)).toBe(true);
      expect(readGuestLanguage(lang)).toBe(lang);
    }
    for (const other of ['de', 'EN', '', ' en', null, undefined, 3, {}]) {
      expect(isGuestLanguage(other)).toBe(false);
      expect(readGuestLanguage(other)).toBeNull();
    }
    expect(GuestLanguageSchema.safeParse('de').success).toBe(false);
  });
});

describe('composeGuestGateScreen', () => {
  it('greets in the chosen language alone, with its small words', () => {
    expect(composeGuestGateScreen(null, 'welcome', 'ru', facts())).toBe(
      [
        'OTO PLAY PARK',
        '✅ ДОБРО ПОЖАЛОВАТЬ',
        GATE_READER_RULE,
        '👤 Взрослый',
        '🎟 2 Hours Play',
        '⏰ до 17:30',
        '⏳ осталось 1 h 20 min',
        '💰 Баланс ฿350',
      ].join('\n'),
    );
    const goodbye = shown(composeGuestGateScreen(null, 'goodbye', 'zh', facts()));
    expect(goodbye.slice(0, 3)).toEqual(['OTO PLAY PARK', '👋 谢谢', '欢迎再来']);
    expect(goodbye).toContain('⏰ 请在 17:30 前返回');
    // No English, no Thai on an approval in another language.
    expect(goodbye.join('\n')).not.toMatch(/Thank you|ขอบคุณ/);
  });

  it('adds one English line under a refusal, so staff can read why; no Thai line', () => {
    const kid = shown(composeGuestGateScreen(null, 'KID_BAND', 'ru', facts({ kind: 'kid', creditSatang: undefined })));
    expect(kid.slice(0, 6)).toEqual([
      '',
      '',
      '⚠️ ВНИМАНИЕ',
      GATE_READER_RULE,
      'Нужен взрослый браслет. Дети проходят со взрослым',
      'Adult band please. Kids enter with their adult',
    ]);
    expect(kid.slice(6)).toEqual([GATE_READER_RULE, '🎟 2 Hours Play', '⏰ до 17:30', '⏳ осталось 1 h 20 min']);
    expect(kid.join('\n')).not.toMatch(/[฀-๿]/);
    // Still padded for the reader app's stack trace.
    const raw = composeGuestGateScreen(null, 'KID_BAND', 'ru', facts({ kind: 'kid' }))!;
    expect(raw.endsWith('\n'.repeat(14))).toBe(true);

    const fr = shown(composeGuestGateScreen(null, 'ANTI_PASSBACK', 'fr'));
    expect(fr.slice(2)).toEqual(['⚠️ ATTENTION', GATE_READER_RULE, 'Déjà entré', 'Already entered']);
  });

  it('adds no line for a guest who chose English, and a Thai guest sees Thai only on an approval', () => {
    const english = defaultGateMessages();
    english.languages = ['en'];
    for (const key of GATE_MESSAGE_CASES) {
      expect(composeGuestGateScreen(null, key, 'en', facts()), key).toBe(composeGateScreen(english, key, facts()));
    }
    const thai = shown(composeGuestGateScreen(null, 'welcome', 'th', facts()));
    expect(thai.slice(0, 2)).toEqual(['OTO PLAY PARK', '✅ ยินดีต้อนรับ']);
    expect(thai).toContain('👤 ผู้ใหญ่');
    expect(thai.join('\n')).not.toMatch(/Welcome/);
    const thaiRefusal = shown(composeGuestGateScreen(null, 'GATE_BUSY', 'th'));
    expect(thaiRefusal.slice(4)).toEqual(['กรุณารอสักครู่', 'Please wait']);
  });

  it('uses the park’s wording for the language, then the built-in one, and null with neither', () => {
    const park = defaultGateMessages();
    park.cases.welcome.ru = 'Добро пожаловать в парк';
    park.cases.ANTI_PASSBACK.ru = '';
    park.cases.ANTI_PASSBACK.en = 'Already inside\nsee staff';
    park.labels.adult.ru = '';
    park.labels.credit.ru = 'Деньги {amount}';
    const welcome = shown(composeGuestGateScreen(park, 'welcome', 'ru', facts()));
    expect(welcome[1]).toBe('✅ ДОБРО ПОЖАЛОВАТЬ В ПАРК');
    // An empty label takes the built-in Russian, not the English.
    expect(welcome).toContain('👤 Взрослый');
    expect(welcome).toContain('💰 Деньги ฿350');
    // An empty text takes the built-in Russian; the park's English is the staff line, on one line.
    expect(shown(composeGuestGateScreen(park, 'ANTI_PASSBACK', 'ru')).slice(4)).toEqual([
      'Уже вошли',
      'Already inside see staff',
    ]);
    // An empty English takes the built-in English for staff.
    park.cases.GATE_BUSY.en = '';
    expect(shown(composeGuestGateScreen(park, 'GATE_BUSY', 'ru')).slice(4)).toEqual([
      'Пожалуйста, подождите',
      'Please wait',
    ]);
    // No Thai at all for OVER_TIME, park or built-in: the caller falls back.
    expect(composeGuestGateScreen(null, 'OVER_TIME', 'th', facts())).toBeNull();
    expect(composeGuestGateScreen(park, 'OVER_TIME', 'th', facts())).toBeNull();
    park.cases.OVER_TIME.th = 'หมดเวลาเล่นแล้ว';
    expect(shown(composeGuestGateScreen(park, 'OVER_TIME', 'th', facts())).slice(4, 6)).toEqual([
      'หมดเวลาเล่นแล้ว',
      'Your play time has ended. Please see the cashier.',
    ]);
  });

  it('is never empty and never changes whether the gate opens', () => {
    for (const key of GATE_MESSAGE_CASES) {
      for (const lang of GUEST_LANGUAGES) {
        const screen = composeGuestGateScreen(null, key, lang, facts());
        if (screen === null) {
          expect([key, lang]).toEqual(['OVER_TIME', 'th']);
          continue;
        }
        expect(screen.trim().length).toBeGreaterThan(0);
        // An approval opens on the brand line; a refusal on the heading.
        expect(screen.startsWith('OTO PLAY PARK\n')).toBe(GATE_MESSAGE_CASE_INFO[key].opens);
      }
    }
  });
});
