import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  booking,
  branch,
  channelAccount,
  contact,
  conversation,
  inboxEvent,
  member,
  message,
  opsRun,
  registration,
  station,
  team,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { NOTICE_MIRROR_RUN, mirrorNotice } from '../src/services/inbox/mirror';
import { withTx } from '../src/services/tx';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
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
 * SCRUM-582 — Inbox round I2c: THE CHECK-IN FEED (plan
 * docs/progress/plans/inbox-build/PLAN.md §2.4).
 *
 * The connection check a registration sends, and the booking confirmation,
 * land in the guardian's Inbox thread as outbound system messages, through a
 * savepoint that can never block the check-in.
 */

const SECRET = randomBytes(32).toString('hex');
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];
/** The fixed sentence of the connection check — what must never leave the message row. */
const CHECK_TEXT = 'has just been registered at Oto';

const WEEKDAY = (() => {
  const day = new Date(Date.now() + 7 * 86_400_000);
  for (;;) {
    const iso = new Date(day.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const nearHoliday = iso >= '2026-11-23' && iso <= '2026-11-25';
    if (dow !== 0 && dow !== 6 && !nearHoliday) return iso;
    day.setUTCDate(day.getUTCDate() + 1);
  }
})();

let ctx: TestContext;
let reception: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let maliId: string;
let receptionTeamId: string;

let family = 0;
function familyAddress(): string {
  family += 1;
  return `10.232.${Math.floor(family / 250)}.${(family % 250) + 1}`;
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOTESTMERCHANT',
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
  maliId = mali!.id;
  const [rt] = await ctx.db
    .select()
    .from(team)
    .where(and(eq(team.operatorId, operatorId), eq(team.key, 'reception'), eq(team.branchId, branchId)));
  receptionTeamId = rt!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

function childBody(name = 'Mint') {
  return {
    checkinId: newId(),
    name,
    ageYears: 6,
    service: 'drop_off',
    allergies: null,
    foodRestrictions: null,
    foodProvision: { mode: 'none', paidSatang: 0 },
  };
}

async function register(phone: string, guardianName = 'Ploy', contactChannel = 'whatsapp') {
  const id = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: {
      id,
      branchId,
      stationId,
      guardianName,
      guardianPhone: phone,
      contactChannel,
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [childBody()],
    },
  });
  return { id, res };
}

async function contactsFor(op: string, phone: string) {
  return ctx.db.select().from(contact).where(and(eq(contact.operatorId, op), eq(contact.phone, phone)));
}

async function threadOf(contactId: string) {
  const convs = await ctx.db.select().from(conversation).where(eq(conversation.contactId, contactId));
  expect(convs).toHaveLength(1);
  const msgs = await ctx.db
    .select()
    .from(message)
    .where(eq(message.conversationId, convs[0]!.id))
    .orderBy(message.createdAt);
  const events = await ctx.db.select().from(inboxEvent).where(eq(inboxEvent.conversationId, convs[0]!.id));
  return { conv: convs[0]!, msgs, events };
}

