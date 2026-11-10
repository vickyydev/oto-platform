import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { runInboxAiJob } from '../src/services/inbox/ai-engine';
import {
  HANDOVER_ESCALATION_AFTER_MS,
  HANDOVER_ESCALATION_JOB,
  maskPhone,
  runHandoverEscalationJob,
  type HandoverNoticeDeps,
} from '../src/services/inbox/handover-notice';
import { buildDefaultJobs } from '../src/services/jobs';
import {
  DIRECTORY_NOT_CONFIGURED,
  buildOtoAppDirectory,
  type DirectoryNotificationBody,
  type DirectoryOutcome,
  type DirectoryNotificationAnswer,
} from '../src/services/otoapp-directory';
import { ADMIN, RECEPTION, signInAs, teardownAll } from './helpers';
import { aiLines, aiWorld, call, customer, decision, kb, nextPhone, simAccount, staff, teamOf, turnsOf, type AiWorld } from './inbox-ai-support';

/**
 * SCRUM-823 — A BIRTHDAYS & EVENTS HAND-OVER TELLS A PERSON (owner, 10 Nov).
 * Against a real embedded database, the real turn engine and the
 * `FakeAssistantClient`, with the OTO App's bell and the notice sender
 * captured (nothing is sent anywhere):
 *
 *   - "which branch do you recommend for 12 kids?" in a Birthdays & Events
 *     thread, read by the model as a plain faq answer: the gate hands it over
 *     as birthday_advice, the family gets the birthday manager's closing line,
 *     and the birthday manager on duty at the park is told in the bell and by
 *     a WhatsApp ping, each a `handover_notification` row — no customer words
 *     in either;
 *   - the same advice beside the opener: the opener goes, the line follows,
 *     and the manager is told;
 *   - any other Birthdays & Events hand-over (the party's details) tells nobody;
 *   - fifteen minutes on with nobody on the thread, ONE escalation to the GM's
 *     contact; a second sweep escalates nothing more;
 *   - a staff reply, a person's assignment, a date booked, the assistant
 *     paused by a person, or a note, before then: no escalation;
 *   - a park that names nobody: the hand-over is recorded "nobody to tell",
 *     and the GM "not notified" too;
 *   - THE JOB'S OWN SENDER (`buildNoticeSender`, which only logs): a phone-only
 *     contact's ping is recorded skipped `PING_NOT_LIVE`, never sent, and the
 *     pill says the manager was not notified;
 *   - the thread's detail carries what its pill says;
 *   - the branch setting, edited as the Console edits it, and never read by a
 *     till login;
 *   - the directory door: `notify` posts the notice under the directory key.
 *
 * FICTIONAL TEST DATA throughout.
 */

let w: AiWorld;
let birthdays: string; // a Birthdays & Events number at Central, live
let chalongBirthdays: string; // the same at Chalong, which names nobody
let adminCookie: string;
let agentCookie: string;
let agentId: string;

const BIRTHDAY_MANAGER = { name: 'ZZ TEST Birthday Manager', appUserId: 'zz-app-user-bm', phone: '+66810008231', channel: 'whatsapp' } as const;
const GM = { name: 'ZZ TEST GM', appUserId: 'zz-app-user-gm', phone: '+66810008232', channel: 'telegram' } as const;
const ADVICE = 'Hi! Which branch do you recommend for 12 kids?';

/** The bell and the ping, captured: the capturing sender stands for a live one (`pingLive`). */
const bell: DirectoryNotificationBody[] = [];
const pings: Array<{ phone: string; message: string }> = [];
let bellAnswer: (b: DirectoryNotificationBody) => DirectoryOutcome<DirectoryNotificationAnswer> = (b) => ({
  ok: true,
  status: 201,
  body: { notification: { id: b.id, recipientUserId: b.recipientUserId, type: 'inbox_handover', createdAt: new Date().toISOString() }, replayed: false },
});
const notices: HandoverNoticeDeps = {
  directory: {
    configured: true,
    notify: async (b) => {
      bell.push(b);
      return bellAnswer(b);
    },
  },
  sender: { send: async (phone, message) => void pings.push({ phone, message }) },
  pingLive: true,
};

