// The chat-history tool's parser, de-identification, zip reader and picker
// (SCRUM-220), and the load step against a stub platform on localhost — never
// staging. Plain Node: `node --test scripts/inbox/whatsapp-history.test.mjs`.
// FICTIONAL TEST DATA throughout: every name, number and address is made up.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  AI_INTENTS,
  chunkKey,
  cmdLoad,
  sourceKey,
  stableIds,
  deidentify,
  guessBusiness,
  guessLanguage,
  parseArgs,
  parseChat,
  pickBest,
  screen,
  toPairs,
  txtFromZip,
  uuidv7,
} from './whatsapp-history.mjs';

const ANDROID = [
  '27/10/2026, 09:58 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
  '27/10/2026, 10:01 - Anna Petrova: Hello!',
  'Do you need socks to play?',
  '27/10/2026, 10:01 - Anna Petrova: <Media omitted>',
  '27/10/2026, 10:02 - Anna Petrova: Thanks, Anna',
  '27/10/2026, 10:05 - OTO Play Park: Hi! Yes, grip socks are required 😊',
  'You can buy them at the counter.',
  '27/10/2026, 10:06 - OTO Play Park: This message was deleted',
  '28/10/26, 2:15\u202fpm - Anna Petrova: my number is 081-234-5678, email anna.p@example.com <This message was edited>',
  '28/10/26, 2:20 pm - OTO Play Park: Thank you, our team will call you back.',
].join('\n');

const IPHONE = [
  '\u200e[27/10/2026, 11:00:01] \u0418\u0432\u0430\u043d: \u200eMessages and calls are end-to-end encrypted.',
  '[27/10/2026, 11:00:05] Иван: Здравствуйте, можно с собакой?',
  '\u200e[27/10/2026, 11:00:09] Иван: \u200eimage omitted',
  '[27/10/2026, 11:02:30] OTO Play Park: Здравствуйте! К сожалению, нет.',
  '[27/10/26, 3:04:05 PM] สมชาย ใจดี: ราคาเท่าไหร่คะ สมชาย',
  'line: @somchai_99',
  '[27/10/26, 3:05:00 PM] OTO Play Park: สวัสดีค่ะ ดูราคาได้ที่ https://pay.example.com/x?ref=991 ค่ะ',
].join('\r\n');

describe('parseChat', () => {
  it('reads the Android format: multi-line messages, 12-hour times, media and system lines dropped', () => {
    const chat = parseChat(ANDROID);
    assert.deepEqual(
      chat.map((m) => [m.name, m.text]),
      [
        ['Anna Petrova', 'Hello!\nDo you need socks to play?'],
        ['Anna Petrova', 'Thanks, Anna'],
        ['OTO Play Park', 'Hi! Yes, grip socks are required 😊\nYou can buy them at the counter.'],
        ['Anna Petrova', 'my number is 081-234-5678, email anna.p@example.com'],
        ['OTO Play Park', 'Thank you, our team will call you back.'],
      ],
    );
  });

  it('reads the iPhone format: brackets, seconds, AM/PM; the encryption notice and "image omitted" (both behind an invisible mark) dropped', () => {
    const chat = parseChat(IPHONE);
    assert.deepEqual(
      chat.map((m) => m.name),
      ['Иван', 'OTO Play Park', 'สมชาย ใจดี', 'OTO Play Park'],
    );
    assert.equal(chat[0].text, 'Здравствуйте, можно с собакой?');
    assert.equal(chat[2].text, 'ราคาเท่าไหร่คะ สมชาย\nline: @somchai_99');
    assert.ok(!chat.some((m) => /omitted|encrypted/.test(m.text)));
  });
});

describe('guessBusiness', () => {
  it('is the participant in the most chats, then with the most messages', () => {
    assert.equal(guessBusiness([parseChat(ANDROID), parseChat(IPHONE)]), 'OTO Play Park');
  });
});

