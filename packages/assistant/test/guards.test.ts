import { describe, expect, it } from 'vitest';
import { bubbleGuard, PERSONA_GUARD_RULES, personaGuard, statesNumber, traceabilityGuard } from '../src/guards';
import { EN_PERSONA, RU_PERSONA, TH_PERSONA } from '../src/persona';

describe('the traceability guard (PLAN §B.3 gate 5)', () => {
  const trace = (bubble: string, grounding: string[]) => traceabilityGuard([bubble], grounding);

  describe('numbers', () => {
    it.each([
      ['en', 'We open at 10:00 every day.', 'Opening hours: every day 10:00–20:00'],
      ['th', 'เปิด 10:00–20:00 น. ค่ะ', 'Opening hours: every day 10:00–20:00'],
      ['ru', 'Мы открыты с 10:00 до 20:00.', 'Opening hours: every day 10:00–20:00'],
    ])('%s: a number in the grounding passes', (_l, bubble, g) => {
      expect(trace(bubble, [g])).toEqual({ ok: true });
    });
    it.each([
      ['en', 'We open at 9:00.'],
      ['th', 'เปิด 9 โมงค่ะ'],
      ['ru', 'Открываемся в 9 утра.'],
    ])('%s: a number absent from the grounding fails', (_l, bubble) => {
      expect(trace(bubble, ['Opening hours: every day 10:00–20:00'])).toMatchObject({
        ok: false,
        reason: 'GUARD_NUMBER',
      });
    });
    it('statesNumber: whether a text states any number, by the same tokeniser (Thai digits included)', () => {
      expect(statesNumber('Which figure do you mean for yesterday?')).toBe(false);
      expect(statesNumber('หมายถึงตัวเลขไหนคะ')).toBe(false);
      expect(statesNumber('Do you mean the 2026 figure?')).toBe(true);
      expect(statesNumber('เปิด ๙ โมง')).toBe(true);
      expect(statesNumber('')).toBe(false);
    });
    it('reads Thai digits, a 10.00 time and part of a compound grounding token', () => {
      expect(trace('เปิด ๑๐:๐๐ น.', ['10:00–20:00'])).toEqual({ ok: true });
      expect(trace('เปิด 10.00 น.', ['10:00–20:00'])).toEqual({ ok: true });
      expect(trace('From 10 until 8pm', ['10:00–20:00'])).toMatchObject({ ok: false });
      expect(trace('From 10 in the morning', ['10:00–20:00'])).toEqual({ ok: true });
    });
    it('a database time with :00 seconds is the same time (the OTO App rota’s 10:00:00); other seconds are not', () => {
      expect(trace('Anan and Krit, 10:00–19:00.', ['{"start":"10:00:00","end":"19:00:00"}'])).toEqual({ ok: true });
      expect(trace('Clocked in at 10:00:00.', ['in at 10:00'])).toEqual({ ok: true });
      expect(trace('Clocked in at 10:00.', ['in at 10:00:30'])).toMatchObject({ ok: false, reason: 'GUARD_NUMBER' });
    });
    it('ungrounded when no source is cited at all', () => {
      expect(trace('Come at 3!', [])).toMatchObject({ ok: false, reason: 'GUARD_NUMBER' });
    });
  });

  describe('prices', () => {
    const catalog = 'Play pass: child weekday ฿350, child weekend ฿450; each further adult ฿1,150';
    it.each([
      ['en', "It's ฿450 per child at the weekend."],
      ['th', 'วันเสาร์-อาทิตย์ เด็ก 450 บาทค่ะ'],
      ['ru', 'В выходные 450 бат за ребёнка.'],
      ['en', 'Extra adults are 1150 baht.'],
    ])('%s: a catalog price passes', (_l, bubble) => {
      expect(trace(bubble, [catalog])).toEqual({ ok: true });
    });
    it.each([
      ['en', "That's ฿900 for two kids."],
      ['th', 'รวมทั้งหมด 900 บาทค่ะ'],
      ['ru', 'Итого 900 бат.'],
    ])('%s: a total that is not in the catalog fails', (_l, bubble) => {
      expect(trace(bubble, [catalog])).toMatchObject({ ok: false, reason: 'GUARD_NUMBER' });
    });
  });

  describe('dates', () => {
    it.each([
      ['en', 'See you on November the fourteenth!'],
      ['th', 'วันที่สิบสี่ พฤศจิกายน ได้ค่ะ'],
      ['th', 'ได้ค่ะ ต.ค. นี้'],
      ['ru', 'Ждём Вас в ноябре!'],
    ])('%s: a month name absent from the grounding fails', (_l, bubble) => {
      expect(trace(bubble, ['Opening hours: every day 10:00–20:00'])).toMatchObject({
        ok: false,
        reason: 'GUARD_DATE',
      });
    });
    it('a month name in the grounding passes; "you may" is not a date', () => {
      expect(trace('The camp runs in November.', ['Holiday camp: November and April.'])).toEqual({
        ok: true,
      });
      expect(trace('You may bring a stroller.', [])).toEqual({ ok: true });
    });
    it('a numeric date is caught by the number check', () => {
      expect(trace('Booked for 14/11 🎈', [])).toMatchObject({ ok: false, reason: 'GUARD_NUMBER' });
    });
  });

  describe('promise words, each in three languages', () => {
    const cases: Array<[string, string, string]> = [
      ['en:refund', "We'll refund you.", 'refund'],
      ['en:compensation', "We'll offer compensation.", 'compensation'],
      ['en:free', "We'll give you a free entry.", 'free'],
      ['en:discount', 'You get a discount!', 'discount'],
      ['th:refund', 'เราจะคืนเงินให้ค่ะ', 'คืนเงิน'],
      ['th:compensation', 'เราจะชดเชยให้ค่ะ', 'ชดเชย'],
      ['th:free', 'เข้าฟรีค่ะ', 'ฟรี'],
      ['th:discount', 'มีส่วนลดให้ค่ะ', 'ส่วนลด'],
      ['ru:refund', 'Мы оформим возврат.', 'возврат'],
      ['ru:compensation', 'Мы предложим компенсацию.', 'компенсация'],
      ['ru:free', 'Вход бесплатный!', 'бесплатно'],
      ['ru:discount', 'Сделаем скидку!', 'скидка'],
    ];
    it.each(cases)('%s absent from the grounding fails', (rule, bubble) => {
      expect(trace(bubble, ['Opening hours: every day'])).toEqual({
        ok: false,
        reason: 'GUARD_PROMISE',
        rule,
      });
    });
    it.each(cases)('%s present in the grounding passes', (_rule, bubble, word) => {
      expect(trace(bubble, [`Policy: ${word} applies as stated.`])).toEqual({ ok: true });
    });
    it('"free for under-ones" passes when the age-rules entry says so', () => {
      expect(
        trace('Little ones under 1 go free 😊', [
          'Children under 1 enter free with a paying adult.',
        ]),
      ).toEqual({ ok: true });
    });
    it('"feel free" is ordinary English, not a promise', () => {
      expect(trace('Feel free to ask anything 😊', [])).toEqual({ ok: true });
    });
  });
});

