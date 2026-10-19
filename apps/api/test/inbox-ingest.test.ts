import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema as s } from '@oto/db';
import { signMetaPayload, type RawWebhook, type SimulatorChannel } from '@oto/messaging';
import { newId } from '@oto/shared';
import { assertProductionSafe, loadEnv } from '../src/env';
import { mirrorNotice } from '../src/services/inbox/mirror';
import { pickRule } from '../src/services/inbox/router';
import { closedSince, isOpenAt, readOpeningHours } from '../src/services/inbox/hours';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';

/**
 * S2-19 I2d (SCRUM-583) — the Inbox's routing and ingest, through the real
 * webhook route with simulator-signed deliveries (plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.1, §3.4, §6 "I2").
 *
 * What it holds: a refused signature is a receipt and nothing else; a
 * delivery is deduped as a whole and each message on its own provider id;
 * a new thread is routed per category and language to the rule's primary
 * with the backup added as support; a branchless general enquiry is routed by
 * the CHANNEL ACCOUNT's branch; the catch-all and the team fallback leave
 * nothing unowned; a customer message reopens a handled thread; out of hours
 * the hours template is the reply, once per closed period; a replay changes
 * nothing; another operator sees none of it; and the demo is played end to
 * end through the ingest. No message body reaches an audit row, a timeline
 * event or an ops row.
 */

const SECRET = 'inbox-ingest-test-secret';
const SENTINEL = 'SENTINEL-c0ffee-never-outside-the-message-table';

let ctx: TestContext;
let oto: string;
let second: string;
let central: string;
let chalong: string;
const ids = {} as Record<'caCentral' | 'caChalong' | 'caWide' | 'caSecond' | 'caConsole', string>;
const people = {} as Record<'bdayEn' | 'bdayEnBackup' | 'bdayTh' | 'bdayThBackup' | 'marketing' | 'marketingBackup', string>;

async function accountIdByPhone(phone: string): Promise<string> {
  const [row] = await ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, phone)).limit(1);
  return row!.id;
}

async function caRow(id: string) {
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, id)).limit(1);
  return row!;
}

async function simOf(id: string): Promise<SimulatorChannel> {
  const row = await caRow(id);
  const sim = ctx.app.inboxChannels.simulatorFor({ ...row });
  if (!sim) throw new Error('simulator off');
  return sim;
}

