import { hash } from '@node-rs/argon2';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { expect } from 'vitest';
import { FakeAssistantClient, type AiDecision } from '@oto/assistant';
import { schema as s, type AiMode } from '@oto/db';
import type { SimulatorChannel } from '@oto/messaging';
import { newId } from '@oto/shared';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import type { FileStorage } from '../src/services/files';
import { runInboxAiJob, type AiSweep } from '../src/services/inbox/ai-engine';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  type TestContext,
} from './helpers';

/**
 * The customer assistant's turn-engine suites (SCRUM-590, round A2 lane a;
 * plan `docs/progress/plans/inbox-ai-build/PLAN.md` §F.3 "A2"): one real
 * embedded database per file, the simulator channel, and the
 * `FakeAssistantClient` — the real model is never called.
 *
 * FICTIONAL TEST DATA: the KB rows and decisions are written for these
 * checks only.
 */

export const AI_SIM_SECRET = 'inbox-ai-test-secret';
export const PASSWORD = 'inboxai1234';

/**
 * A string no real message holds, with no digit (the traceability guard
 * would refuse a number) and no automation word (the persona guard). It goes
 * into customer lines and into the assistant's own bubbles; it must surface
 * nowhere but the message table.
 */
export const SENTINEL = 'ZQXSENTINELWORDQZX';

export interface AiWorld {
  ctx: TestContext;
  oto: string;
  central: string;
  chalong: string;
  fake: FakeAssistantClient;
  logLines: string[];
  presigns: string[];
}

export const memoryStorage = (presigns: string[]): FileStorage => ({
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}?put`,
  presignedGet: async (objectKey) => {
    const link = `https://storage.test/oto-files-test/${objectKey}`;
    presigns.push(link);
    return link;
  },
  put: async () => {},
  remove: async () => {},
  probe: async () => ({ state: 'ready' }),
});

export async function aiWorld(): Promise<AiWorld> {
  const logLines: string[] = [];
  const presigns: string[] = [];
  const ctx = await createTestContext({
    env: {
      INBOX_SIMULATOR: 'on',
      INBOX_SIMULATOR_SECRET: AI_SIM_SECRET,
      INBOX_AI_ENABLED: 'true',
      // Required by the boot guard; under NODE_ENV=test no client is ever built from it.
      ANTHROPIC_API_KEY: 'unused-in-tests',
    },
    logCapture: { stream: { write: (line) => void logLines.push(line) }, level: 'debug' },
  });
  (ctx.app as unknown as { fileStorage: FileStorage }).fileStorage = memoryStorage(presigns);
  expect(ctx.app.inboxAi.client).toBeNull();
  const fake = new FakeAssistantClient();
  ctx.app.inboxAi.client = fake;
  // No jitter: typing time is exactly chars / 6 per second, at least 3 s.
  ctx.app.inboxAi.random = () => 0.5;
  return {
    ctx,
    oto: await operatorIdByName(ctx.db, OTO_OPERATOR_NAME),
    central: await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE),
    chalong: await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE),
    fake,
    logLines,
    presigns,
  };
}

let accountSeq = 0;

/** A simulator WhatsApp number of the park's, with the assistant's mode as given. */
export async function simAccount(
  w: AiWorld,
  opts: {
    branchId: string | null;
    aiMode?: AiMode;
    openingHours?: unknown;
    defaultCategory?: 'general' | 'birthdays' | 'marketing' | 'gm';
    /** The number's silence policy (SCRUM-220 playbook); absent = none. */
    silentIntents?: string[];
  },
): Promise<string> {
  const id = newId();
  accountSeq += 1;
  await w.ctx.db.insert(s.channelAccount).values({
    id,
    operatorId: w.oto,
    branchId: opts.branchId,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: `ai-test-wa-${accountSeq}-${id.slice(0, 8)}`,
    displayName: `AI Test ${accountSeq}`,
    defaultCategory: opts.defaultCategory ?? 'general',
    canReply: true,
    status: 'active',
    aiMode: opts.aiMode ?? 'live',
    openingHours: (opts.openingHours ?? null) as never,
    silencePolicy: opts.silentIntents ? { silentIntents: opts.silentIntents } : null,
  });
  return id;
}

export async function sim(w: AiWorld, accountId: string): Promise<SimulatorChannel> {
  const [row] = await w.ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, accountId)).limit(1);
  const found = w.ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!found) throw new Error('simulator off');
  return found;
}

let phoneSeq = 0;
/** A fresh customer phone: a new thread on every account. */
export function nextPhone(): string {
  phoneSeq += 1;
  return `6689${String(phoneSeq).padStart(7, '0')}`;
}

/**
 * A customer writes in through the real webhook; answers their thread on that
 * account. `at` is the provider's stamp on the line (whole seconds, as a
 * provider sends it): a test stamps a line earlier than the moment it arrives
 * to play a webhook that was in flight.
 */