describe('the persona guard (PLAN §B.3 gate 6)', () => {
  it.each([
    ['en:ai', "I'm an AI, happy to help"],
    ['en:ai', 'This is A.I. support'],
    ['en:bot', 'Our bot will help'],
    ['en:bot', 'the chatbot here'],
    ['en:robot', 'not a robot'],
    ['en:assistant', "I'm the virtual assistant"],
    ['en:model', 'As a language model I cannot'],
    ['en:automated', 'This is an automated reply'],
    ['en:artificial', 'artificial intelligence answers you'],
    ['en:claude', "I'm Claude"],
    ['en:anthropic', 'made by Anthropic'],
    ['th:ai', 'แอดมินเป็นเอไอค่ะ'],
    ['en:ai', 'AIแอดมินค่ะ'],
    ['th:bot', 'นี่คือบอทของ OTO ค่ะ'],
    ['th:artificial', 'ระบบปัญญาประดิษฐ์ค่ะ'],
    ['th:robot', 'หุ่นยนต์ตอบค่ะ'],
    ['th:auto', 'ข้อความตอบกลับอัตโนมัติค่ะ'],
    ['ru:ai', 'Я ИИ, чем помочь?'],
    ['ru:bot', 'Это бот OTO.'],
    ['ru:bot', 'Вы говорите с ботом.'],
    ['ru:neural', 'Отвечает нейросеть.'],
    ['ru:artificial', 'Это искусственный интеллект.'],
    ['ru:robot', 'Я робот.'],
    ['ru:assistant', 'Ваш ассистент на связи.'],
    ['ru:auto', 'Это автоматический ответ.'],
  ])('%s refuses %j', (rule, bubble) => {
    expect(personaGuard([bubble])).toEqual({ ok: false, reason: 'GUARD_PERSONA', rule });
  });

  it('rule ids are unique', () => {
    expect(PERSONA_GUARD_RULES.map((r) => r.id).sort()).toEqual(
      [...new Set(PERSONA_GUARD_RULES.map((r) => r.id))].sort(),
    );
  });

  it.each([
    'Thai food is served at our cafe',
    'Our team said yes 😊',
    'Мы работаем каждый день.',
    'Работаем без выходных, ждём Вас!',
    'สวัสดีค่ะ แอดมินยินดีให้บริการค่ะ',
    'Main entrance is by the fountain',
  ])('ordinary words pass: %j', (bubble) => {
    expect(personaGuard([bubble])).toEqual({ ok: true });
  });

  it("the persona's own identity and branch lines pass", () => {
    for (const p of [TH_PERSONA, EN_PERSONA, RU_PERSONA]) {
      expect(personaGuard([p.identityLine, p.branchQuestion])).toEqual({ ok: true });
      expect(traceabilityGuard([p.identityLine, p.branchQuestion], [])).toEqual({ ok: true });
    }
  });

  describe('the Thai and Russian assistant and bot words (test night 2026-10-21, W8)', () => {
    it.each([
      ['th:assistant', 'ผู้ช่วย', 'ผู้ช่วยยินดีให้บริการค่ะ'],
      ['th:assistant', 'ระบบผู้ช่วย', 'นี่คือระบบผู้ช่วยตอบอัตโนมัติของ OTO ค่ะ'],
      ['th:bot', 'บอท', 'แอดมินเป็นบอทค่ะ'],
      ['th:chatbot', 'แชทบอท', 'แชทบอทของ OTO ยินดีช่วยค่ะ'],
      ['en:ai', 'AI', 'ระบบ AI ของ OTO ตอบค่ะ'],
      ['th:artificial', 'ปัญญาประดิษฐ์', 'ตอบโดยปัญญาประดิษฐ์ค่ะ'],
      ['ru:bot', 'бот', 'С Вами общается бот OTO.'],
      ['ru:chatbot', 'чат-бот', 'Вам отвечает чат-бот.'],
      ['ru:assistant', 'ассистент', 'Я виртуальный ассистент парка.'],
      ['ru:ai', 'ИИ', 'Отвечает ИИ парка.'],
      ['ru:artificial', 'искусственный интеллект', 'С Вами говорит искусственный интеллект.'],
      ['ru:neural', 'нейросеть', 'Ответ подготовила нейросеть.'],
    ])('%s refuses %s', (rule, _word, bubble) => {
      expect(personaGuard([bubble])).toEqual({ ok: false, reason: 'GUARD_PERSONA', rule });
    });

    it('a Thai knowledge-base line that names the assistant never reaches a customer', () => {
      // Three TH entries carried "ระบบผู้ช่วย…" on the test night; an answer quoting one is refused.
      expect(personaGuard(['ระบบผู้ช่วยของ OTO แจ้งว่าเปิด 10:00–20:00 น. ค่ะ'])).toMatchObject({ ok: false, rule: 'th:assistant' });
    });

    it.each(['แอดมินช่วยดูให้นะคะ', 'ช่วยบอกจำนวนเด็กด้วยนะคะ', 'Мы поможем Вам с выбором.', 'Заботимся о каждом госте.'])(
      'ordinary help words pass: %j',
      (bubble) => {
        expect(personaGuard([bubble])).toEqual({ ok: true });
      },
    );
  });
});

describe('the bubble guard (gate 7)', () => {
  it('bounds count, emptiness, length and shape', () => {
    expect(bubbleGuard(['hi'], 1)).toEqual({ ok: true });
    expect(bubbleGuard([], 0)).toEqual({ ok: true });
    expect(bubbleGuard([' '], 1)).toMatchObject({ ok: false, rule: 'empty' });
    expect(bubbleGuard(['x'.repeat(401)], 1)).toMatchObject({ ok: false, rule: 'bubble_length' });
    expect(bubbleGuard(['# Hours'], 1)).toMatchObject({ ok: false, reason: 'GUARD_SHAPE' });
    expect(bubbleGuard(['1. socks'], 1)).toMatchObject({ ok: false, reason: 'GUARD_SHAPE' });
    expect(bubbleGuard(['**Open** daily'], 1)).toMatchObject({ ok: false, reason: 'GUARD_SHAPE' });
  });
});