async function post(channelAccountId: string, webhook: RawWebhook, headers?: Record<string, string>) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${channelAccountId}`,
    headers: headers ?? (webhook.headers as Record<string, string>),
    payload: typeof webhook.rawBody === 'string' ? webhook.rawBody : Buffer.from(webhook.rawBody),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { outcome: string };
}

/** Play one customer line through the webhook route; returns the provider id. */
async function play(
  channelAccountId: string,
  input: Parameters<SimulatorChannel['inbound']>[0],
): Promise<{ externalMessageId: string; outcome: string; webhook: RawWebhook }> {
  const sim = await simOf(channelAccountId);
  const played = sim.inbound(input);
  const { outcome } = await post(channelAccountId, played.webhook);
  return { externalMessageId: played.externalMessageId, outcome, webhook: played.webhook };
}

async function threadOf(channelAccountId: string, handle: string) {
  const [row] = await ctx.db
    .select({ conv: s.conversation })
    .from(s.conversation)
    .innerJoin(s.contact, eq(s.contact.id, s.conversation.contactId))
    .where(and(eq(s.conversation.channelAccountId, channelAccountId), eq(s.contact.externalHandle, handle)))
    .limit(1);
  return row?.conv;
}

async function ownersOf(conversationId: string) {
  return ctx.db
    .select()
    .from(s.assignment)
    .where(and(eq(s.assignment.conversationId, conversationId), isNull(s.assignment.releasedAt)))
    .orderBy(s.assignment.slotIndex);
}

async function teamId(key: 'birthdays' | 'marketing' | 'reception', branchId: string | null = null, operatorId = oto) {
  const [row] = await ctx.db
    .select({ id: s.team.id })
    .from(s.team)
    .where(
      and(
        eq(s.team.operatorId, operatorId),
        eq(s.team.key, key),
        branchId ? eq(s.team.branchId, branchId) : isNull(s.team.branchId),
      ),
    )
    .limit(1);
  return row!.id;
}

async function nameRule(category: 'birthdays' | 'marketing', language: string | null, primary: string, backup: string) {
  await ctx.db
    .update(s.routingRule)
    .set({ primaryKind: 'account', primaryAccountId: primary, backupAccountId: backup })
    .where(
      and(
        eq(s.routingRule.operatorId, oto),
        eq(s.routingRule.category, category),
        language === null ? isNull(s.routingRule.language) : eq(s.routingRule.language, language),
        eq(s.routingRule.priority, 10),
      ),
    );
}

async function simulatorAccount(operatorId: string, externalId: string, branchId: string | null, channel = 'whatsapp') {
  const id = newId();
  await ctx.db.insert(s.channelAccount).values({
    id,
    operatorId,
    branchId,
    channel: channel as 'whatsapp',
    provider: 'simulator',
    externalId,
    displayName: `Test ${externalId}`,
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: SECRET } });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  second = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  ids.caCentral = await simulatorAccount(oto, 'test-wa-central', central);
  ids.caChalong = await simulatorAccount(oto, 'test-wa-chalong', chalong);
  ids.caWide = await simulatorAccount(oto, 'test-ig-wide', null, 'instagram');
  ids.caSecond = await simulatorAccount(second, 'test-wa-second', await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME));
  const [consoleRow] = await ctx.db
    .select({ id: s.channelAccount.id })
    .from(s.channelAccount)
    .where(and(eq(s.channelAccount.operatorId, oto), eq(s.channelAccount.provider, 'console')))
    .limit(1);
  ids.caConsole = consoleRow!.id;

  people.bdayEn = await accountIdByPhone(BRANCH_MANAGER.phone);
  people.bdayEnBackup = await accountIdByPhone(CHALONG_MANAGER.phone);
  people.bdayTh = await accountIdByPhone(RECEPTION.phone);
  people.bdayThBackup = await accountIdByPhone(ADMIN.phone);
  people.marketing = await accountIdByPhone(CHALONG_MANAGER.phone);
  people.marketingBackup = await accountIdByPhone(BRANCH_MANAGER.phone);
  await nameRule('birthdays', 'en', people.bdayEn, people.bdayEnBackup);
  await nameRule('birthdays', 'th', people.bdayTh, people.bdayThBackup);
  await nameRule('marketing', null, people.marketing, people.marketingBackup);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the webhook refuses what it cannot verify, and records it (I2d)', () => {
  it('a bad or missing signature is a receipt with signature_ok=false and no message, answered 200', async () => {
    const sim = await simOf(ids.caCentral);
    const played = sim.inbound({ from: '66810001001', name: 'Forged', text: `forged ${SENTINEL}` });
    const raw = played.webhook.rawBody as string;

    expect((await post(ids.caCentral, played.webhook, { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, 'not-the-secret') })).outcome).toBe('bad_signature');
    expect((await post(ids.caCentral, played.webhook, { 'content-type': 'application/json' })).outcome).toBe('bad_signature');

    const receipts = await ctx.db
      .select()
      .from(s.webhookReceipt)
      .where(and(eq(s.webhookReceipt.channelAccountId, ids.caCentral), eq(s.webhookReceipt.signatureOk, false)));
    expect(receipts).toHaveLength(1); // the same bytes refused twice is one refusal on record
    expect(receipts[0]!.payload).toBeNull();
    expect(receipts[0]!.error).toBe('BAD_SIGNATURE');
    const msgs = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, played.externalMessageId));
    expect(msgs).toHaveLength(0);

    // The forged copy sent first never shadows the real delivery of the same bytes.
    expect((await post(ids.caCentral, played.webhook)).outcome).toBe('processed');
    const after = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, played.externalMessageId));
    expect(after).toHaveLength(1);
  });

  it('an unknown account, a non-uuid and a send-only console account are answered 200 and touch nothing', async () => {
    const sim = await simOf(ids.caCentral);
    const played = sim.inbound({ from: '66810001002', text: 'hello' });
    expect((await post(newId(), played.webhook)).outcome).toBe('unknown_channel_account');
    expect((await post('not-a-uuid', played.webhook)).outcome).toBe('unknown_channel_account');
    expect((await post(ids.caConsole, played.webhook)).outcome).toBe('channel_not_connected');
    const msgs = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, played.externalMessageId));
    expect(msgs).toHaveLength(0);
  });

  it('answers the GET challenge with the verify token, and refuses without it', async () => {
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/webhooks/inbox/${ids.caCentral}?hub.mode=subscribe&hub.verify_token=oto-simulator&hub.challenge=12345`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const bad = await ctx.app.inject({
      method: 'GET',
      url: `/webhooks/inbox/${ids.caCentral}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`,
    });
    expect(bad.statusCode).toBe(403);
  });
});