describe('toPairs and deidentify', () => {
  it('pairs a customer turn with the business turn after it, with personal data replaced', () => {
    const { pairs, dropped } = toPairs(parseChat(ANDROID), 'OTO Play Park');
    assert.equal(dropped, 0);
    assert.equal(pairs.length, 2);
    assert.deepEqual(pairs[0], {
      language: 'en',
      customer: 'Hello!\nDo you need socks to play?\nThanks, [name]',
      reply: 'Hi! Yes, grip socks are required 😊\nYou can buy them at the counter.',
    });
    assert.equal(pairs[1].customer, 'my number is [phone], email [email]');
    const all = JSON.stringify(pairs);
    for (const leak of ['Anna', 'Petrova', '081', 'example.com']) assert.ok(!all.includes(leak), leak);
  });

  it('takes Thai and Cyrillic names, handles and query links out too, and guesses the language', () => {
    const { pairs } = toPairs(parseChat(IPHONE), 'OTO Play Park');
    assert.deepEqual(
      pairs.map((p) => p.language),
      ['ru', 'th'],
    );
    assert.equal(pairs[0].customer, 'Здравствуйте, можно с собакой?');
    assert.equal(pairs[1].customer, 'ราคาเท่าไหร่คะ [name]\nline: [handle]');
    assert.equal(pairs[1].reply, 'สวัสดีค่ะ ดูราคาได้ที่ [link] ค่ะ');
  });

  it('drops a pair that still holds a long run of digits after the replacements', () => {
    const chat = parseChat(
      ['01/02/2026, 10:00 - Ben: card 4111/1111/1111/1111 ok?', '01/02/2026, 10:01 - OTO Play Park: Please pay at the counter.'].join('\n'),
    );
    assert.deepEqual(toPairs(chat, 'OTO Play Park'), { pairs: [], dropped: 1 });
  });

  it('names: introductions, sign-offs and dash signatures; ordinary capitalised words stay', () => {
    assert.equal(deidentify('Hi, my name is Clara Jones and I have two kids'), 'Hi, my name is [name] and I have two kids');
    assert.equal(deidentify('This is Ploy from the park'), 'This is [name] from the park');
    assert.equal(deidentify('See you soon\n- Marco'), 'See you soon\n- [name]');
    assert.equal(deidentify('Thank you so much'), 'Thank you so much');
    assert.equal(deidentify('Thanks a lot'), 'Thanks a lot');
    assert.equal(deidentify('Is it open on Sunday?'), 'Is it open on Sunday?');
    assert.equal(deidentify('ask for Dana at reception', ['Dana K']), 'ask for [name] at reception');
    assert.equal(deidentify('add us @otoplaypark'), 'add us [handle]');
    assert.equal(deidentify('โทร ๐๘๑ ๒๓๔ ๕๖๗๘ ค่ะ'), 'โทร [phone] ค่ะ');
  });

  it('keeps what an answer is made of: prices, opening times, a plain web address', () => {
    for (const text of ['Kids 350 baht, adults 150 baht.', 'Open 10.00-20.00 every day', 'Weekdays 09.00-18.00', 'See https://www.otopark.example/prices']) {
      assert.equal(deidentify(text), text);
    }
  });
});

describe('screen (the platform’s personal-data screen, said again)', () => {
  it('refuses what apps/api/test/inbox-ai-examples-import.test.ts refuses', () => {
    for (const text of [
      'call me on 081-234-5678',
      'my number 0812345678',
      'whatsapp +66 81 234 5678 please',
      '+44 7700 900123',
      'โทร 089 123 4567 ค่ะ',
      'office (02) 123 4567',
      // Thai digits: 081 234 5678.
      'เบอร์ ๐๘๑ ๒๓๔ ๕๖๗๘',
      'booking ref 12345678',
    ]) {
      assert.equal(screen(text), 'a phone number or another long number', text);
    }
    assert.equal(screen('mail me at somebody@example.com'), 'an e-mail address');
    assert.equal(screen('pay here https://pay.example.com/checkout?order=991'), 'a web address with a query string');
    assert.equal(screen('add me line: @somebody'), 'a messaging handle');
    assert.equal(screen('LINE ID: somebody_1'), 'a messaging handle');
    assert.equal(screen('ig: @some.body'), 'a messaging handle');
  });

  it('lets through what it lets through', () => {
    for (const text of [
      'Kids 350 baht, adults 150 baht on weekdays.',
      'Prices: 350 450 550 baht',
      'We are open 10:00-20:00 every day.',
      'เปิด 10.00-20.00 น. ทุกวันค่ะ',
      'Weekdays 09.00-18.00',
      'Closed on 25/12/2026.',
      'See https://www.otopark.example/prices for today’s prices.',
      'สวัสดีค่ะ ราคา 350 บาทค่ะ 😊',
      'Здравствуйте! Носки обязательны.',
      null,
      '',
    ]) {
      assert.equal(screen(text), null, String(text));
    }
  });
});

