import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { INBOX_AI_EXAMPLE_IMPORT_MAX, newId } from '@oto/shared';
import { loadTurnKnowledge } from '../src/services/inbox/ai-knowledge';
import { personalDataIn } from '../src/services/inbox/personal-data';
import { RECEPTION, signInAs, teardownAll } from './helpers';
import { SENTINEL, aiWorld, call, staff, teamOf, type AiWorld } from './inbox-ai-support';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';

/**
 * SCRUM-220 — SEEDING THE ASSISTANT'S EXAMPLES FROM THE PARK'S OWN CHAT
 * HISTORY (`POST /inbox/ai/examples/import`).
 *
 * The history tool (`scripts/inbox/whatsapp-history.mjs`) de-identifies a
 * WhatsApp export, picks the best pairs and loads them here. What this file
 * holds:
 *
 *   - they land PROPOSED, with no source links, in the existing queue — never
 *     straight into the assistant;
 *   - only the queue's reviewer may load them (inbox:kb:manage, operator reach);
 *   - an item that still looks like personal data is refused by index, and
 *     nothing of the import is saved;
 *   - a resend — the same Idempotency-Key, or the same ids under a new key —
 *     writes nothing new;
 *   - an imported example is approved like any other (no source to sever)
 *     and then reaches the assistant's knowledge;
 *   - audit rows carry counts, ids, enums and lengths — never the words.
 *
 * FICTIONAL TEST DATA throughout.
 */

let w: AiWorld;
let marketingKbId: string;
let marketingKbCookie: string;
let chalongKbCookie: string;
let agentId: string;
let agentCookie: string;
let receptionCookie: string;

const item = (over: Record<string, unknown> = {}) => ({
  id: newId(),
  customerText: 'Do I need socks to play?',
  goodReply: 'Yes, grip socks are required on the play floor. You can buy them at the counter.',
  verdict: 'should_answer',
  intent: 'socks',
  language: 'en',
  ...over,
});

const post = (cookie: string, payload: unknown, key: string = newId()) =>
  w.ctx.app.inject({
    method: 'POST',
    url: '/inbox/ai/examples/import',
    headers: { cookie, 'idempotency-key': key },
    payload: payload as never,
  });

async function examplesCount(): Promise<number> {
  return (await w.ctx.db.select({ id: s.aiExample.id }).from(s.aiExample).where(eq(s.aiExample.operatorId, w.oto))).length;
}

async function auditOf(action: string, entityId: string) {
  return w.ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, action), eq(s.auditLog.entityId, entityId)))
    .orderBy(desc(s.auditLog.createdAt));
}

beforeAll(async () => {
  w = await aiWorld();
  const marketing = await teamOf(w, 'marketing');
  const reception = await teamOf(w, 'reception', w.central);
  const kbRole = newId();
  await w.ctx.db.insert(s.role).values({ id: kbRole, operatorId: w.oto, name: 'kb_import_test', description: 'KB editor' });
  await w.ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: kbRole, permission: 'inbox:kb:manage' });
  [marketingKbId, marketingKbCookie] = await staff(w, '+66810029003', 'Import Test Marketing', 'kb_import_test', {
    scopeType: 'department',
    scopeId: marketing.departmentId!,
  });
  [, chalongKbCookie] = await staff(w, '+66810029004', 'Import Test Chalong Editor', 'kb_import_test', {
    scopeType: 'branch',
    scopeId: w.chalong,
  });
  [agentId, agentCookie] = await staff(w, '+66810029001', 'Import Test Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
  receptionCookie = await signInAs(w.ctx.app, RECEPTION.phone, RECEPTION.password);
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

describe('the personal-data screen (personalDataIn)', () => {
  it('refuses the shapes a phone, an e-mail, a tracking link and a contact handle take', () => {
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
      expect(personalDataIn(text), text).toBe('a phone number or another long number');
    }
    expect(personalDataIn('mail me at somebody@example.com')).toBe('an e-mail address');
    expect(personalDataIn('pay here https://pay.example.com/checkout?order=991')).toBe('a web address with a query string');
    expect(personalDataIn('add me line: @somebody')).toBe('a messaging handle');
    expect(personalDataIn('LINE ID: somebody_1')).toBe('a messaging handle');
    expect(personalDataIn('ig: @some.body')).toBe('a messaging handle');
  });

  it('lets through what a good answer is made of: prices, times, dates, the park’s own site', () => {
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
      expect(personalDataIn(text), String(text)).toBeNull();
    }
  });
});