describe('dedupe at both levels (I2d)', () => {
  it('the same delivery twice is one message; the second is a duplicate receipt and changes nothing', async () => {
    const first = await play(ids.caCentral, { from: '66810001010', name: 'Dup', text: 'Is the park open today?' });
    expect(first.outcome).toBe('processed');
    const tally = async () =>
      (
        await ctx.db.execute<{ t: string }>(
          sql`select (select count(*) from inbox.webhook_receipt)::text || '/' || (select count(*) from core.audit_log)::text
            || '/' || (select count(*) from inbox.message)::text || '/' || (select count(*) from inbox.event)::text
            || '/' || (select max(updated_at) from inbox.conversation)::text as t`,
        )
      ).rows[0]!.t;
    const before = await tally();
    expect((await post(ids.caCentral, first.webhook)).outcome).toBe('duplicate');
    // Byte for byte the same delivery: no receipt, no audit row, no timestamp moves.
    expect(await tally()).toBe(before);
    const msgs = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, first.externalMessageId));
    expect(msgs).toHaveLength(1);
  });

  it('a message already stored arriving in a DIFFERENT delivery is skipped, and its neighbour is not', async () => {
    const sim = await simOf(ids.caCentral);
    const a = sim.inbound({ from: '66810001011', text: 'first' });
    expect((await post(ids.caCentral, a.webhook)).outcome).toBe('processed');
    // A batch carrying the stored message and a new one, signed as one delivery.
    const body = JSON.parse(a.webhook.rawBody as string);
    const b = sim.inbound({ from: '66810001011', text: 'second' });
    const bMsg = JSON.parse(b.webhook.rawBody as string).entry[0].changes[0].value.messages[0];
    body.entry[0].changes[0].value.messages.push(bMsg);
    const raw = JSON.stringify(body);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/inbox/${ids.caCentral}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, SECRET) },
      payload: raw,
    });
    expect(res.json()).toEqual({ outcome: 'processed' });
    const [receipt] = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.webhook.receive')))
      .orderBy(sql`${s.auditLog.createdAt} desc`)
      .limit(1);
    expect(receipt!.after).toMatchObject({ messages: 1, duplicates: 1 });
    const stored = await ctx.db
      .select()
      .from(s.message)
      .where(inArray(s.message.externalMessageId, [a.externalMessageId, b.externalMessageId]));
    expect(stored).toHaveLength(2);
  });
});

