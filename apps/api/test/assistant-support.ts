import { hash } from '@node-rs/argon2';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  FakeAssistantClient,
  FakeToolLoopClient,
  type FakeToolLoopEntry,
  type InternalAnswer,
} from '@oto/assistant';
import { schema as s, type Db } from '@oto/db';
import { newId, type AssistantAskView, type Permission } from '@oto/shared';
import type { Env } from '../src/env';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  type TestContext,
} from './helpers';
import type { AiWorld } from './inbox-ai-support';

/**
 * The internal assistant's engine suites (SCRUM-591, round I2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §F.3 "I2"): one real
 * embedded database per file and `FakeToolLoopClient` — the real model is
 * never called. The runtime is switched on for the file explicitly (under
 * NODE_ENV=test it is off and has no client unless a suite says otherwise).
 *
 * FICTIONAL TEST DATA: the ZZ members, notes and answers are written for these
 * checks only.
 */

/**
 * A string no real record holds, with no digit (the traceability guard would
 * refuse a number) — it goes into a question, a member's notes, an answer and
 * a correction, and must surface nowhere but the ask-log's own rows.
 */
/**
 * The simulator's webhook secret for the ask world. This module imports
 * nothing from Vitest (nor from a module that does), so the live eval
 * (`scripts/assistant-eval.ts`, run by tsx) builds the same world.
 */
export const ASK_SIM_SECRET = 'assistant-ask-test-secret';

export const ASK_SENTINEL = 'ZQXASKSENTINELWORDQZX';
export const PASSWORD = 'assistant1234';

export interface AskWorld {
  ctx: TestContext;
  oto: string;
  central: string;
  chalong: string;
  logLines: string[];
}

export async function askWorld(opts: { env?: Partial<Record<keyof Env, string>> } = {}): Promise<AskWorld> {
  const logLines: string[] = [];
  const ctx = await createTestContext({
    env: {
      INTERNAL_AI_ENABLED: 'true',
      // Required by the boot guard; under NODE_ENV=test no client is ever built from it.
      ANTHROPIC_API_KEY: 'unused-in-tests',
      // The Inbox simulator, so a department's agent has real threads to count (golden Q10).
      INBOX_SIMULATOR: 'on',
      INBOX_SIMULATOR_SECRET: ASK_SIM_SECRET,
      // Round I4: a suite that reaches the OTO App names its fake origin here (the hand-off and its switch).
      ...(opts.env ?? {}),
    },
    logCapture: { stream: { write: (line) => void logLines.push(line) }, level: 'debug' },
  });
  // Off by construction until a suite injects the fake.
  if (ctx.app.internalAi.client !== null) throw new Error('askWorld: the test runtime built a model client');
  if (!ctx.app.internalAi.config.enabled) throw new Error('askWorld: the internal assistant is not enabled');
  return {
    ctx,
    oto: await operatorIdByName(ctx.db, OTO_OPERATOR_NAME),
    central: await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE),
    chalong: await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE),
    logLines,
  };
}

/** The inbox suites' helpers take an `AiWorld`; they read only its context and operator. */
export function asAiWorld(w: AskWorld): AiWorld {
  return { ...w, fake: new FakeAssistantClient(), presigns: [] } as AiWorld;
}

/** Installs a fresh scripted model for the next ask(s). */
export function script(w: AskWorld, ...steps: FakeToolLoopEntry[]): FakeToolLoopClient {
  const fake = new FakeToolLoopClient(steps);
  w.ctx.app.internalAi.client = fake;
  return fake;
}

export function final(answer: string, links: InternalAnswer['links'] = [], language: InternalAnswer['language'] = 'en'): FakeToolLoopEntry {
  return { kind: 'final', answer: { answer, links, language } };
}

export function tool(name: string, input: unknown, extra: Partial<FakeToolLoopEntry> = {}): FakeToolLoopEntry {
  return { kind: 'tool_use', calls: [{ name, input }], ...extra } as FakeToolLoopEntry;
}

export async function ask(
  w: AskWorld,
  cookie: string,
  question: string,
  id: string = newId(),
): Promise<{ status: number; body: AssistantAskView & { error?: { code: string; message: string } }; headers: Record<string, unknown> }> {
  const res = await w.ctx.app.inject({
    method: 'POST',
    url: '/assistant/asks',
    headers: { cookie },
    payload: { id, question },
  });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

export async function call<T = Record<string, unknown>>(
  w: AskWorld,
  cookie: string,
  method: 'GET' | 'PATCH' | 'POST',
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

/**
 * The tool results the model was handed, in order: each `{data: …}` as the
 * loop sent it (parsed back from the inert JSON).
 */
export function toolResultsSeen(fake: FakeToolLoopClient): Array<{ data: unknown; isError: boolean }> {
  const out: Array<{ data: unknown; isError: boolean }> = [];
  const last = fake.calls[fake.calls.length - 1];
  if (!last) return out;
  for (const m of last.messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type !== 'tool_result') continue;
      const content = typeof block.content === 'string' ? block.content : '';
      out.push({ data: (JSON.parse(content) as { data: unknown }).data, isError: block.is_error === true });
    }
  }
  return out;
}