describe('guessLanguage', () => {
  it('Thai letters → th, Cyrillic → ru, anything else → en', () => {
    assert.equal(guessLanguage('สวัสดีค่ะ'), 'th');
    assert.equal(guessLanguage('Привет'), 'ru');
    assert.equal(guessLanguage('Hello 😊'), 'en');
  });
});

/** A minimal zip writer for the test: one deflated and one stored entry. */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, deflate } of entries) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe('txtFromZip', () => {
  it('reads the chat out of an export zip, deflated or stored, and skips the media', () => {
    const zip = zipOf([
      { name: '_chat.txt', text: IPHONE, deflate: true },
      { name: 'IMG-0001.jpg', text: 'not a chat', deflate: false },
      { name: 'other.txt', text: 'plain', deflate: false },
    ]);
    assert.deepEqual(txtFromZip(zip), [IPHONE, 'plain']);
    assert.throws(() => txtFromZip(Buffer.from('not a zip at all, just bytes')), /not a zip/);
  });
});

describe('pickBest', () => {
  const r = (intent, language, quality, over = {}) => ({
    keep: true,
    intent,
    language,
    quality,
    verdict: 'should_answer',
    customerText: `${intent} ${language} ${quality}`,
    goodReply: 'A reply.',
    ...over,
  });

  it('spreads across intent × language: at most two each, every group’s best before any second', () => {
    const rated = [
      r('socks', 'en', 5),
      r('socks', 'en', 4),
      r('socks', 'en', 4),
      r('hours', 'th', 3),
      r('hours', 'th', 5),
      r('greeting', 'ru', 4),
    ];
    const four = pickBest(rated, 4);
    assert.deepEqual(
      four.map((x) => [x.intent, x.language, x.quality]),
      [
        ['socks', 'en', 5],
        ['hours', 'th', 5],
        ['greeting', 'ru', 4],
        ['socks', 'en', 4],
      ],
    );
    assert.equal(pickBest(rated, 30).length, 5);
  });

  it('leaves out what the import would refuse or should not teach', () => {
    const rated = [
      r('socks', 'en', 2),
      r('weather', 'en', 5),
      r('socks', 'en', 5, { keep: false }),
      r('hours', 'en', 5, { goodReply: null }),
      r('hours', 'en', 5, { customerText: 'call 0812345678' }),
      r('birthday_party', 'en', 4, { verdict: 'should_handover', goodReply: null }),
    ];
    assert.deepEqual(
      pickBest(rated, 30).map((x) => x.intent),
      ['birthday_party'],
    );
    assert.ok(AI_INTENTS.includes('birthday_party') && !AI_INTENTS.includes('weather'));
  });
});

describe('ids and keys', () => {
  it('mints UUIDv7 ids, and the same chunk always travels under the same key', () => {
    const id = uuidv7();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const chunk = [{ id }, { id: uuidv7() }];
    assert.equal(chunkKey(chunk), chunkKey([...chunk]));
    assert.notEqual(chunkKey(chunk), chunkKey([chunk[0]]));
    assert.ok(chunkKey(chunk).length <= 200);
  });

  it('a second select keeps the id of an example made from the same pair, so a second load replays it', () => {
    const pair = { customer: 'Do I need socks?', reply: 'Yes.' };
    const before = [{ id: uuidv7(), source: sourceKey(pair) }];
    const idOf = stableIds(before);
    assert.equal(idOf(sourceKey({ ...pair })), before[0].id);
    assert.notEqual(idOf(sourceKey({ customer: 'Parking?', reply: 'Yes.' })), before[0].id);
  });

  it('a short Thai name part that is also a word is left alone; the whole name still goes', () => {
    assert.equal(deidentify('ใจดีมากค่ะ ขอบคุณค่ะ สมชาย ดี', ['สมชาย ดี']), 'ใจดีมากค่ะ ขอบคุณค่ะ [name]');
  });

  it('reads the command line', () => {
    assert.deepEqual(parseArgs(['load', '--api', 'https://x.example', '--dry-run']), {
      command: 'load',
      opts: { api: 'https://x.example', 'dry-run': true },
      positional: [],
    });
    assert.deepEqual(parseArgs(['parse', 'some/dir', '--business', 'OTO Play Park']).opts, { business: 'OTO Play Park' });
  });
});