describe('routing a new conversation (I2d)', () => {
  it('EN birthdays → the EN/RU primary, with the backup auto-added as support from the first message', async () => {
    await play(ids.caCentral, { from: '66810002001', text: 'Birthday party?', hint: { category: 'birthdays', language: 'en' } });
    const conv = (await threadOf(ids.caCentral, '+66810002001'))!;
    expect(conv.teamId).toBe(await teamId('birthdays'));
    expect(conv.category).toBe('birthdays');
    expect(conv.lastRoutedAt).not.toBeNull();
    const owners = await ownersOf(conv.id);
    expect(owners.map((o) => [o.slot, o.accountId, o.reason, o.assignedByKind])).toEqual([
      ['primary', people.bdayEn, 'auto', 'system'],
      ['support', people.bdayEnBackup, 'auto', 'system'],
    ]);
    const pills = await ctx.db.select().from(s.inboxEvent).where(eq(s.inboxEvent.conversationId, conv.id));
    expect(pills.map((p) => p.kind).sort()).toEqual(['assigned', 'assigned', 'routed']);
  });

  it('TH birthdays → the Thai pair; marketing → the marketing owner with its backup', async () => {
    await play(ids.caChalong, { from: '66810002002', text: 'วันเกิด', hint: { category: 'birthdays', language: 'th' } });
    const th = (await threadOf(ids.caChalong, '+66810002002'))!;
    expect((await ownersOf(th.id)).map((o) => o.accountId)).toEqual([people.bdayTh, people.bdayThBackup]);

    await play(ids.caWide, { from: '66810002003', text: 'Collab?', hint: { category: 'marketing', language: 'en' } });
    const mk = (await threadOf(ids.caWide, '66810002003'))!;
    expect(mk.teamId).toBe(await teamId('marketing'));
    expect(mk.branchId).toBeNull();
    expect((await ownersOf(mk.id)).map((o) => o.accountId)).toEqual([people.marketing, people.marketingBackup]);
  });

  it('a branchless general enquiry is routed by the CHANNEL ACCOUNT’s branch — even against the hint', async () => {
    await play(ids.caChalong, { from: '66810002004', text: 'Lost a bottle', hint: { category: 'general' } });
    const conv = (await threadOf(ids.caChalong, '+66810002004'))!;
    expect(conv.branchId).toBe(chalong);
    const owners = await ownersOf(conv.id);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ slot: 'primary', assigneeKind: 'team', teamId: await teamId('reception', chalong) });

    // The park's own number wins over a hint naming the other park.
    await play(ids.caChalong, { from: '66810002005', text: 'Hours?', hint: { category: 'general', branchId: central } });
    const pinned = (await threadOf(ids.caChalong, '+66810002005'))!;
    expect(pinned.branchId).toBe(chalong);
    expect(pinned.teamId).toBe(await teamId('reception', chalong));

    // No hint at all: the account's default category and branch.
    await play(ids.caCentral, { from: '66810002006', text: 'hello' });
    const plain = (await threadOf(ids.caCentral, '+66810002006'))!;
    expect(plain).toMatchObject({ category: 'general', branchId: central, teamId: await teamId('reception', central) });
  });

  it('an operator-wide account takes the hint’s branch; with none, the team fallback still gives an owner', async () => {
    await play(ids.caWide, { from: '66810002007', text: 'Prices?', hint: { category: 'general', branchId: central } });
    const hinted = (await threadOf(ids.caWide, '66810002007'))!;
    expect(hinted).toMatchObject({ branchId: central, teamId: await teamId('reception', central) });

    await play(ids.caWide, { from: '66810002008', text: 'Prices?' });
    const loose = (await threadOf(ids.caWide, '66810002008'))!;
    expect(loose.branchId).toBeNull();
    const owners = await ownersOf(loose.id);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.assigneeKind).toBe('team');
    const [routed] = await ctx.db
      .select()
      .from(s.inboxEvent)
      .where(and(eq(s.inboxEvent.conversationId, loose.id), eq(s.inboxEvent.kind, 'routed')));
    expect(routed!.payload).toMatchObject({ fallback: true, ruleId: null });
  });

  it('the catch-all takes a language no named rule has; a deactivated primary gives way to the team, the backup still added', async () => {
    await play(ids.caCentral, { from: '66810002009', text: 'Anniversaire?', hint: { category: 'birthdays', language: 'fr' } });
    const fr = (await threadOf(ids.caCentral, '+66810002009'))!;
    const owners = await ownersOf(fr.id);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ assigneeKind: 'team', teamId: await teamId('birthdays') });

    await ctx.db.update(s.account).set({ status: 'inactive' }).where(eq(s.account.id, people.bdayTh));
    try {
      await play(ids.caCentral, { from: '66810002010', text: 'วันเกิด', hint: { category: 'birthdays', language: 'th' } });
      const off = (await threadOf(ids.caCentral, '+66810002010'))!;
      expect((await ownersOf(off.id)).map((o) => [o.slot, o.assigneeKind, o.accountId ?? o.teamId])).toEqual([
        ['primary', 'team', await teamId('birthdays')],
        ['support', 'account', people.bdayThBackup],
      ]);
    } finally {
      await ctx.db.update(s.account).set({ status: 'active' }).where(eq(s.account.id, people.bdayTh));
    }
  });

  it('pickRule: priority, then specificity, and null means any', () => {
    const base = {
      operatorId: oto,
      teamId: 't',
      primaryKind: 'team' as const,
      primaryAccountId: null,
      backupAccountId: null,
      autoAddBackup: true,
      active: true,
      archivedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const any = { ...base, id: 'any', category: 'general' as const, language: null, branchId: null, priority: 0 };
    const atCentral = { ...base, id: 'central', category: 'general' as const, language: null, branchId: 'c', priority: 0 };
    const en = { ...base, id: 'en', category: 'general' as const, language: 'en', branchId: null, priority: 10 };
    const off = { ...en, id: 'off', priority: 99, active: false };
    expect(pickRule([any, atCentral, en, off], { category: 'general', language: 'EN', branchId: 'c' })!.id).toBe('en');
    expect(pickRule([any, atCentral], { category: 'general', language: 'th', branchId: 'c' })!.id).toBe('central');
    expect(pickRule([any, atCentral], { category: 'general', language: 'th', branchId: null })!.id).toBe('any');
    expect(pickRule([atCentral], { category: 'general', language: 'th', branchId: null })).toBeNull();
  });
});