export async function customer(
  w: AiWorld,
  accountId: string,
  from: string,
  text: string | { image: true },
  opts: { at?: Date } = {},
) {
  const channel = await sim(w, accountId);
  const stamp = opts.at ? { at: opts.at } : {};
  const played = channel.inbound(
    typeof text === 'string' ? { from, name: 'AI Test Guest', text, ...stamp } : { from, name: 'AI Test Guest', image: {}, ...stamp },
  );
  const res = await w.ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${accountId}`,
    headers: played.webhook.headers as Record<string, string>,
    payload: typeof played.webhook.rawBody === 'string' ? played.webhook.rawBody : Buffer.from(played.webhook.rawBody),
  });
  expect(res.statusCode).toBe(200);
  expect((res.json() as { outcome: string }).outcome).toBe('processed');
  const [row] = await w.ctx.db
    .select({ conv: s.conversation })
    .from(s.conversation)
    .innerJoin(s.contact, eq(s.contact.id, s.conversation.contactId))
    .where(and(eq(s.conversation.channelAccountId, accountId), eq(s.contact.externalHandle, `+${from}`)))
    .limit(1);
  return row!.conv;
}

export function decision(over: Partial<AiDecision> = {}): AiDecision {
  return {
    language: 'en',
    intent: 'greeting',
    certainty: 'sure',
    action: 'answer',
    grounding: [],
    bubbles: [`Hi! Welcome to OTO Play Park ${SENTINEL}, how can we help?`],
    sendBrochure: false,
    branchNamed: null,
    askBranch: false,
    reason: 'GREETING_ONLY',
    ...over,
  };
}

/** A moment `ms` from now: after a turn's debounce, or a line's typing time. */
export const later = (ms: number) => new Date(Date.now() + ms);

/** One tick of `job:inbox.ai`, at `at`. */
export function tick(w: AiWorld, at: Date): Promise<AiSweep> {
  return runInboxAiJob(
    w.ctx.db,
    {
      runtime: w.ctx.app.inboxAi,
      channels: w.ctx.app.inboxChannels,
      storage: w.ctx.app.fileStorage,
      log: w.ctx.app.log,
      now: () => at,
    },
    at,
  );
}

export async function turnsOf(w: AiWorld, conversationId: string) {
  return w.ctx.db
    .select()
    .from(s.aiTurn)
    .where(eq(s.aiTurn.conversationId, conversationId))
    .orderBy(asc(s.aiTurn.createdAt), asc(s.aiTurn.id));
}

export async function aiLines(w: AiWorld, conversationId: string) {
  return w.ctx.db
    .select()
    .from(s.message)
    .where(and(eq(s.message.conversationId, conversationId), eq(s.message.authorKind, 'ai')))
    .orderBy(asc(s.message.createdAt), asc(s.message.id));
}

export async function eventsOf(w: AiWorld, conversationId: string) {
  return w.ctx.db
    .select()
    .from(s.inboxEvent)
    .where(eq(s.inboxEvent.conversationId, conversationId))
    .orderBy(asc(s.inboxEvent.createdAt), asc(s.inboxEvent.id));
}

export async function conversationRow(w: AiWorld, id: string) {
  const [row] = await w.ctx.db.select().from(s.conversation).where(eq(s.conversation.id, id)).limit(1);
  return row!;
}

export async function activeSlots(w: AiWorld, conversationId: string) {
  return w.ctx.db
    .select()
    .from(s.assignment)
    .where(and(eq(s.assignment.conversationId, conversationId), isNull(s.assignment.releasedAt)))
    .orderBy(asc(s.assignment.slotIndex));
}

export async function teamOf(w: AiWorld, key: 'birthdays' | 'reception' | 'marketing' | 'gm', branchId: string | null = null) {
  const [t] = await w.ctx.db
    .select()
    .from(s.team)
    .where(
      and(
        eq(s.team.operatorId, w.oto),
        eq(s.team.key, key),
        branchId === null ? isNull(s.team.branchId) : eq(s.team.branchId, branchId),
      ),
    )
    .limit(1);
  return t!;
}

/** A staff account with one role at one scope, and a session minted for it. Answers [accountId, cookie]. */
export async function staff(
  w: AiWorld,
  phone: string,
  name: string,
  roleName: string,
  scope: { scopeType: 'operator' | 'branch' | 'department'; scopeId: string },
): Promise<[string, string]> {
  const employeeId = newId();
  await w.ctx.db.insert(s.employee).values({ id: employeeId, operatorId: w.oto, name, phone });
  const accountId = newId();
  await w.ctx.db.insert(s.account).values({
    id: accountId,
    operatorId: w.oto,
    employeeId,
    phone,
    passwordHash: await hash(PASSWORD),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  const [role] = await w.ctx.db
    .select({ id: s.role.id })
    .from(s.role)
    .where(and(eq(s.role.operatorId, w.oto), eq(s.role.name, roleName)))
    .limit(1);
  await w.ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId: role!.id, ...scope });
  const token = newSessionToken();
  await w.ctx.db.insert(s.session).values({
    id: newId(),
    accountId,
    tokenHash: hashToken(token),
    branchId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return [accountId, `${SESSION_COOKIE}=${token}`];
}

export async function call<T = Record<string, unknown>>(
  w: AiWorld,
  cookie: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await w.ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as T };
}

/** An approved knowledge-base entry (fictional test data). */
export async function kb(
  w: AiWorld,
  approver: string,
  entry: { key: string; topic: typeof s.kbEntry.$inferInsert.topic; language: 'en' | 'th' | 'ru'; question: string; body: string; branchId?: string | null },
): Promise<void> {
  await w.ctx.db.insert(s.kbEntry).values({
    id: newId(),
    operatorId: w.oto,
    branchId: entry.branchId ?? null,
    topic: entry.topic,
    key: entry.key,
    language: entry.language,
    question: entry.question,
    body: entry.body,
    status: 'approved',
    approvedByAccountId: approver,
    approvedAt: new Date(),
  });
}

/** Hours that are closed now in Bangkok: open half an hour, two hours from now, every day. */
export function closedNowHours(): Record<string, { open: string; close: string }> {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
  );
  const h = String((hour + 2) % 24).padStart(2, '0');
  const slot = { open: `${h}:00`, close: `${h}:30` };
  return { mon: slot, tue: slot, wed: slot, thu: slot, fri: slot, sat: slot, sun: slot };
}