export async function askRow(db: Db, id: string) {
  const [row] = await db.select().from(s.ask).where(eq(s.ask.id, id)).limit(1);
  return row;
}

export async function toolRows(db: Db, askId: string) {
  return db.select().from(s.toolCall).where(eq(s.toolCall.askId, askId)).orderBy(asc(s.toolCall.seq));
}

let phoneSeq = 0;
/** A fresh staff phone per account. */
export function staffPhone(): string {
  phoneSeq += 1;
  return `+668200${String(phoneSeq).padStart(5, '0')}`;
}

/**
 * A staff account with one role at one scope, and a session minted for it
 * (seated at `seat`). Answers its account id, session id and cookie.
 */
export async function staff(
  w: AskWorld,
  name: string,
  roleName: string,
  scope: { scopeType: 'operator' | 'branch' | 'department'; scopeId: string },
  seat: string | null = null,
): Promise<{ accountId: string; sessionId: string; cookie: string }> {
  const phone = staffPhone();
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
    .where(and(eq(s.role.name, roleName), sql`(${s.role.operatorId} = ${w.oto} or ${s.role.operatorId} is null)`))
    .limit(1);
  if (!role) throw new Error(`no role ${roleName}`);
  await w.ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId: role.id, ...scope });
  return { accountId, ...(await mintSession(w, accountId, seat)) };
}

/** A fresh session for an existing account (seated at `seat`): its id and cookie. */
export async function mintSession(
  w: AskWorld,
  accountId: string,
  seat: string | null = null,
): Promise<{ sessionId: string; cookie: string }> {
  const token = newSessionToken();
  const sessionId = newId();
  await w.ctx.db.insert(s.session).values({
    id: sessionId,
    accountId,
    tokenHash: hashToken(token),
    branchId: seat,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { sessionId, cookie: `${SESSION_COOKIE}=${token}` };
}

/** An operator role of the test's own, holding exactly these permissions. */
export async function customRole(w: AskWorld, name: string, permissions: Permission[]): Promise<void> {
  const id = newId();
  await w.ctx.db.insert(s.role).values({ id, operatorId: w.oto, name, description: 'test role' });
  await w.ctx.db.insert(s.rolePermission).values(permissions.map((permission) => ({ id: newId(), roleId: id, permission })));
}

const TILE_ROLE = 'zz_oto_app_tile';

/**
 * The OTO App tile for an account (round I4): `app:oto_app:access` at one
 * branch, through a role of the test's own that holds nothing else. No seeded
 * staff bundle carries the tile; on a deployment it is assigned by an
 * administrator, and the fixture does the same.
 */
export async function grantOtoAppTile(w: AskWorld, accountId: string, branchId: string): Promise<void> {
  let [role] = await w.ctx.db
    .select({ id: s.role.id })
    .from(s.role)
    .where(and(eq(s.role.operatorId, w.oto), eq(s.role.name, TILE_ROLE)))
    .limit(1);
  if (!role) {
    await customRole(w, TILE_ROLE, ['app:oto_app:access']);
    [role] = await w.ctx.db
      .select({ id: s.role.id })
      .from(s.role)
      .where(and(eq(s.role.operatorId, w.oto), eq(s.role.name, TILE_ROLE)))
      .limit(1);
  }
  await w.ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId: role!.id, scopeType: 'branch', scopeId: branchId });
}

/** A ZZ family on the register, with a fictional note and two children (one with an allergy). */
export async function zzFamily(
  w: AskWorld,
  opts: { phone: string; name: string; notes: string },
): Promise<{ memberId: string }> {
  const memberId = newId();
  await w.ctx.db.insert(s.member).values({
    id: memberId,
    operatorId: w.oto,
    phone: opts.phone,
    name: opts.name,
    nickname: opts.name,
    notes: opts.notes,
  });
  await w.ctx.db.insert(s.child).values([
    { id: newId(), memberId, name: 'ZZ Ploy', ageYears: 6, allergies: 'ZZ peanuts' },
    { id: newId(), memberId, name: 'ZZ Tonkla', ageYears: 4 },
  ]);
  return { memberId };
}

/** How many rows of each record ABOUT the platform hold the string, and how many log lines. */
export async function askLeaks(db: Db, needle: string, logLines: readonly string[]) {
  const like = `%${needle}%`;
  const count = async (q: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(q)).rows[0]?.n ?? 0);
  return {
    audit: await count(
      sql`select count(*)::int as n from core.audit_log where coalesce(before::text,'') || coalesce(after::text,'') like ${like}`,
    ),
    ops: await count(
      sql`select count(*)::int as n from core.ops_run where coalesce(detail::text,'') || coalesce(error_message,'') like ${like}`,
    ),
    replayStore: await count(
      sql`select count(*)::int as n from core.idempotency_key where coalesce(response_body::text,'') like ${like}`,
    ),
    toolCalls: await count(sql`select count(*)::int as n from assistant.tool_call where args::text like ${like}`),
    logs: logLines.filter((l) => l.includes(needle)).length,
  };
}

export const NO_ASK_LEAKS = { audit: 0, ops: 0, replayStore: 0, toolCalls: 0, logs: 0 };