describe('the customer writes again (I2d)', () => {
  it('a message on a handled thread reopens it automatically, owners kept', async () => {
    await play(ids.caCentral, { from: '66810003001', text: 'Thanks!' });
    const conv = (await threadOf(ids.caCentral, '+66810003001'))!;
    const owners = await ownersOf(conv.id);
    const handler = await accountIdByPhone(RECEPTION.phone);
    await ctx.db
      .update(s.conversation)
      .set({ status: 'handled', handledAt: new Date(), handledByKind: 'account', handledByAccountId: handler })
      .where(eq(s.conversation.id, conv.id));

    await play(ids.caCentral, { from: '66810003001', text: 'One more question' });
    const after = (await threadOf(ids.caCentral, '+66810003001'))!;
    expect(after.id).toBe(conv.id);
    expect(after.status).toBe('active');
    expect(after.reopenedAt).not.toBeNull();
    expect(after.handledAt).toBeNull();
    expect((await ownersOf(conv.id)).map((o) => o.id)).toEqual(owners.map((o) => o.id));
    const [pill] = await ctx.db
      .select()
      .from(s.inboxEvent)
      .where(and(eq(s.inboxEvent.conversationId, conv.id), eq(s.inboxEvent.kind, 'reopened')));
    expect(pill).toMatchObject({ actorKind: 'customer' });
    expect(pill!.payload).toMatchObject({ automatic: true, previousHandledByAccountId: handler });
    const audits = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.conversation.reopen'), eq(s.auditLog.entityId, conv.id)));
    expect(audits).toHaveLength(1);
  });
});