/** One tick of `job:inbox.ai` with the captured bell and sender. */
const tick = (at: Date) =>
  runInboxAiJob(
    w.ctx.db,
    { runtime: w.ctx.app.inboxAi, channels: w.ctx.app.inboxChannels, storage: w.ctx.app.fileStorage, log: w.ctx.app.log, now: () => at, notices },
    at,
  );
/** One tick with no notice senders: the notices wait for `job:inbox.handover_escalation`. */
const tickWithoutNotices = (at: Date) =>
  runInboxAiJob(
    w.ctx.db,
    { runtime: w.ctx.app.inboxAi, channels: w.ctx.app.inboxChannels, storage: w.ctx.app.fileStorage, log: w.ctx.app.log, now: () => at },
    at,
  );
const after = (ms: number) => new Date(Date.now() + ms);
const sweep = (at: Date) => runHandoverEscalationJob(w.ctx.db, notices, at);

/** The model's reading on staging-like terms: a grounded faq answer the safety net must overrule. */
const recommendsCentral = () =>
  decision({ intent: 'faq', grounding: ['faq.party-room'], reason: 'FACT_IN_KB', bubbles: ['Central Floresta is our biggest park, perfect for 12 kids 😊'] });

const noticesOf = (conversationId: string) =>
  w.ctx.db
    .select()
    .from(s.handoverNotification)
    .where(eq(s.handoverNotification.conversationId, conversationId))
    .orderBy(asc(s.handoverNotification.createdAt), asc(s.handoverNotification.channel));

async function templateRow(key: 'closing_birthday', language: 'en') {
  const [row] = await w.ctx.db
    .select()
    .from(s.template)
    .where(
      and(
        eq(s.template.operatorId, w.oto),
        eq(s.template.key, key),
        eq(s.template.language, language),
        isNull(s.template.channel),
        isNull(s.template.branchId),
        isNull(s.template.archivedAt),
      ),
    )
    .limit(1);
  return row!;
}

/**
 * Every earlier test's hand-over stamped picked up, so a sweep here acts on
 * this test's hand-over alone (the sweep takes every open one).
 */
async function quiet() {
  await w.ctx.db
    .update(s.handoverNotification)
    .set({ pickedUpAt: new Date() })
    .where(and(eq(s.handoverNotification.kind, 'notice'), isNull(s.handoverNotification.pickedUpAt), isNull(s.handoverNotification.escalatedAt)));
}

/**
 * The tick runs on a clock 25 seconds ahead (past the debounce), so the
 * hand-over is stamped then; a person acting in the test acts at the real
 * now. Moving the hand-over's notices two minutes back puts the person's act
 * after it, as it is on a real thread.
 */
async function handedOverEarlier(conversationId: string) {
  const rows = await noticesOf(conversationId);
  for (const r of rows) {
    await w.ctx.db
      .update(s.handoverNotification)
      .set({ createdAt: new Date(r.createdAt.getTime() - 2 * 60_000) })
      .where(eq(s.handoverNotification.id, r.id));
  }
}

/** A Birthdays & Events thread whose advice question the engine handed over; answers it and its turn. */
async function handedOver(account = birthdays) {
  const conv = await customer(w, account, nextPhone(), ADVICE);
  w.fake.push({ kind: 'decision', decision: recommendsCentral() });
  expect((await tick(after(25_000))).handedOver).toBe(1);
  const [turn] = await turnsOf(w, conv.id);
  return { conv, turn: turn! };
}