/**
 * A stand-in for the platform on localhost: the sign-in sets a cookie, and
 * the import answers as the route does. It records what it was sent.
 */
async function stubPlatform(answerImport) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/auth/sign-in') {
        const ok = body?.phone === '+66800000099' && body?.password === 'stub-password';
        res.statusCode = ok ? 200 : 401;
        if (ok) res.setHeader('set-cookie', 'oto_session=stub-token; HttpOnly; Path=/; SameSite=Lax');
        res.end(JSON.stringify(ok ? { ok: true } : { error: { code: 'INVALID_CREDENTIALS', message: 'No' } }));
        return;
      }
      if (req.url === '/api/inbox/ai/examples/import' && req.headers.cookie === 'oto_session=stub-token') {
        const [status, answer] = answerImport(body);
        res.statusCode = status;
        res.end(JSON.stringify(answer));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((done) => server.close(done)) };
}

describe('load (against a stub platform on localhost)', () => {
  const example = (n, over = {}) => ({
    id: uuidv7(),
    intent: 'socks',
    language: 'en',
    verdict: 'should_answer',
    customerText: `Do I need socks? (${n})`,
    goodReply: 'Yes, grip socks are required.',
    quality: 5,
    ...over,
  });

  async function withSelected(examples, run) {
    const dir = mkdtempSync(join(tmpdir(), 'wa-history-'));
    writeFileSync(join(dir, 'selected.json'), JSON.stringify({ examples }));
    const env = { phone: process.env.STAGING_STUB_PHONE, password: process.env.STAGING_STUB_PASSWORD };
    process.env.STAGING_STUB_PHONE = '+66800000099';
    process.env.STAGING_STUB_PASSWORD = 'stub-password';
    const log = console.log;
    const printed = [];
    console.log = (...a) => printed.push(a.join(' '));
    try {
      return await run(dir, printed);
    } finally {
      console.log = log;
      process.env.STAGING_STUB_PHONE = env.phone ?? '';
      process.env.STAGING_STUB_PASSWORD = env.password ?? '';
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('signs in, sends at most 50 per request under a stable key with the API fields only, and says what to do next', async () => {
    const platform = await stubPlatform((body) => [200, { created: body.examples.length, replayed: 0, examples: [] }]);
    try {
      const examples = Array.from({ length: 60 }, (_, n) => example(n));
      await withSelected(examples, async (dir, printed) => {
        await cmdLoad(dir, { api: platform.origin, as: 'stub' });
        const imports = platform.seen.filter((r) => r.url === '/api/inbox/ai/examples/import');
        assert.deepEqual(
          imports.map((r) => r.body.examples.length),
          [50, 10],
        );
        assert.deepEqual(Object.keys(imports[0].body.examples[0]).sort(), ['customerText', 'goodReply', 'id', 'intent', 'language', 'verdict']);
        assert.equal(imports[0].headers['idempotency-key'], chunkKey(examples.slice(0, 50)));
        assert.deepEqual(
          imports.flatMap((r) => r.body.examples.map((x) => x.id)),
          examples.map((x) => x.id),
        );
        assert.match(printed.join('\n'), /60 created as PROPOSED, 0 were already there/);
        assert.match(printed.join('\n'), /Settings → Assistant → Examples/);
        assert.ok(!printed.join('\n').includes('+66800000099') && !printed.join('\n').includes('stub-password'));
      });
    } finally {
      await platform.close();
    }
  });

  it('stops on a refusal and names the code; refuses to send what still looks like personal data', async () => {
    const platform = await stubPlatform(() => [
      400,
      { error: { code: 'PERSONAL_DATA_FOUND', message: 'Example 1: the customer text still looks like it holds a phone number.', details: { index: 0 } } },
    ]);
    try {
      await withSelected([example(1)], async (dir) => {
        await assert.rejects(cmdLoad(dir, { api: platform.origin, as: 'stub' }), /PERSONAL_DATA_FOUND/);
      });
      const sent = platform.seen.length;
      await withSelected([example(2, { customerText: 'call me 0812345678' })], async (dir) => {
        await assert.rejects(cmdLoad(dir, { api: platform.origin, as: 'stub' }), /personal data at example\(s\) 1/);
      });
      assert.equal(platform.seen.length, sent, 'nothing was sent for the flagged file');
    } finally {
      await platform.close();
    }
  });
});