describe('out of hours (I2d)', () => {
  it('the hours helpers: closed on an absent day, open inside the window, the closed period starts at the last close', () => {
    const hours = readOpeningHours({ mon: { open: '10:00', close: '20:00' }, tue: { open: '10:00', close: '20:00' } })!;
    // Monday 2026-10-19 14:00 Bangkok = 07:00Z.
    expect(isOpenAt(hours, 'Asia/Bangkok', new Date('2026-10-19T07:00:00Z'))).toBe(true);
    // Monday 21:00 Bangkok = 14:00Z: closed since Monday 20:00 (13:00Z).
    const late = new Date('2026-10-19T14:00:00Z');
    expect(isOpenAt(hours, 'Asia/Bangkok', late)).toBe(false);
    expect(closedSince(hours, 'Asia/Bangkok', late)!.toISOString()).toBe('2026-10-19T13:00:00.000Z');
    // Saturday: closed since Tuesday 20:00.
    expect(closedSince(hours, 'Asia/Bangkok', new Date('2026-10-24T05:00:00Z'))!.toISOString()).toBe('2026-10-20T13:00:00.000Z');
    expect(readOpeningHours(null)).toBeNull();
    expect(readOpeningHours({ mon: { open: '25:00', close: '20:00' } })).toBeNull();
    expect(readOpeningHours({})).toBeNull();
  });

  it('outside the hours the template is the reply — sent through the channel, once per closed period — and the thread stays active', async () => {
    // Open only on a day that is not today in Bangkok: closed now.
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const today = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' }).format(new Date()).toLowerCase().slice(0, 3);
    const other = days[(days.indexOf(today) + 3) % 7]!;
    await ctx.db
      .update(s.channelAccount)
      .set({ openingHours: { [other]: { open: '10:00', close: '20:00' } } })
      .where(eq(s.channelAccount.id, ids.caChalong));

    await play(ids.caChalong, { from: '66810004001', text: 'Are you open?', hint: { language: 'en' } });
    const conv = (await threadOf(ids.caChalong, '+66810004001'))!;
    const replies = () =>
      ctx.db
        .select({ m: s.message, key: s.template.key })
        .from(s.message)
        .innerJoin(s.template, eq(s.template.id, s.message.templateId))
        .where(and(eq(s.message.conversationId, conv.id), eq(s.message.direction, 'outbound')));
    const first = await replies();
    expect(first).toHaveLength(1);
    expect(first[0]!.key).toBe('out_of_hours');
    expect(first[0]!.m).toMatchObject({ authorKind: 'system', providerStatus: 'sent' });
    expect(first[0]!.m.externalMessageId).toMatch(/^wamid\.SIM\./);
    expect(conv.status).toBe('active');
    expect(conv.lastStaffMessageAt).toBeNull(); // the hours line is not an answer

    await play(ids.caChalong, { from: '66810004001', text: 'Hello?' });
    expect(await replies()).toHaveLength(1);

    // The simulator scheduled delivered and read for it: push them through the webhook.
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const pushed = await ctx.app.inject({
      method: 'POST',
      url: '/inbox/simulator/status',
      headers: { cookie },
      payload: { channelAccountId: ids.caChalong },
    });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().deliveries.map((d: { outcome: string }) => d.outcome)).toEqual(['processed', 'processed']);
    const [read] = await replies();
    expect(read!.m).toMatchObject({ providerStatus: 'read' });
    expect(read!.m.deliveredAt).not.toBeNull();
    expect(read!.m.readAt).not.toBeNull();

    await ctx.db.update(s.channelAccount).set({ openingHours: null }).where(eq(s.channelAccount.id, ids.caChalong));
  });
});