describe('the check-in feed', () => {
  it("writes a till registration's connection check into the guardian's thread, linked to the member", async () => {
    // Typed in Thai local format: the registration stores E.164, so does the mirror.
    const { id: regId, res } = await register('0811111111', 'Khun Mali');
    expect(res.statusCode, res.body).toBe(200);

    const contacts = await contactsFor(operatorId, '+66811111111');
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      channel: 'whatsapp',
      externalHandle: '+66811111111',
      memberId: maliId,
      displayName: 'Khun Mali',
    });

    const { conv, msgs, events } = await threadOf(contacts[0]!.id);
    const [account] = await ctx.db.select().from(channelAccount).where(eq(channelAccount.id, conv.channelAccountId));
    expect(account).toMatchObject({ provider: 'console', externalId: 'console:whatsapp', canReply: false });
    expect(conv).toMatchObject({
      operatorId,
      branchId,
      teamId: receptionTeamId,
      category: 'general',
      status: 'active',
      memberId: maliId,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      direction: 'outbound',
      authorKind: 'system',
      providerStatus: 'sent',
      source: 'checkin.contact',
      sourceId: regId,
    });
    expect(msgs[0]!.body).toContain('Khun Mali, Mint ' + CHECK_TEXT);
    expect(msgs[0]!.externalMessageId).toMatch(new RegExp(`^checkin\\.contact:${regId}:`));
    expect(conv.lastMessagePreview).toBe(msgs[0]!.body!.slice(0, 140));
    expect(events.map((e) => e.kind)).toEqual(['notice_mirrored']);
    expect(events[0]!.actorKind).toBe('account');

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'inbox.notice_mirror'), eq(auditLog.entityId, msgs[0]!.id)));
    expect(audits).toHaveLength(1);
  });

  it('appends a resend and a second registration to the SAME thread', async () => {
    const { id: regId, res } = await register('+66811111111', 'Khun Mali');
    expect(res.statusCode, res.body).toBe(200);
    const resend = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${regId}/contact-test`,
      headers: { cookie: reception },
    });
    expect(resend.statusCode, resend.body).toBe(200);

    const contacts = await contactsFor(operatorId, '+66811111111');
    expect(contacts).toHaveLength(1);
    const { msgs, events } = await threadOf(contacts[0]!.id);
    expect(msgs).toHaveLength(3);
    expect(msgs.filter((m) => m.sourceId === regId)).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'notice_mirrored')).toHaveLength(3);
  });

  it('writes the same send once, however often it is mirrored', async () => {
    const sentAt = new Date();
    const regId = newId();
    const input = {
      operatorId,
      branchId,
      channel: 'line',
      phone: '+66899990001',
      displayName: 'Replay',
      body: 'a replayed notice',
      source: 'checkin.contact' as const,
      sourceId: regId,
      sentAt,
      sender: { send: () => Promise.resolve() },
    };
    const first = await withTx(ctx.db, { operatorId }, 'test.mirror', (tx) => mirrorNotice(tx, input));
    const again = await withTx(ctx.db, { operatorId }, 'test.mirror', (tx) => mirrorNotice(tx, input));
    expect(first.mirrored).toBe(true);
    expect(again).toEqual({ mirrored: false, reason: 'already_mirrored' });
    const contacts = await contactsFor(operatorId, '+66899990001');
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.channel).toBe('line');
    expect((await threadOf(contacts[0]!.id)).msgs).toHaveLength(1);
  });

  it('mirrors a paid booking: its registration check and its confirmation, in one thread', async () => {
    const cat = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
    expect(cat.statusCode, cat.body).toBe(200);
    const confirmations = (
      cat.json().supervision as { policy: { confirmations: Array<{ id: string; required: boolean }> } }
    ).policy.confirmations
      .filter((c) => c.required)
      .map((c) => c.id);
    const [oneHour] = await ctx.db
      .select()
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '1 Hour Play')));
    const made = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      remoteAddress: familyAddress(),
      payload: {
        branchCode: CENTRAL_BRANCH_CODE,
        phone: '0812345670',
        parentName: 'Khun Dao',
        tier: 'thai',
        visitDate: WEEKDAY,
        consentAck: true,
        acknowledgedConfirmationIds: confirmations,
        lines: [{ packageId: oneHour!.id, kids: 1, adults: 0, supervision: { childName: 'Ploy', ageYears: 6 } }],
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const bookingId = made.json().id as string;
    const opened = await ctx.app.inject({
      method: 'POST',
      url: `/public/bookings/${bookingId}/checkout`,
      remoteAddress: familyAddress(),
      payload: { method: 'card' },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const pressed = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${opened.json().attemptId as string}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    expect(pressed.statusCode, pressed.body).toBe(200);

    const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, bookingId));
    expect(paid!.status).toBe('paid');
    const regId = (paid!.payload as { registrationId: string }).registrationId;

    const contacts = await contactsFor(operatorId, '+66812345670');
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.memberId).toBe(paid!.memberId ?? null);
    const { conv, msgs } = await threadOf(contacts[0]!.id);
    expect(msgs.map((m) => [m.source, m.sourceId])).toEqual(
      expect.arrayContaining([
        ['checkin.contact', regId],
        ['booking.confirmation', bookingId],
      ]),
    );
    expect(msgs).toHaveLength(2);
    const confirmation = msgs.find((m) => m.source === 'booking.confirmation')!;
    expect(confirmation.body).toContain(`booking ${paid!.reference}`);
    expect(confirmation.authorKind).toBe('system');
    expect(conv.teamId).toBe(receptionTeamId);
  });

  it('never blocks a check-in: a broken mirror rolls back alone and the registration completes', async () => {
    // A real database fault on the mirror's LAST write: the contact, the
    // conversation and the message are already written inside the savepoint
    // when it fires, so only the savepoint can be what removes them.
    await ctx.db.execute(sql`
      create function inbox.test_mirror_fault() returns trigger language plpgsql as $$
      begin raise exception 'injected inbox fault'; end $$`);
    await ctx.db.execute(sql`
      create trigger test_mirror_fault before insert on inbox.event
      for each row execute function inbox.test_mirror_fault()`);
    let regId: string;
    try {
      const out = await register('+66899990002', 'Faulty');
      regId = out.id;
      expect(out.res.statusCode, out.res.body).toBe(200);
    } finally {
      await ctx.db.execute(sql`drop trigger test_mirror_fault on inbox.event`);
      await ctx.db.execute(sql`drop function inbox.test_mirror_fault()`);
    }

    // The check-in happened, with its own audit trail.
    expect(await ctx.db.select().from(registration).where(eq(registration.id, regId))).toHaveLength(1);
    const regAudits = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, regId));
    expect(regAudits.map((a) => a.action)).toEqual(expect.arrayContaining(['registration.create', 'registration.contact']));
    // The connection check itself went out and went pending, as without the Inbox.
    expect(regAudits.find((a) => a.action === 'registration.contact')!.after).toMatchObject({ status: 'pending' });

    // No partial inbox rows: no contact, no thread, no message, no mirror audit.
    expect(await contactsFor(operatorId, '+66899990002')).toHaveLength(0);
    expect(await ctx.db.select().from(message).where(eq(message.sourceId, regId))).toHaveLength(0);

    // The failure is recorded, without the body or the phone.
    const runs = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, NOTICE_MIRROR_RUN), eq(opsRun.outcome, 'failed')));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs.at(-1)!;
    expect(run.errorCode).toBe('pg:P0001');
    const text = JSON.stringify(run);
    expect(text).not.toContain(CHECK_TEXT);
    expect(text).not.toContain('99990002');
    expect(text).not.toContain('Faulty');

    // And the mirror works again once the fault is gone.
    const after = await register('+66899990002', 'Faulty');
    expect(after.res.statusCode).toBe(200);
    expect(await contactsFor(operatorId, '+66899990002')).toHaveLength(1);
  });

  it('keeps operators apart: the same phone is a separate contact and thread, linked only to its own member', async () => {
    const otherOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
    const otherBranchId = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
    const out = await withTx(ctx.db, { operatorId: otherOperatorId }, 'test.mirror', (tx) =>
      mirrorNotice(tx, {
        operatorId: otherOperatorId,
        branchId: otherBranchId,
        channel: 'whatsapp',
        phone: '+66811111111',
        displayName: 'Somebody else',
        body: 'a notice at the other park',
        source: 'checkin.contact',
        sourceId: newId(),
        sentAt: new Date(),
        sender: { send: () => Promise.resolve() },
      }),
    );
    expect(out.mirrored).toBe(true);

    const mine = await contactsFor(operatorId, '+66811111111');
    const theirs = await contactsFor(otherOperatorId, '+66811111111');
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.id).not.toBe(mine[0]!.id);
    // Mali is a member of OTO, not of the other operator.
    expect(theirs[0]!.memberId).toBeNull();
    expect(mine[0]!.memberId).toBe(maliId);
    const t = await threadOf(theirs[0]!.id);
    expect(t.conv.operatorId).toBe(otherOperatorId);
    const [acct] = await ctx.db.select().from(channelAccount).where(eq(channelAccount.id, t.conv.channelAccountId));
    expect(acct!.operatorId).toBe(otherOperatorId);
    // OTO's thread did not gain the other park's notice.
    const m = await threadOf(mine[0]!.id);
    expect(m.msgs.some((x) => x.body === 'a notice at the other park')).toBe(false);
  });

  it('never copies a message body into an event payload or an audit row', async () => {
    const bodies = (await ctx.db.select({ body: message.body }).from(message)).map((m) => m.body!);
    expect(bodies.length).toBeGreaterThanOrEqual(6);
    const events = JSON.stringify(await ctx.db.select({ p: inboxEvent.payload }).from(inboxEvent));
    const audits = JSON.stringify(await ctx.db.select({ b: auditLog.before, a: auditLog.after }).from(auditLog));
    for (const body of bodies) {
      expect(events).not.toContain(body);
      expect(audits).not.toContain(body);
    }
    expect(events).not.toContain(CHECK_TEXT);
    expect(audits).not.toContain(CHECK_TEXT);
    // The shared sentinel (I2g): ops rows as well.
    expect(await sentinelLeaks(ctx.db, CHECK_TEXT)).toEqual(NO_LEAKS);
    // The mirror's own audit rows carry ids, never the phone.
    const mirrorAudits = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'inbox.notice_mirror'));
    expect(mirrorAudits.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(mirrorAudits)).not.toMatch(/\+66\d{8,9}/);
  });
});