describe('POST /inbox/ai/examples/import', () => {
  it('lands every example PROPOSED, with no source, in the queue; audited without a word', async () => {
    const examples = [
      item({ customerText: `Do I need socks? ${SENTINEL}` }),
      item({ customerText: 'ต้องใส่ถุงเท้าไหมคะ', goodReply: 'ต้องใส่ถุงเท้ากันลื่นค่ะ 😊', language: 'th' }),
      item({ customerText: 'Можно отметить день рождения?', goodReply: null, verdict: 'should_handover', intent: 'birthday_party', language: 'ru' }),
      item({ customerText: 'ok thanks', goodReply: undefined, verdict: 'should_stay_silent', intent: 'thanks_closing' }),
    ];
    const before = await examplesCount();
    const res = await post(marketingKbCookie, { examples });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-oto-replay']).toBeUndefined();
    const body = res.json() as { created: number; replayed: number; examples: Record<string, unknown>[] };
    expect(body.created).toBe(4);
    expect(body.replayed).toBe(0);
    expect(body.examples.map((x) => x.id)).toEqual(examples.map((x) => x.id));
    for (const x of body.examples) {
      expect(x).toMatchObject({
        status: 'proposed',
        sourceMessageId: null,
        sourceConversationId: null,
        proposedByAccountId: marketingKbId,
        approvedByAccountId: null,
        deidentifiedConfirmed: false,
      });
    }
    expect(body.examples[2]).toMatchObject({ verdict: 'should_handover', goodReply: null, intent: 'birthday_party', language: 'ru' });
    expect(await examplesCount()).toBe(before + 4);

    // The existing queue shows them, as proposals.
    const queue = await call<{ examples: { id: string; status: string }[] }>(w, marketingKbCookie, 'GET', '/inbox/ai/examples?status=proposed');
    expect(queue.status).toBe(200);
    expect(queue.body.examples.map((x) => x.id)).toEqual(expect.arrayContaining(examples.map((x) => x.id)));

    // Nothing reaches the assistant before a person approves it.
    const known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect(JSON.stringify(known.knowledge)).not.toContain(SENTINEL);

    // One create row per example, one import row for the request: enums, lengths, counts, ids.
    for (const x of examples) {
      const [row] = await auditOf('inbox.ai_example.create', x.id);
      expect(row, x.id).toBeDefined();
      expect(row!.actorAccountId).toBe(marketingKbId);
      expect(row!.after).toMatchObject({ status: 'proposed', imported: true, sourceMessageId: null });
    }
    const [batch] = await auditOf('inbox.ai_example.import', examples[0]!.id);
    expect(batch!.after).toEqual({
      received: 4,
      created: 4,
      replayed: 0,
      createdIds: examples.map((x) => x.id),
      replayedIds: [],
      byLanguage: { en: 2, th: 1, ru: 1 },
      byVerdict: { should_answer: 2, should_handover: 1, should_stay_silent: 1 },
    });
    expect(await sentinelLeaks(w.ctx.db, SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });

  it('is the queue reviewer’s alone: reception, an inbox agent and a branch editor are refused, and nothing is written', async () => {
    const before = await examplesCount();
    for (const cookie of [receptionCookie, agentCookie, chalongKbCookie]) {
      const res = await post(cookie, { examples: [item()] });
      expect(res.statusCode, res.body).toBe(403);
    }
    expect(await examplesCount()).toBe(before);
  });

  it('refuses an item that still looks like personal data, by index and field — and saves nothing of the import', async () => {
    const before = await examplesCount();
    const clean = item();
    const phone = await post(marketingKbCookie, { examples: [clean, item({ customerText: 'please call me back on 081 234 5678' })] });
    expect(phone.statusCode).toBe(400);
    const err = phone.json().error as { code: string; message: string; details: Record<string, unknown> };
    expect(err.code).toBe('PERSONAL_DATA_FOUND');
    expect(err.details).toEqual({ index: 1, field: 'customerText', kind: 'a phone number or another long number' });
    expect(err.message).toMatch(/^Example 2: the customer text still looks like it holds a phone number/);
    // The refusal never repeats the words it found.
    expect(phone.body).not.toContain('234 5678');

    const mail = await post(marketingKbCookie, { examples: [item({ goodReply: 'Write to bookings.person@example.com' })] });
    expect(mail.statusCode).toBe(400);
    expect(mail.json().error.details).toEqual({ index: 0, field: 'goodReply', kind: 'an e-mail address' });

    const handle = await post(marketingKbCookie, { examples: [item({ customerText: 'my line: @somebody' })] });
    expect(handle.statusCode).toBe(400);
    expect(handle.json().error.details).toMatchObject({ index: 0, kind: 'a messaging handle' });

    expect(await examplesCount()).toBe(before);
    expect(await w.ctx.db.select().from(s.aiExample).where(eq(s.aiExample.id, clean.id))).toHaveLength(0);
  });

  it('refuses an intent the assistant does not know and a should_answer without its reply, by index', async () => {
    const odd = await post(marketingKbCookie, { examples: [item(), item({ intent: 'parties' })] });
    expect(odd.statusCode).toBe(409);
    expect(odd.json().error).toMatchObject({ code: 'INTENT_UNKNOWN', details: { index: 1 } });
    const bare = await post(marketingKbCookie, { examples: [item({ goodReply: null })] });
    expect(bare.statusCode).toBe(409);
    expect(bare.json().error).toMatchObject({ code: 'GOOD_REPLY_REQUIRED', details: { index: 0 } });
  });

  it('holds the shape: 1 to 50 items, lengths, languages, one id per item', async () => {
    expect((await post(marketingKbCookie, { examples: [] })).statusCode).toBe(400);
    const tooMany = Array.from({ length: INBOX_AI_EXAMPLE_IMPORT_MAX + 1 }, () => item());
    expect((await post(marketingKbCookie, { examples: tooMany })).statusCode).toBe(400);
    expect((await post(marketingKbCookie, { examples: [item({ customerText: 'x'.repeat(501) })] })).statusCode).toBe(400);
    expect((await post(marketingKbCookie, { examples: [item({ language: 'de' })] })).statusCode).toBe(400);
    const twin = item();
    expect((await post(marketingKbCookie, { examples: [twin, { ...twin }] })).statusCode).toBe(400);
  });

  it('a resend writes nothing new: the same Idempotency-Key replays the answer; the same ids under a new key are replays', async () => {
    const examples = [item({ customerText: 'What time do you open?', goodReply: 'We open at 10:00 every day.', intent: 'hours' })];
    const key = newId();
    const first = await post(marketingKbCookie, { examples }, key);
    expect(first.statusCode, first.body).toBe(200);
    const after = await examplesCount();

    const again = await post(marketingKbCookie, { examples }, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await examplesCount()).toBe(after);

    const byId = await post(marketingKbCookie, { examples }, newId());
    expect(byId.statusCode, byId.body).toBe(200);
    expect(byId.headers['x-oto-replay']).toBe('true');
    expect(byId.json()).toMatchObject({ created: 0, replayed: 1 });
    expect(await examplesCount()).toBe(after);
    // Nothing new to record: no second import row.
    expect(await auditOf('inbox.ai_example.import', examples[0]!.id)).toHaveLength(1);

    // An id that names somebody else's example is refused, and nothing is written.
    const taken = newId();
    await w.ctx.db.insert(s.aiExample).values({
      id: taken,
      operatorId: w.oto,
      intent: 'other',
      language: 'en',
      customerText: 'Somebody else’s proposal',
      verdict: 'should_handover',
      proposedByAccountId: agentId,
    });
    const clash = await post(marketingKbCookie, { examples: [item({ id: taken })] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('ID_IN_USE');
    expect(await examplesCount()).toBe(after + 1);
  });

  it('an imported example is approved like any other — there is no source to sever — and then reaches the assistant', async () => {
    const x = item({ customerText: 'Can adults play too?', goodReply: 'Yes! Adults are welcome on the play floor with their children 😊', intent: 'age_rules' });
    expect((await post(marketingKbCookie, { examples: [x] })).statusCode).toBe(200);
    const refused = await call<{ error: { code: string } }>(w, marketingKbCookie, 'POST', `/inbox/ai/examples/${x.id}/approve`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('DEIDENTIFICATION_REQUIRED');
    const ok = await call(w, marketingKbCookie, 'POST', `/inbox/ai/examples/${x.id}/approve`, { deidentifiedConfirmed: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      deidentifiedConfirmed: true,
      approvedByAccountId: marketingKbId,
      sourceMessageId: null,
      sourceConversationId: null,
    });
    const known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect(JSON.stringify(known.knowledge)).toContain('Adults are welcome on the play floor');

    // A proposed import can still be edited or withdrawn in the queue as before.
    const y = item({ customerText: 'Is there parking?', goodReply: 'Yes, the mall has free parking.', intent: 'directions_parking' });
    expect((await post(marketingKbCookie, { examples: [y] })).statusCode).toBe(200);
    expect((await call(w, marketingKbCookie, 'PATCH', `/inbox/ai/examples/${y.id}`, { goodReply: 'Yes, there is parking at the mall.' })).status).toBe(200);
    expect((await call(w, marketingKbCookie, 'DELETE', `/inbox/ai/examples/${y.id}`)).status).toBe(200);
    expect(await w.ctx.db.select().from(s.aiExample).where(inArray(s.aiExample.id, [y.id]))).toHaveLength(0);
  });
});