describe('replay idempotence (I2d)', () => {
  it('replaying every delivery received so far changes no inbox row and no audit row', async () => {
    const counts = async () => {
      const q = async (table: string) =>
        (await ctx.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]!.n;
      return {
        contact: await q('inbox.contact'),
        conversation: await q('inbox.conversation'),
        message: await q('inbox.message'),
        assignment: await q('inbox.assignment'),
        event: await q('inbox.event'),
        receipt: await q('inbox.webhook_receipt'),
        audit: await q('core.audit_log'),
        updated: (
          await ctx.db.execute<{ t: string }>(sql`select coalesce(max(updated_at), 'epoch')::text as t from inbox.conversation`)
        ).rows[0]!.t,
      };
    };
    const receipts = await ctx.db
      .select()
      .from(s.webhookReceipt)
      .where(and(eq(s.webhookReceipt.channelAccountId, ids.caCentral), eq(s.webhookReceipt.signatureOk, true)));
    expect(receipts.length).toBeGreaterThan(5);
    const before = await counts();
    for (const r of receipts) {
      const raw = JSON.stringify(r.payload);
      // jsonb normalises key order, so re-sign what was stored: the receipt key
      // is then a NEW delivery id and the per-message dedupe is what holds.
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/webhooks/inbox/${ids.caCentral}`,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, SECRET) },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
    }
    const after = await counts();
    // Only the new deliveries' receipts and their own receipt audit rows appear.
    expect({ ...after, receipt: 0, audit: 0 }).toEqual({ ...before, receipt: 0, audit: 0 });
    expect(after.receipt - before.receipt).toBe(receipts.length);
    expect(after.audit - before.audit).toBe(receipts.length);
  });
});

describe('cross-operator isolation (I2d)', () => {
  it('another operator’s account files into its own operator only; a hint naming OTO’s branch is ignored', async () => {
    await play(ids.caSecond, { from: '66810002001', text: 'Birthday?', hint: { category: 'general', branchId: central } });
    const conv = (await threadOf(ids.caSecond, '+66810002001'))!;
    expect(conv.operatorId).toBe(second);
    expect(conv.branchId).not.toBe(central);
    const [team] = await ctx.db.select().from(s.team).where(eq(s.team.id, conv.teamId!));
    expect(team!.operatorId).toBe(second);
    // The same phone in OTO is a different contact.
    const contacts = await ctx.db.select().from(s.contact).where(eq(s.contact.externalHandle, '+66810002001'));
    expect(new Set(contacts.map((c) => c.operatorId))).toEqual(new Set([oto, second]));
    for (const o of await ownersOf(conv.id)) {
      if (o.teamId) {
        const [t] = await ctx.db.select().from(s.team).where(eq(s.team.id, o.teamId));
        expect(t!.operatorId).toBe(second);
      }
    }
  });

  it('a simulator press on another operator’s account is a 404', async () => {
    const cookie = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/inbox/simulator/inbound',
      headers: { cookie },
      payload: { channelAccountId: ids.caCentral, from: '66810005001', text: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a reception account without inbox:channel:manage cannot press the simulator', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/inbox/simulator/inbound',
      headers: { cookie },
      payload: { channelAccountId: ids.caCentral, from: '66810005002', text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('the simulator drive and the demo, end to end (I2d)', () => {
  it('POST /inbox/simulator/inbound plays a signed message through the ingest', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/inbox/simulator/inbound',
      headers: { cookie },
      payload: {
        channelAccountId: ids.caCentral,
        from: '66810006001',
        name: 'Panel press',
        text: `A press ${SENTINEL}`,
        hint: { category: 'birthdays', language: 'en' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'processed', messages: 1, conversationsCreated: 1 });
    const audit = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.webhook.receive'), eq(s.auditLog.entityId, res.json().receiptId)));
    expect(audit[0]!.actorAccountId).toBe(await accountIdByPhone(ADMIN.phone));
  });

  it('POST /inbox/simulator/scenario plays the ten demo conversations through the ingest, once', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const first = await ctx.app.inject({ method: 'POST', url: '/inbox/simulator/scenario', headers: { cookie }, payload: { scenario: 'demo' } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ conversationsCreated: 10, conversationsAlreadyThere: 0, staffCreated: 6, rulesNamed: 1 });
    const again = await ctx.app.inject({ method: 'POST', url: '/inbox/simulator/scenario', headers: { cookie }, payload: { scenario: 'demo' } });
    expect(again.json()).toMatchObject({ conversationsCreated: 0, conversationsAlreadyThere: 10, messages: 0 });

    // Every demo thread came in through a verified receipt and has one primary.
    const demoAccounts = await ctx.db
      .select({ id: s.channelAccount.id })
      .from(s.channelAccount)
      .where(and(eq(s.channelAccount.operatorId, oto), sql`${s.channelAccount.externalId} like 'demo-%'`));
    expect(demoAccounts).toHaveLength(4);
    const accountIds = demoAccounts.map((a) => a.id);
    const convs = await ctx.db.select().from(s.conversation).where(inArray(s.conversation.channelAccountId, accountIds));
    expect(convs).toHaveLength(10);
    const receipts = await ctx.db.select().from(s.webhookReceipt).where(inArray(s.webhookReceipt.channelAccountId, accountIds));
    const customerLines = 15;
    expect(receipts.filter((r) => r.signatureOk && r.processedAt)).toHaveLength(customerLines);
    for (const c of convs) {
      const owners = await ownersOf(c.id);
      expect(owners.filter((o) => o.slot === 'primary')).toHaveLength(1);
    }
  });

  it('with the simulator off, a press is 409 CHANNEL_NOT_CONNECTED', async () => {
    const off = await createTestContext();
    try {
      const cookie = await signInAs(off.app, ADMIN.phone, ADMIN.password);
      const res = await off.app.inject({
        method: 'POST',
        url: '/inbox/simulator/scenario',
        headers: { cookie },
        payload: { scenario: 'demo' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHANNEL_NOT_CONNECTED');
    } finally {
      await off.close();
    }
  });
});

describe('PDPA: no body outside the message table (I2d)', () => {
  it('the sentinel is in the message table and in no audit row, timeline event or ops row', async () => {
    const inMessages = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from inbox.message where body like ${'%' + SENTINEL + '%'}`,
    );
    expect(inMessages.rows[0]!.n).toBeGreaterThan(0);
    // The shared sentinel (I2g, `inbox-sentinel.ts`); the log lines are `inbox-privacy.test.ts`'s.
    expect(await sentinelLeaks(ctx.db, SENTINEL)).toEqual(NO_LEAKS);
  });
});