beforeAll(async () => {
  w = await aiWorld();
  birthdays = await simAccount(w, { branchId: w.central, defaultCategory: 'birthdays' });
  chalongBirthdays = await simAccount(w, { branchId: w.chalong, defaultCategory: 'birthdays' });
  adminCookie = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
  // Central names its birthday manager and GM, as the Console's branch editor does.
  const saved = await call(w, adminCookie, 'PATCH', `/branches/${w.central}`, {
    birthdayManagerContact: { ...BIRTHDAY_MANAGER, phone: '081 000 8231' },
    gmContact: GM,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const birthdaysTeam = await teamOf(w, 'birthdays');
  [agentId, agentCookie] = await staff(w, '+66810008230', 'ZZ TEST Birthday Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: birthdaysTeam.departmentId!,
  });
  await kb(w, agentId, {
    key: 'faq.party-room',
    topic: 'faq',
    language: 'en',
    question: 'Do you have a party room?',
    body: 'Both parks have a private party room.',
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

describe('SCRUM-823: the birthday manager on duty is told', () => {
  it('a till login (reception) reads GET /branches without anybody’s contact', async () => {
    const reception = await signInAs(w.ctx.app, RECEPTION.phone, RECEPTION.password);
    const listed = await call<{ branches: Array<{ id: string; birthdayManagerContact: unknown; gmContact: unknown }> }>(w, reception, 'GET', '/branches');
    expect(listed.status).toBe(200);
    expect(listed.body.branches.length).toBeGreaterThan(0);
    for (const b of listed.body.branches) expect({ bm: b.birthdayManagerContact, gm: b.gmContact }).toEqual({ bm: null, gm: null });
    expect(JSON.stringify(listed.body)).not.toContain('8231');
  });

  it('the branch setting: saved with the phone in E.164, read back by GET /branches, a non-number refused', async () => {
    const listed = await call<{ branches: Array<{ id: string; birthdayManagerContact: unknown; gmContact: unknown }> }>(w, adminCookie, 'GET', '/branches');
    const central = listed.body.branches.find((b) => b.id === w.central)!;
    expect(central.birthdayManagerContact).toEqual(BIRTHDAY_MANAGER);
    expect(central.gmContact).toEqual(GM);
    const bad = await call<{ error: { code: string } }>(w, adminCookie, 'PATCH', `/branches/${w.chalong}`, {
      gmContact: { name: null, appUserId: null, phone: 'not a phone', channel: 'whatsapp' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('PHONE_INVALID');
    const [audit] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'branch.update'), eq(s.auditLog.entityId, w.central)))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it('"which branch do you recommend for 12 kids?": handed over at once, the holding line sent, the manager told in the bell and by a ping', async () => {
    bell.length = 0;
    pings.length = 0;
    const { conv, turn } = await handedOver();

    // The gate's safety net: birthday_advice, and why.
    expect(turn).toMatchObject({ state: 'handed_over', intent: 'birthday_advice', reason: 'OVERRULED_BIRTHDAY' });
    // The warm holding line, verbatim, never the model's recommendation.
    const closing = await templateRow('closing_birthday', 'en');
    const lines = await aiLines(w, conv.id);
    expect(lines.map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: closing.body, templateId: closing.id }]);
    expect(lines.some((l) => /biggest park/.test(l.body ?? ''))).toBe(false);
    // The thread is in the Birthdays queue.
    const birthdaysTeam = await teamOf(w, 'birthdays');
    const [thread] = await w.ctx.db.select().from(s.conversation).where(eq(s.conversation.id, conv.id));
    expect(thread).toMatchObject({ category: 'birthdays', teamId: birthdaysTeam.id });

    // One row per channel, both sent, no customer words and no full number anywhere.
    const rows = await noticesOf(conv.id);
    expect(rows.map((r) => ({ kind: r.kind, channel: r.channel, target: r.target, state: r.state, intent: r.intent, branchId: r.branchId, destination: r.destination }))).toEqual([
      { kind: 'notice', channel: 'app', target: BIRTHDAY_MANAGER.appUserId, state: 'sent', intent: 'birthday_advice', branchId: w.central, destination: 'birthdays' },
      { kind: 'notice', channel: 'whatsapp', target: maskPhone(BIRTHDAY_MANAGER.phone), state: 'sent', intent: 'birthday_advice', branchId: w.central, destination: 'birthdays' },
    ]);
    expect(maskPhone(BIRTHDAY_MANAGER.phone)).toBe('+66*****8231');
    expect(rows.every((r) => r.turnId === turn.id && r.sentAt !== null && r.escalatedAt === null && r.pickedUpAt === null)).toBe(true);

    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ id: rows[0]!.id, recipientUserId: BIRTHDAY_MANAGER.appUserId, referenceType: 'inbox_conversation', referenceId: conv.id });
    expect(bell[0]!.body).toMatch(/advice asked/);
    expect(pings).toEqual([{ phone: BIRTHDAY_MANAGER.phone, message: expect.stringMatching(/Birthdays & Events conversation is waiting/) }]);
    for (const words of [bell[0]!.title, bell[0]!.body, pings[0]!.message]) expect(words).not.toMatch(/recommend|12 kids|AI Test Guest/i);
    for (const words of [bell[0]!.body, pings[0]!.message]) expect(words).toContain('Central Floresta');
  });

  it('nobody picks it up in fifteen minutes: ONE escalation to the GM, in the bell and by a Telegram ping; a second sweep adds nothing', async () => {
    await quiet();
    const { conv, turn } = await handedOver();
    bell.length = 0;
    pings.length = 0;
    // Not yet: fourteen minutes on.
    expect((await sweep(after(14 * 60_000))).escalated).toBe(0);
    const first = await sweep(after(HANDOVER_ESCALATION_AFTER_MS + 60_000));
    expect(first.escalated).toBe(1);
    const rows = await noticesOf(conv.id);
    const escalations = rows.filter((r) => r.kind === 'escalation');
    expect(escalations.map((r) => ({ channel: r.channel, target: r.target, state: r.state }))).toEqual([
      { channel: 'app', target: GM.appUserId, state: 'sent' },
      { channel: 'telegram', target: maskPhone(GM.phone), state: 'sent' },
    ]);
    expect(rows.filter((r) => r.kind === 'notice').every((r) => r.escalatedAt !== null && r.pickedUpAt === null)).toBe(true);
    expect(bell.filter((b) => b.referenceId === conv.id).map((b) => b.recipientUserId)).toEqual([GM.appUserId]);
    expect(pings.filter((p) => p.phone === GM.phone)).toHaveLength(1);
    expect(pings.find((p) => p.phone === GM.phone)!.message).toMatch(/waited 15 minutes/);

    // Once: a later sweep writes and sends nothing more for it.
    await sweep(after(HANDOVER_ESCALATION_AFTER_MS + 5 * 60_000));
    expect((await noticesOf(conv.id)).filter((r) => r.kind === 'escalation')).toHaveLength(2);
    expect(pings.filter((p) => p.phone === GM.phone)).toHaveLength(1);

    const [audit] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.handover.escalate'), eq(s.auditLog.entityId, conv.id)));
    expect(audit!.after).toMatchObject({ turnId: turn.id });

    // The thread's detail carries what the pill says.
    const detail = await call<{ handoverNotices: Array<Record<string, unknown>> }>(w, adminCookie, 'GET', `/inbox/conversations/${conv.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.handoverNotices).toEqual([
      {
        turnId: turn.id,
        destination: 'birthdays',
        notifiedAt: expect.any(String),
        notNotified: false,
        notNotifiedWhy: null,
        escalatedAt: expect.any(String),
        gmNotNotified: false,
        gmNotNotifiedWhy: null,
        pickedUpAt: null,
      },
    ]);
  });

  it('a staff reply before then: no escalation, the hand-over stamped picked up', async () => {
    await quiet();
    const { conv } = await handedOver();
    await handedOverEarlier(conv.id);
    const replied = await call(w, agentCookie, 'POST', `/inbox/conversations/${conv.id}/messages`, { id: newId(), text: 'Hello, this is the birthday team!' });
    expect(replied.status, JSON.stringify(replied.body)).toBe(200);
    const result = await sweep(after(HANDOVER_ESCALATION_AFTER_MS + 60_000));
    expect(result).toMatchObject({ pickedUp: 1, escalated: 0 });
    const rows = await noticesOf(conv.id);
    expect(rows.filter((r) => r.kind === 'escalation')).toEqual([]);
    expect(rows.every((r) => r.pickedUpAt !== null && r.escalatedAt === null)).toBe(true);
  });

  it('an assignment a person made before then: no escalation either', async () => {
    await quiet();
    const { conv } = await handedOver();
    await handedOverEarlier(conv.id);
    await w.ctx.db.insert(s.assignment).values({
      id: newId(),
      operatorId: w.oto,
      conversationId: conv.id,
      slot: 'support',
      slotIndex: 2,
      assigneeKind: 'account',
      accountId: agentId,
      assignedByKind: 'account',
      assignedByAccountId: agentId,
      reason: 'manual',
      assignedAt: new Date(),
    });
    expect(await sweep(after(HANDOVER_ESCALATION_AFTER_MS + 60_000))).toMatchObject({ pickedUp: 1, escalated: 0 });
    const rows = await noticesOf(conv.id);
    expect(rows.filter((r) => r.kind === 'escalation')).toEqual([]);
    expect(rows.every((r) => r.pickedUpAt !== null)).toBe(true);
  });

  it('a date booked, the assistant paused by a person, or a note before then: picked up, no escalation', async () => {
    const acts: Array<[string, (conversationId: string) => Promise<void>]> = [
      [
        'date booked',
        async (conversationId) => {
          await w.ctx.db.insert(s.inboxEvent).values({
            id: newId(),
            operatorId: w.oto,
            conversationId,
            kind: 'date_booked',
            actorKind: 'account',
            actorAccountId: agentId,
            payload: {},
          });
        },
      ],
      [
        'assistant paused',
        async (conversationId) => {
          const paused = await call(w, agentCookie, 'POST', `/inbox/conversations/${conversationId}/ai-pause`);
          expect(paused.status, JSON.stringify(paused.body)).toBe(200);
        },
      ],
      [
        'note',
        async (conversationId) => {
          await w.ctx.db.insert(s.inboxNote).values({ id: newId(), operatorId: w.oto, conversationId, authorAccountId: agentId, body: null });
        },
      ],
    ];
    for (const [what, act] of acts) {
      await quiet();
      const { conv } = await handedOver();
      await handedOverEarlier(conv.id);
      await act(conv.id);
      expect(await sweep(after(HANDOVER_ESCALATION_AFTER_MS + 60_000)), what).toMatchObject({ pickedUp: 1, escalated: 0 });
      const rows = await noticesOf(conv.id);
      expect(rows.filter((r) => r.kind === 'escalation'), what).toEqual([]);
      expect(rows.every((r) => r.pickedUpAt !== null), what).toBe(true);
    }
  });

  it('advice beside the opener: the opener goes, the birthday manager’s line follows, and the manager is told', async () => {
    await quiet();
    bell.length = 0;
    pings.length = 0;
    const opener = ["Amazing, thank you! We'd love to organize a party for you 🎈", 'What date are you thinking of, roughly how many people, and which branch?'];
    const conv = await customer(w, birthdays, nextPhone(), "Hi! We'd like a birthday party for our son. Which branch do you recommend?");
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'birthday_party', intents: ['birthday_party', 'faq'], reason: 'CLEAR_INTENT', bubbles: opener }) });
    expect((await tick(after(25_000))).handedOver).toBe(1);
    const [turn] = await turnsOf(w, conv.id);
    expect(turn).toMatchObject({ state: 'handed_over' });
    const closing = await templateRow('closing_birthday', 'en');
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([...opener, closing.body]);
    const rows = await noticesOf(conv.id);
    expect(rows.map((r) => ({ kind: r.kind, channel: r.channel, intent: r.intent, state: r.state }))).toEqual([
      { kind: 'notice', channel: 'app', intent: 'birthday_advice', state: 'sent' },
      { kind: 'notice', channel: 'whatsapp', intent: 'birthday_advice', state: 'sent' },
    ]);
  });

  it('any other Birthdays & Events hand-over (the party’s details) tells nobody: the approved scope is the advice question', async () => {
    await quiet();
    bell.length = 0;
    pings.length = 0;
    const conv = await customer(w, birthdays, nextPhone(), 'About 12 kids and 8 adults, at Central Floresta please.');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(after(25_000))).handedOver).toBe(1);
    expect(await noticesOf(conv.id)).toEqual([]);
    expect(bell).toEqual([]);
    expect(pings).toEqual([]);
  });

  it('a park that names nobody: one row says so, the pill says "not notified", and it still escalates (to nobody, recorded)', async () => {
    await quiet();
    bell.length = 0;
    pings.length = 0;
    const { conv } = await handedOver(chalongBirthdays);
    const rows = await noticesOf(conv.id);
    expect(rows.map((r) => ({ kind: r.kind, channel: r.channel, target: r.target, state: r.state, errorCode: r.errorCode, branchId: r.branchId }))).toEqual([
      { kind: 'notice', channel: 'app', target: null, state: 'skipped', errorCode: 'NO_CONTACT', branchId: w.chalong },
    ]);
    expect(bell).toEqual([]);
    expect(pings).toEqual([]);
    await sweep(after(HANDOVER_ESCALATION_AFTER_MS + 60_000));
    const escalated = (await noticesOf(conv.id)).filter((r) => r.kind === 'escalation');
    expect(escalated.map((r) => ({ state: r.state, errorCode: r.errorCode }))).toEqual([{ state: 'skipped', errorCode: 'NO_CONTACT' }]);
    const detail = await call<{ handoverNotices: Array<Record<string, unknown>> }>(w, adminCookie, 'GET', `/inbox/conversations/${conv.id}`);
    // Nobody reached: neither "notified" nor "escalated to GM", each with its reason.
    expect(detail.body.handoverNotices).toEqual([
      expect.objectContaining({
        notifiedAt: null,
        notNotified: true,
        notNotifiedWhy: 'no_contact',
        escalatedAt: null,
        gmNotNotified: true,
        gmNotNotifiedWhy: 'no_contact',
      }),
    ]);
  });

  it('the job’s own sender only logs: a phone-only contact’s ping is skipped PING_NOT_LIVE, never sent, and the pill says not notified', async () => {
    await quiet();
    const saved = await call(w, adminCookie, 'PATCH', `/branches/${w.chalong}`, {
      birthdayManagerContact: { name: 'ZZ TEST Phone Only', appUserId: null, phone: '+66810008233', channel: 'telegram' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    try {
      const conv = await customer(w, chalongBirthdays, nextPhone(), ADVICE);
      w.fake.push({ kind: 'decision', decision: recommendsCentral() });
      expect((await tickWithoutNotices(after(25_000))).handedOver).toBe(1);
      // The runner's job with its default deps: the env's directory and `buildNoticeSender`.
      const job = buildDefaultJobs({ db: w.ctx.db, env: w.ctx.app.env, log: w.ctx.app.log, channels: [], inboxAi: w.ctx.app.inboxAi }).find(
        (j) => j.name === HANDOVER_ESCALATION_JOB,
      )!;
      await job.run({ db: w.ctx.db, env: w.ctx.app.env, log: w.ctx.app.log, now: new Date() });
      const rows = await noticesOf(conv.id);
      expect(rows.map((r) => ({ channel: r.channel, state: r.state, errorCode: r.errorCode, sentAt: r.sentAt, target: r.target }))).toEqual([
        { channel: 'telegram', state: 'skipped', errorCode: 'PING_NOT_LIVE', sentAt: null, target: maskPhone('+66810008233') },
      ]);
      const detail = await call<{ handoverNotices: Array<Record<string, unknown>> }>(w, adminCookie, 'GET', `/inbox/conversations/${conv.id}`);
      expect(detail.body.handoverNotices).toEqual([
        expect.objectContaining({ notifiedAt: null, notNotified: true, notNotifiedWhy: 'ping_logged_only' }),
      ]);
    } finally {
      await call(w, adminCookie, 'PATCH', `/branches/${w.chalong}`, { birthdayManagerContact: null });
    }
  });

  it('the app refusing the bell: that row failed with the app’s word, the ping still went', async () => {
    bell.length = 0;
    pings.length = 0;
    bellAnswer = () => ({ ok: false, status: 404, code: 'OTOAPP_RECIPIENT_NOT_FOUND', message: 'No such user in this park group', retryable: false });
    try {
      const { conv } = await handedOver();
      const rows = await noticesOf(conv.id);
      expect(rows.map((r) => ({ channel: r.channel, state: r.state, errorCode: r.errorCode }))).toEqual([
        { channel: 'app', state: 'failed', errorCode: 'OTOAPP_RECIPIENT_NOT_FOUND' },
        { channel: 'whatsapp', state: 'sent', errorCode: null },
      ]);
    } finally {
      bellAnswer = (b) => ({
        ok: true,
        status: 201,
        body: { notification: { id: b.id, recipientUserId: b.recipientUserId, type: 'inbox_handover', createdAt: new Date().toISOString() }, replayed: false },
      });
    }
  });

  it('a hand-over to another team tells nobody here (the complaint to the GM queue)', async () => {
    const general = await simAccount(w, { branchId: w.central });
    const conv = await customer(w, general, nextPhone(), 'Your staff were rude to my daughter today.');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'complaint_onsite', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(after(25_000))).handedOver).toBe(1);
    expect(await noticesOf(conv.id)).toEqual([]);
  });

  it('the job is registered every minute', () => {
    const jobs = buildDefaultJobs({ db: w.ctx.db, env: w.ctx.app.env, log: w.ctx.app.log, channels: [], inboxAi: w.ctx.app.inboxAi, handoverNotices: notices });
    expect(jobs.find((j) => j.name === HANDOVER_ESCALATION_JOB)?.intervalSeconds).toBe(60);
  });
});

describe('SCRUM-823: the directory door (`notify`)', () => {
  const KEY = 'odk_test_key_value_823';
  let server: Server;
  let origin: string;
  let answer: { status: number; body: unknown } = { status: 201, body: {} };
  const seen: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      req.on('end', () => resolve(data));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const text = await readBody(req);
      seen.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(text || 'null') });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const env = (o: { url?: string; key?: string } = {}) => ({
    OTOAPP_DIRECTORY_URL: o.url ?? origin,
    OTOAPP_DIRECTORY_KEY: o.key ?? KEY,
    OTOAPP_DIRECTORY_TIMEOUT_MS: 2000,
  });
  const body = (): DirectoryNotificationBody => ({
    id: newId(),
    recipientUserId: 'zz-app-user',
    title: 'Birthday family waiting in the Inbox',
    body: 'A Birthdays & Events conversation was handed to a person at 14:05 (Central Floresta).',
    referenceType: 'inbox_conversation',
    referenceId: newId(),
  });

  it('posts the notice to /api/directory/notifications under the directory key, and reads the app’s answer', async () => {
    const b = body();
    answer = { status: 201, body: { notification: { id: b.id, recipientUserId: b.recipientUserId, type: 'inbox_handover', createdAt: new Date().toISOString() }, replayed: false } };
    const out = await buildOtoAppDirectory(env()).notify!(b);
    expect(out).toMatchObject({ ok: true, status: 201 });
    expect(seen.at(-1)).toEqual({ url: '/api/directory/notifications', auth: `Bearer ${KEY}`, body: b });
  });

  it('a refusal is the app’s own word, not retried; an answer without the notification is a fault to retry', async () => {
    answer = { status: 404, body: { error: 'recipient_not_found', message: 'No such user in this park group' } };
    expect(await buildOtoAppDirectory(env()).notify!(body())).toMatchObject({ ok: false, status: 404, code: 'OTOAPP_RECIPIENT_NOT_FOUND', retryable: false });
    answer = { status: 201, body: {} };
    expect(await buildOtoAppDirectory(env()).notify!(body())).toMatchObject({ ok: false, code: 'OTOAPP_UNREADABLE_ANSWER', retryable: true });
  });

  it('a deployment with no directory makes no call', async () => {
    const before = seen.length;
    expect(await buildOtoAppDirectory(env({ key: '' })).notify!(body())).toMatchObject({ ok: false, code: DIRECTORY_NOT_CONFIGURED });
    expect(seen.length).toBe(before);
  });
});