describe('the boot refusals (I2d)', () => {
  it('production refuses the simulator; the simulator on without its secret, or WhatsApp on without its variables, refuses anywhere', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' } as const;
    expect(() => loadEnv({ ...base, INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: '' })).toThrow(/INBOX_SIMULATOR_SECRET/);
    expect(() => loadEnv({ ...base, INBOX_WHATSAPP_ENABLED: 'true' })).toThrow(/INBOX_META_APP_SECRET and INBOX_META_VERIFY_TOKEN/);
    const env = loadEnv({ ...base, INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: 'x' });
    expect(() => assertProductionSafe({ ...env, DEPLOY_ENV: 'production' })).toThrow(/INBOX_SIMULATOR is on/);
  });
});

describe('coexistence with the check-in mirror (I2c)', () => {
  it('a customer writing on WhatsApp after a check-in notice shares the notice’s contact, gets a routed thread of its own, and leaves the notice thread as it was', async () => {
    const phone = '+66810007001';
    await ctx.db.transaction((tx) =>
      mirrorNotice(tx, {
        operatorId: oto,
        branchId: central,
        channel: 'whatsapp',
        phone,
        displayName: 'Mirror Guest',
        body: 'Your check-in is confirmed (ingest test)',
        source: 'checkin.contact',
        sourceId: newId(),
        sentAt: new Date(),
        sender: { send: () => Promise.resolve() },
      }),
    );
    const notice = (await threadOf(await consoleWhatsApp(), phone))!;
    const noticeBefore = { ...notice };

    await play(ids.caCentral, { from: phone.slice(1), name: 'Mirror Guest', text: 'Thanks — one question' });
    const thread = (await threadOf(ids.caCentral, phone))!;
    expect(thread.contactId).toBe(notice.contactId);
    expect(thread.id).not.toBe(notice.id);
    expect(thread.lastRoutedAt).not.toBeNull();
    expect((await ownersOf(thread.id)).filter((o) => o.slot === 'primary')).toHaveLength(1);

    const [after] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, notice.id));
    expect(after).toEqual(noticeBefore);
  });
});

async function consoleWhatsApp(): Promise<string> {
  const [row] = await ctx.db
    .select({ id: s.channelAccount.id })
    .from(s.channelAccount)
    .where(
      and(
        eq(s.channelAccount.operatorId, oto),
        eq(s.channelAccount.provider, 'console'),
        eq(s.channelAccount.channel, 'whatsapp'),
      ),
    )
    .limit(1);
  return row!.id;
}
