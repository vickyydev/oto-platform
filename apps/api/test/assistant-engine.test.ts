import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeToolLoopClient, INTERNAL_LINES } from '@oto/assistant';
import { schema as s } from '@oto/db';
import {
  ASSISTANT_AUDIT_ACTIONS,
  ASSISTANT_AUDIT_ACTIONS_SHOWN,
  ASSISTANT_SUMMARY_MAX_BYTES,
  ASSISTANT_TOOLS,
  isoDateInTz,
  newId,
} from '@oto/shared';
import { hashToken } from '../src/plugins/session';
import { assertGetRoute, matchesRoute } from '../src/services/assistant/call-platform';
import { askAssistant, ASSISTANT_GATE_LINES, circuitOpen, groundedLinks, isBareFollowUp, type AskCaller } from '../src/services/assistant/engine';
import { toJsonSchema } from '../src/services/assistant/json-schema';
import {
  PLATFORM_TOOLS,
  PLATFORM_TOOL_ADAPTERS,
  auditInstant,
  auditNothingMatched,
  dayWords,
  fitSummary,
  monthWords,
  questionCalendar,
  summaryBytes,
} from '../src/services/assistant/tools';
import { resolveEffectivePermissions } from '../src/services/permissions';
import {
  ASK_SENTINEL,
  NO_ASK_LEAKS,
  asAiWorld,
  ask,
  askLeaks,
  askRow,
  askWorld,
  call,
  customRole,
  final,
  script,
  staff,
  tool,
  toolResultsSeen,
  toolRows,
  zzFamily,
  type AskWorld,
} from './assistant-support';
import { BRANCH_MANAGER, RECEPTION, signInAs, teardownAll } from './helpers';
import { customer, nextPhone, simAccount, teamOf } from './inbox-ai-support';

/**
 * SCRUM-591 — THE INTERNAL ASSISTANT'S ENGINE, round I2 (plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.2, §D, §E, §F.3 "I2").
 *
 * The rule under test is the spec's: the assistant reads the platform AS THE
 * SIGNED-IN PERSON, never with a credential of its own. So the centre of this
 * file is a comparison: the same tool calls made for a reception session and
 * for a branch manager's give exactly what those two sessions get when they
 * call the routes themselves — the same statuses, the same refusal sentences
 * word for word, the same rows. Around it: the census that keeps the one
 * in-process request in one file, the gates (switches, caps, the breaker, the
 * permission switch), the session's own state, resends, and the sentinel —
 * no question or answer text in audit, ops, the replay store, tool-call rows
 * or a log line.
 */

let w: AskWorld;
let receptionCookie: string;
let managerCookie: string;
let somchai: string;

beforeAll(async () => {
  w = await askWorld();
  receptionCookie = await signInAs(w.ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(w.ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  ({ memberId: somchai } = await zzFamily(w, {
    phone: '+66812340001',
    name: 'ZZ Somchai Family',
    notes: 'ZZ prefers the quiet room',
  }));
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

const API_SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** The engine called directly, as the route would call it for this session: for a test that swaps the app. */
async function callerFor(cookie: string, phone: string): Promise<AskCaller> {
  const [acc] = await w.ctx.db.select().from(s.account).where(eq(s.account.phone, phone)).limit(1);
  const token = cookie.split('=')[1]!;
  const [sess] = await w.ctx.db.select().from(s.session).where(eq(s.session.tokenHash, hashToken(token))).limit(1);
  return {
    auth: {
      accountId: acc!.id,
      operatorId: acc!.operatorId,
      sessionId: sess!.id,
      branchId: sess!.branchId,
      stationId: null,
      status: 'active',
      mustChangePassword: false,
      isPlatformAdmin: false,
      lockedAt: null,
    },
    effective: await resolveEffectivePermissions(w.ctx.db, acc!.id),
    requestId: `req-${newId()}`,
    token,
  };
}

describe('the census (§F.3, R4)', () => {
  it('no production file but call-platform.ts makes an in-process request', () => {
    // A TEXT match: `app['inject'](` or an aliased method would pass it. The second line is the
    // route census (`assistant-registry.test.ts`): every tool route is a registered, guarded GET,
    // so whatever makes the request, only those routes answer it.
    const calling = sourceFiles(API_SRC)
      .filter((f) => /\.inject\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(API_SRC, f).replace(/\\/g, '/'));
    expect(calling).toEqual(['services/assistant/call-platform.ts']);
  });

  it('a :param is one plain segment: no encoding, no dot segment, never a sibling route’s literal', () => {
    const uuid = newId();
    expect(matchesRoute(`/members/${uuid}`, 'GET /members/:id')).toBe(true);
    // `/members/lookup` is the register's own route, not the member whose id is "lookup".
    expect(matchesRoute('/members/lookup', 'GET /members/:id')).toBe(false);
    // An encoded slash is still a slash to the next decoder.
    expect(matchesRoute('/members/a%2Fb', 'GET /members/:id')).toBe(false);
    expect(matchesRoute('/members/.', 'GET /members/:id')).toBe(false);
    expect(matchesRoute('/members/..', 'GET /members/:id')).toBe(false);
    expect(matchesRoute(`/branches/${uuid}/occupancy`, 'GET /branches/:id/occupancy')).toBe(true);
  });

  it('call-platform.ts injects GET and nothing else', () => {
    const src = readFileSync(join(API_SRC, 'services/assistant/call-platform.ts'), 'utf8');
    const methods = [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
    expect(methods).toEqual(['GET']);
  });

  it('registers a platform adapter for exactly the eleven platform tools; the OTO App tools live in tools-otoapp.ts (round I4)', () => {
    const platform = ASSISTANT_TOOLS.filter((t) => t.system === 'platform').map((t) => t.name);
    expect(PLATFORM_TOOL_ADAPTERS.map((a) => a.name).sort()).toEqual([...platform].sort());
    // Ten from round I2, and inbox.dashboard from the test night of 2026-10-21 (W6).
    expect(platform).toHaveLength(11);
    expect(PLATFORM_TOOL_ADAPTERS.some((a) => a.name.startsWith('oto.'))).toBe(false);
  });

  it('refuses a tool route that is not a GET when the registry is built', () => {
    expect(() => assertGetRoute('x.y', 'POST /members')).toThrow(/not a GET/);
    expect(() => assertGetRoute('x.y', 'GET /members?q=1')).toThrow(/not a GET/);
    expect(() => assertGetRoute('x.y', 'GET /members/lookup')).not.toThrow();
  });

  it('builds every adapter URL inside its own route templates, from validated input only', () => {
    const uuid = newId();
    const samples: Record<string, unknown> = {
      'audit.search': { action: 'member.create', from: '2026-10-01', to: '2026-10-21T04:32' },
      'branches.list': {},
      'checkin.board': { branchId: uuid },
      'inbox.dashboard': {},
      'inbox.queue': { tab: 'mine' },
      'me.whoami': {},
      'members.get': { memberId: uuid, include: ['medical_notes'] },
      'members.lookup': { phone: '081 234 5678' },
      'members.search': { q: 'a/../b?c=d' },
      'occupancy.now': { branchId: uuid },
      'ops.failures': { windowHours: 6 },
    };
    for (const a of PLATFORM_TOOL_ADAPTERS) {
      const input = a.input.parse(samples[a.name]);
      const urls = a.urls(input as never);
      expect(urls.length, a.name).toBe(a.routes.length);
      for (const url of urls) expect(a.routes.some((r) => matchesRoute(url, r)), `${a.name}: ${url}`).toBe(true);
    }
    // A path argument is one segment, and a strict schema refuses anything else.
    expect(PLATFORM_TOOLS.get('occupancy.now')!.input.safeParse({ branchId: '../../audit' }).success).toBe(false);
    expect(PLATFORM_TOOLS.get('members.search')!.input.safeParse({ q: 'x', url: '/audit' }).success).toBe(false);
    expect(matchesRoute('/branches/x/occupancy/../../audit', 'GET /branches/:id/occupancy')).toBe(false);
  });

  it('tells the model every input schema exactly, strict', () => {
    for (const a of PLATFORM_TOOL_ADAPTERS) {
      const json = toJsonSchema(a.input);
      expect(json.type, a.name).toBe('object');
      expect(json.additionalProperties, a.name).toBe(false);
    }
    expect(toJsonSchema(PLATFORM_TOOLS.get('occupancy.now')!.input)).toEqual({
      type: 'object',
      properties: { branchId: { type: 'string', format: 'uuid' } },
      required: ['branchId'],
      additionalProperties: false,
    });
  });

  it('sizes a summary at 4 KB at most, cutting rows and saying so', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ name: `ZZ person ${i}`, note: 'x'.repeat(40) }));
    const fitted = fitSummary({ data: { rows }, listKey: 'rows', rows: 200 });
    expect(summaryBytes(fitted)).toBeLessThanOrEqual(ASSISTANT_SUMMARY_MAX_BYTES);
    expect(fitted.truncated).toBe(true);
    expect((fitted.data as { rows: unknown[] }).rows.length + (fitted.more ?? 0)).toBe(200);
  });
});

describe('as the person (§B.2, §F.3)', () => {
  /** The three tools of the comparison, the same for both askers. */
  const steps = (chalong: string) => [
    tool('members.search', { q: 'ZZ Somchai' }),
    tool('audit.search', {}),
    tool('occupancy.now', { branchId: chalong }),
    final('Here is what I could see.'),
  ];

  async function direct(cookie: string, url: string) {
    return call<{ error?: { code: string; message: string }; members?: Array<{ id: string }> }>(w, cookie, 'GET', url);
  }

  it('a reception session and a branch manager get exactly what their own sessions get from the routes', async () => {
    const outcomes: Record<string, unknown> = {};
    for (const [who, cookie] of [
      ['reception', receptionCookie],
      ['manager', managerCookie],
    ] as const) {
      const fake = script(w, ...steps(w.chalong));
      const res = await ask(w, cookie, 'Find the Somchai family, the recent audit trail, and how full Chalong is.');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = await toolRows(w.ctx.db, res.body.id);
      const seen = toolResultsSeen(fake);
      expect(rows.map((r) => r.tool)).toEqual(['members.search', 'audit.search', 'occupancy.now']);

      // The same three reads, made by the session itself.
      const search = await direct(cookie, '/members?q=ZZ%20Somchai&limit=20');
      const trail = await direct(cookie, '/audit?limit=20');
      const occupancy = await direct(cookie, `/branches/${w.chalong}/occupancy`);
      const directs = [search, trail, occupancy];

      for (const [i, d] of directs.entries()) {
        expect(rows[i]!.status, `${who} ${rows[i]!.tool}`).toBe(d.status);
        if (d.status === 200) {
          expect(seen[i]!.isError).toBe(false);
        } else {
          // The route's own sentence, word for word, to the model and on the ask.
          expect(seen[i]!.isError).toBe(true);
          expect((seen[i]!.data as { error: { message: string } }).error.message).toBe(d.body.error!.message);
          expect(res.body.refusals.find((r) => r.tool === rows[i]!.tool)).toMatchObject({
            status: d.status,
            code: d.body.error!.code,
            message: d.body.error!.message,
            line: `Platform: ${d.body.error!.message}`,
          });
        }
      }
      // The rows the model was handed are the rows the screen's own call answers.
      if (search.status === 200) {
        const ids = ((seen[0]!.data as { data: { matches: Array<{ id: string }> } }).data.matches).map((m) => m.id);
        expect(ids).toEqual(search.body.members!.map((m) => m.id));
        expect(ids).toContain(somchai);
      }
      outcomes[who] = rows.map((r) => r.status);
    }
    // And they differ, because the two people differ: the register and the trail are a manager's.
    expect(outcomes).toEqual({ reception: [403, 403, 403], manager: [200, 200, 403] });
  });

  it('a cross-branch tool call returns the "but not at …" refusal verbatim (§D.4)', async () => {
    script(w, tool('occupancy.now', { branchId: w.chalong }), final('That park is not mine to see.'));
    const res = await ask(w, managerCookie, 'How many children are inside at Chalong right now?');
    expect(res.body.refusals).toEqual([
      expect.objectContaining({
        tool: 'occupancy.now',
        system: 'platform',
        status: 403,
        message: 'You hold pos:checkin:read, but not at Oto Play Park, Robinson Chalong',
        line: 'Platform: You hold pos:checkin:read, but not at Oto Play Park, Robinson Chalong',
      }),
    ]);
    expect(res.body.state).toBe('refused');
    expect(res.body.reason).toBe('TOOL_REFUSED');
  });

  it('a session revoked mid-ask is refused at the next tool call', async () => {
    const me = await staff(w, 'ZZ Revoked', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    const fake = script(
      w,
      tool('me.whoami', {}),
      tool('me.whoami', {}, {
        during: async () => {
          await w.ctx.db.update(s.session).set({ revokedAt: new Date() }).where(eq(s.session.id, me.sessionId));
        },
      }),
      final('You were signed out.'),
    );
    const res = await ask(w, me.cookie, 'Who am I?');
    expect(res.status).toBe(200);
    const rows = await toolRows(w.ctx.db, res.body.id);
    expect(rows.map((r) => r.status)).toEqual([200, 401]);
    expect(res.body.refusals).toEqual([expect.objectContaining({ tool: 'me.whoami', status: 401, message: 'Not signed in' })]);
    expect(toolResultsSeen(fake)[1]!.isError).toBe(true);
    // A DESIGN DECISION, pinned: the ask still closes `answered`, with prose the model wrote after
    // the revocation, and the answer goes to the connection that authenticated at the start of the
    // ask. Nothing read after the revocation is in it — the second call got 401 and no data — and
    // the first call's summary was the person's to see when they asked.
    expect(res.body.state).toBe('answered');
    expect(res.body.answer).toBe('You were signed out.');
  });

  it('a locked session is refused at the ask route, before any model call', async () => {
    const me = await staff(w, 'ZZ Locked', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    await w.ctx.db.update(s.session).set({ lockedAt: new Date() }).where(eq(s.session.id, me.sessionId));
    const fake = script(w);
    const id = newId();
    const res = await ask(w, me.cookie, 'Anything', id);
    expect(res.status).toBe(423);
    expect(res.body.error!.code).toBe('SESSION_LOCKED');
    expect(fake.calls).toHaveLength(0);
    expect(await askRow(w.ctx.db, id)).toBeUndefined();
  });

  it('a session owing a password change is refused at the ask route', async () => {
    const me = await staff(w, 'ZZ Temp', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    await w.ctx.db.update(s.account).set({ mustChangePassword: true }).where(eq(s.account.id, me.accountId));
    const fake = script(w);
    const res = await ask(w, me.cookie, 'Anything');
    expect(res.status).toBe(403);
    expect(res.body.error!.code).toBe('MUST_CHANGE_PASSWORD');
    expect(fake.calls).toHaveLength(0);
  });

  it('arguments the tool schema refuses make no request and are not a refusal', async () => {
    const fake = script(w, tool('occupancy.now', { branchId: 'Chalong' }), final('I need the park’s id.'));
    const res = await ask(w, managerCookie, 'How full is Chalong?');
    const rows = await toolRows(w.ctx.db, res.body.id);
    expect(rows).toEqual([
      expect.objectContaining({ tool: 'occupancy.now', status: null, code: 'INVALID_ARGUMENTS', args: {} }),
    ]);
    expect(res.body.refusals).toEqual([]);
    expect(toolResultsSeen(fake)[0]).toEqual({
      isError: true,
      data: { error: { code: 'INVALID_ARGUMENTS', message: 'The arguments do not match the tool’s schema.' } },
    });
  });

  it('a tool route answering 5xx closes the ask as TOOL_ERROR, recorded, with no guess', async () => {
    const failing = {
      inject: async () => ({ statusCode: 500, body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }) }),
    } as unknown as FastifyInstance;
    const fake = new FakeToolLoopClient([tool('me.whoami', {}), final('never reached')]);
    const runtime = { config: { ...w.ctx.app.internalAi.config }, client: fake };
    const view = await askAssistant(
      { app: failing, db: w.ctx.db, runtime },
      await callerFor(receptionCookie, RECEPTION.phone),
      { id: newId(), question: 'Who am I?' },
    );
    expect(view).toMatchObject({ state: 'failed', reason: 'TOOL_ERROR', answer: INTERNAL_LINES.failed.en });
    expect((await toolRows(w.ctx.db, view.id)).map((r) => [r.status, r.code])).toEqual([[500, 'INTERNAL']]);
    expect(fake.remaining).toBe(1);
  });

  it('a tool route that stalls past the ask’s remaining wall time closes the ask as WALL_TIME without waiting for it', async () => {
    const fake = new FakeToolLoopClient([tool('me.whoami', {}, { latencyMs: 0 }), final('never reached')]);
    const stalling = {
      inject: () => {
        // The route takes the rest of the ask's wall time, in the fake's virtual clock, and never answers.
        fake.advance(60_000);
        return new Promise(() => {});
      },
    } as unknown as FastifyInstance;
    const runtime = { config: { ...w.ctx.app.internalAi.config, wallMs: 1_000 }, client: fake };
    const started = Date.now();
    const view = await askAssistant(
      { app: stalling, db: w.ctx.db, runtime },
      await callerFor(receptionCookie, RECEPTION.phone),
      { id: newId(), question: 'Who am I?' },
    );
    // Closed by the race on the remaining wall time (1 s here), not by the stall (never).
    expect(Date.now() - started).toBeLessThan(10_000);
    // No screen was reached, so the digging line stands alone as a sentence.
    expect(view).toMatchObject({ state: 'failed', reason: 'WALL_TIME', answer: INTERNAL_LINES.tooMuchDiggingNoLink.en, links: [] });
    expect(view.answer).not.toMatch(/:\s*$/);
    expect((await toolRows(w.ctx.db, view.id)).map((r) => [r.status, r.code])).toEqual([[null, 'WALL_TIME']]);
    expect(fake.remaining).toBe(1);
  }, 30_000);
});

describe('a resend of the same id (§D.1)', () => {
  it('is answered from the ask row: one row, one model run, x-oto-replay', async () => {
    const fake = script(w, tool('me.whoami', {}), final('You are at Central Floresta.'));
    const id = newId();
    const first = await ask(w, managerCookie, 'Where am I seated?', id);
    expect(first.status).toBe(200);
    const second = await ask(w, managerCookie, 'Where am I seated?', id);
    expect(second.status).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(fake.calls).toHaveLength(2);
    expect(await w.ctx.db.select().from(s.ask).where(eq(s.ask.id, id))).toHaveLength(1);
    const runs = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), sql`${s.opsRun.detail}->>'askId' = ${id}`));
    expect(runs).toHaveLength(1);
  });

  it('while the ask is still running is 409 ASK_IN_FLIGHT; long abandoned, it is closed as failed', async () => {
    const [acc] = await w.ctx.db.select().from(s.account).where(eq(s.account.phone, BRANCH_MANAGER.phone)).limit(1);
    const running = newId();
    await w.ctx.db.insert(s.ask).values({ id: running, operatorId: w.oto, accountId: acc!.id, question: 'ZZ in flight' });
    const res = await ask(w, managerCookie, 'ZZ in flight', running);
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('ASK_IN_FLIGHT');
    // Left `asking`, the row would count against the in-flight cap for the rest of the file.
    await w.ctx.db
      .update(s.ask)
      .set({ state: 'failed', reason: 'ABANDONED', answer: 'ZZ closed by the test' })
      .where(eq(s.ask.id, running));

    const gone = newId();
    const old = new Date(Date.now() - 3_600_000);
    await w.ctx.db
      .insert(s.ask)
      .values({ id: gone, operatorId: w.oto, accountId: acc!.id, question: 'ZZ abandoned', createdAt: old, updatedAt: old });
    const again = await ask(w, managerCookie, 'ZZ abandoned', gone);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ state: 'failed', reason: 'ABANDONED' });
  });

  it("an id that names somebody else's ask is refused, and nothing is written", async () => {
    script(w, final('Hello.'));
    const id = newId();
    expect((await ask(w, managerCookie, 'Hello?', id)).status).toBe(200);
    const fake = script(w);
    const res = await ask(w, receptionCookie, 'Hello?', id);
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('ID_IN_USE');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('switches, caps and the breaker (§E.2)', () => {
  it('the kill switch answers the fixed line with no model call', async () => {
    const fake = script(w);
    w.ctx.app.internalAi.config.enabled = false;
    try {
      const res = await ask(w, receptionCookie, 'Are you there?');
      expect(res.body).toMatchObject({ state: 'off', reason: 'DISABLED', answer: INTERNAL_LINES.off.en, toolCalls: [] });
      expect(fake.calls).toHaveLength(0);
    } finally {
      w.ctx.app.internalAi.config.enabled = true;
    }
  });

  it('no client to ask is switched off too (a suite that forgets the fake gets silence)', async () => {
    w.ctx.app.internalAi.client = null;
    const res = await ask(w, receptionCookie, 'วันนี้เป็นยังไง');
    expect(res.body).toMatchObject({ state: 'off', reason: 'NO_CLIENT', answer: INTERNAL_LINES.off.th });
  });

  it('the permission switch: without assistant:ask:use the route refuses', async () => {
    await customRole(w, 'zz_no_assistant', ['pos:member:read']);
    const me = await staff(w, 'ZZ Switched Off', 'zz_no_assistant', { scopeType: 'branch', scopeId: w.central }, w.central);
    const fake = script(w);
    const res = await ask(w, me.cookie, 'Hello?');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Missing permission assistant:ask:use' });
    expect(fake.calls).toHaveLength(0);
  });

  it('the person’s daily cap: capped with the fixed line, no model call, raised once', async () => {
    const me = await staff(w, 'ZZ Busy', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    const cfg = w.ctx.app.internalAi.config;
    const before = cfg.personDailyCap;
    cfg.personDailyCap = 1;
    try {
      script(w, final('Hello.'));
      expect((await ask(w, me.cookie, 'One')).body.state).toBe('answered');
      const fake = script(w);
      const second = await ask(w, me.cookie, 'Two');
      const third = await ask(w, me.cookie, 'Three');
      for (const r of [second, third]) {
        expect(r.body).toMatchObject({ state: 'capped', reason: 'CAP_PERSON', answer: ASSISTANT_GATE_LINES.capPerson.en });
      }
      expect(fake.calls).toHaveLength(0);
      const raised = await w.ctx.db
        .select()
        .from(s.opsRun)
        .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), eq(s.opsRun.errorCode, 'CAP_PERSON')));
      expect(raised).toHaveLength(1);
    } finally {
      cfg.personDailyCap = before;
    }
  });

  it('the operator’s ask and token caps: capped, raised once each', async () => {
    const cfg = w.ctx.app.internalAi.config;
    const before = { asks: cfg.dailyAskCap, tokens: cfg.dailyTokenCap };
    const fake = script(w);
    try {
      cfg.dailyAskCap = 0;
      for (const q of ['A', 'B']) {
        expect((await ask(w, receptionCookie, q)).body).toMatchObject({
          state: 'capped',
          reason: 'CAP_DAILY',
          answer: ASSISTANT_GATE_LINES.capOperator.en,
        });
      }
      cfg.dailyAskCap = before.asks;
      cfg.dailyTokenCap = 0;
      expect((await ask(w, receptionCookie, 'C')).body).toMatchObject({ state: 'capped', reason: 'CAP_TOKENS' });
      expect(fake.calls).toHaveLength(0);
      for (const word of ['CAP_DAILY', 'CAP_TOKENS']) {
        const raised = await w.ctx.db
          .select()
          .from(s.opsRun)
          .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), eq(s.opsRun.errorCode, word)));
        expect(raised, word).toHaveLength(1);
      }
    } finally {
      cfg.dailyAskCap = before.asks;
      cfg.dailyTokenCap = before.tokens;
    }
  });

  it('asks running at once: past the person’s cap the next ask is BUSY before any model call, raised once', async () => {
    const me = await staff(w, 'ZZ Parallel', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    const cfg = w.ctx.app.internalAi.config;
    const before = cfg.concurrentPerPerson;
    cfg.concurrentPerPerson = 1;
    try {
      let second: Awaited<ReturnType<typeof ask>> | undefined;
      const fake = script(
        w,
        tool('me.whoami', {}, {
          during: async () => {
            // While the first ask's model is "thinking", the same person asks again.
            second = await ask(w, me.cookie, 'Two');
          },
        }),
        final('One.'),
      );
      const first = await ask(w, me.cookie, 'One');
      expect(first.body.state).toBe('answered');
      expect(second!.status).toBe(200);
      expect(second!.body).toMatchObject({ state: 'capped', reason: 'BUSY', answer: ASSISTANT_GATE_LINES.busy.en, toolCalls: [] });
      // The first ask's two model calls, and none for the second: it never reached the client.
      expect(fake.calls).toHaveLength(2);
      expect(fake.remaining).toBe(0);
      expect((await askRow(w.ctx.db, second!.body.id))!.personaVersion).toBeNull();
      const raised = await w.ctx.db
        .select()
        .from(s.opsRun)
        .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), eq(s.opsRun.errorCode, 'BUSY')));
      expect(raised).toHaveLength(1);
    } finally {
      cfg.concurrentPerPerson = before;
    }
  });

  it('asks running at once: past the operator’s cap another person’s ask is BUSY too', async () => {
    const one = await staff(w, 'ZZ Parallel One', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    const two = await staff(w, 'ZZ Parallel Two', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    const cfg = w.ctx.app.internalAi.config;
    const before = cfg.concurrentPerOperator;
    cfg.concurrentPerOperator = 1;
    try {
      let other: Awaited<ReturnType<typeof ask>> | undefined;
      const fake = script(
        w,
        tool('me.whoami', {}, {
          during: async () => {
            other = await ask(w, two.cookie, 'Me too');
          },
        }),
        final('One.'),
      );
      expect((await ask(w, one.cookie, 'One')).body.state).toBe('answered');
      expect(other!.body).toMatchObject({ state: 'capped', reason: 'BUSY', answer: ASSISTANT_GATE_LINES.busy.en });
      expect(fake.calls).toHaveLength(2);
      // Raised once a day for the operator: the earlier BUSY already did.
      const raised = await w.ctx.db
        .select()
        .from(s.opsRun)
        .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), eq(s.opsRun.errorCode, 'BUSY')));
      expect(raised).toHaveLength(1);
    } finally {
      cfg.concurrentPerOperator = before;
    }
  });

  it('the wall time ends the ask with the fixed line before the next tool runs', async () => {
    const fake = script(w, tool('me.whoami', {}, { latencyMs: 50_000 }), final('never'));
    const res = await ask(w, receptionCookie, 'Who am I?');
    // No tool ran, so no screen was gathered: the line stands alone, no colon, and the ask is failed.
    expect(res.body).toMatchObject({ state: 'failed', reason: 'WALL_TIME', answer: INTERNAL_LINES.tooMuchDiggingNoLink.en, links: [] });
    expect(res.body.answer).not.toMatch(/:\s*$/);
    expect(await toolRows(w.ctx.db, res.body.id)).toEqual([]);
    expect(fake.remaining).toBe(1);
  });

  it('the wall time after a tool already reached a screen: the digging line with its colon, the link under it, link_only', async () => {
    const fake = script(w, tool('me.whoami', {}), tool('me.whoami', {}, { latencyMs: 50_000 }), final('never'));
    const res = await ask(w, receptionCookie, 'Who am I, twice?');
    expect(res.body).toMatchObject({ state: 'link_only', reason: 'WALL_TIME', answer: INTERNAL_LINES.tooMuchDigging.en });
    expect(res.body.answer).toMatch(/:$/);
    expect(res.body.links.map((l) => l.key)).toEqual(['launcher.account']);
    expect((await toolRows(w.ctx.db, res.body.id)).map((r) => r.status)).toEqual([200]);
    expect(fake.remaining).toBe(1);
  });

  it('the breaker: five provider failures in a row pause the assistant, raised once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      script(w, { kind: 'timeout' });
      const res = await ask(w, receptionCookie, 'Are you there?');
      expect(res.body).toMatchObject({ state: 'failed', reason: 'PROVIDER_TIMEOUT', answer: INTERNAL_LINES.failed.en });
      ids.push(res.body.id);
    }
    const fake = script(w);
    const paused = await ask(w, receptionCookie, 'Are you there now?');
    expect(paused.body).toMatchObject({ state: 'off', reason: 'CIRCUIT_OPEN' });
    expect(fake.calls).toHaveLength(0);
    const raised = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), eq(s.opsRun.errorCode, 'CIRCUIT_OPEN')));
    expect(raised).toHaveLength(1);
    const failedRuns = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), eq(s.opsRun.errorCode, 'PROVIDER_TIMEOUT')));
    expect(failedRuns).toHaveLength(5);
    // Ten minutes later the breaker is closed again. The window is on `created_at`: an ask's loop
    // ends within created_at + the wall time, so that is when the failure happened.
    await w.ctx.db
      .update(s.ask)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(inArray(s.ask.id, ids));
    expect(await circuitOpen(w.ctx.db, w.oto, new Date())).toBe(false);
    // Rating the five now bumps their `updated_at` to now. Feedback is the asker's verdict on an
    // old answer, not a new failure: it must not reopen the breaker for the whole operator.
    for (const id of ids) {
      const fb = await call(w, receptionCookie, 'PATCH', `/assistant/asks/${id}/feedback`, {
        feedback: 'wrong',
        correction: 'ZZ it timed out',
      });
      expect(fb.status).toBe(200);
    }
    expect(await circuitOpen(w.ctx.db, w.oto, new Date())).toBe(false);
    script(w, final('Back.'));
    expect((await ask(w, receptionCookie, 'And now?')).body.state).toBe('answered');
  });

  it('a model id the ask row’s CHECK would refuse does not strand the ask', async () => {
    // `ask_version_words_check` takes one word; a provider could serve under any id.
    w.ctx.app.internalAi.client = new FakeToolLoopClient([final('Hi.')], 'x y');
    const res = await ask(w, receptionCookie, 'Hello?');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('answered');
    expect((await askRow(w.ctx.db, res.body.id))!.model).toBe(w.ctx.app.internalAi.config.model);
  });
});

describe('links are grounded like figures (§C, §E.4)', () => {
  it('a link whose parameter value no summary of this ask contains is dropped; enum values and empties pass', () => {
    const seen = newId();
    const ground = [JSON.stringify({ data: { threads: [{ id: seen }] } })];
    expect(groundedLinks([{ key: 'inbox.thread', params: { c: seen } }], ground)).toHaveLength(1);
    expect(groundedLinks([{ key: 'inbox.thread', params: { c: seen.toUpperCase() } }], ground)).toHaveLength(1);
    expect(groundedLinks([{ key: 'inbox.thread', params: { c: newId() } }], ground)).toEqual([]);
    expect(groundedLinks([{ key: 'inbox.thread', params: { c: seen } }], [])).toEqual([]);
    expect(groundedLinks([{ key: 'inbox.thread', params: { nope: seen } }], ground)).toEqual([]);
    expect(groundedLinks([{ key: 'no.such.screen', params: {} }], ground)).toEqual([]);
    expect(groundedLinks([{ key: 'inbox.queue', params: {} }], [])).toHaveLength(1);
    expect(groundedLinks([{ key: 'oto.payroll.month', params: { month: '2026-09', tab: 'preview' } }], ['"period":"2026-09-01"'])).toHaveLength(1);
    expect(groundedLinks([{ key: 'oto.payroll.month', params: { month: '2026-08', tab: 'preview' } }], ['"period":"2026-09-01"'])).toEqual([]);
    expect(groundedLinks([{ key: 'oto.timekeeping.employee', params: { employeeId: 'e1', date: '' } }], ['"id":"e1"'])).toHaveLength(1);
  });

  it('through an ask: an inbox.thread link to an id the queue summary named survives; one it never named is dropped', async () => {
    const aw = asAiWorld(w);
    const account = await simAccount(aw, { branchId: w.central, aiMode: 'off' });
    await customer(aw, account, nextPhone(), 'ZZ hello, is the park open on Sunday?');
    const receptionTeam = await teamOf(aw, 'reception', w.central);
    const agent = await staff(w, 'ZZ Linking Agent', 'inbox_agent', {
      scopeType: 'department',
      scopeId: receptionTeam.departmentId!,
    });
    const direct = await call<{ conversations: Array<{ id: string }> }>(
      w,
      agent.cookie,
      'GET',
      '/inbox/conversations?tab=team&unanswered=true&limit=100',
    );
    const named = direct.body.conversations[0]!.id;
    const invented = newId();
    const fake = script(
      w,
      tool('inbox.queue', { tab: 'team' }),
      final('One thread is waiting.', [
        { key: 'inbox.thread', params: [{ name: 'c', value: invented }] },
        { key: 'inbox.thread', params: [{ name: 'c', value: named }] },
      ]),
    );
    const res = await ask(w, agent.cookie, 'Which thread is waiting?');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe('answered');
    // The queue summary now names ids, alongside the titles, so a thread link CAN be grounded.
    const summary = toolResultsSeen(fake)[0]!.data as { data: { threads: Array<{ id: string }> } };
    expect(summary.data.threads.map((t) => t.id)).toContain(named);
    expect(res.body.links).toEqual([
      { key: 'inbox.thread', app: 'inbox', path: `/?c=${named}`, shows: 'One conversation in the Inbox' },
    ]);
  });
});

describe('the guard’s fallback line (§C, §E.4)', () => {
  it('a figure no tool returned, with no link to offer: the line stands alone as a sentence, and the ask is failed', async () => {
    script(w, final('There are 31 children inside.'));
    const res = await ask(w, receptionCookie, 'How many children are inside?');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'failed',
      reason: 'GUARD_NUMBER',
      answer: INTERNAL_LINES.guardFallbackNoLink.en,
      links: [],
    });
    // A complete sentence: nothing follows it, so no colon may end it.
    expect(res.body.answer).not.toMatch(/:\s*$/);
    expect(res.body.answer).not.toContain('31');
    // The audit words are the guard's, as before: the state, the reason and the rule.
    const [closing] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'assistant.ask'), sql`${s.auditLog.after}->>'askId' = ${res.body.id}`));
    expect(closing!.after).toMatchObject({ state: 'failed', reason: 'GUARD_NUMBER', guardRule: 'number', links: [] });
  });

  it('with a link to offer: the existing line, the link under it, link_only', async () => {
    script(w, final('There are 31 children inside.', [{ key: 'launcher.account', params: [] }]));
    const res = await ask(w, receptionCookie, 'How many children are inside?');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'link_only', reason: 'GUARD_NUMBER', answer: INTERNAL_LINES.guardFallback.en });
    expect(res.body.answer).toMatch(/:$/);
    expect(res.body.links.map((l) => l.key)).toEqual(['launcher.account']);
    expect(res.body.answer).not.toContain('31');
  });
});

describe('the asker’s own words are grounding (§E.4, the internal path)', () => {
  it('a phone number and a month the asker typed may be echoed; a figure in neither the question nor a summary is still refused', async () => {
    script(w, final('Nobody has the phone 081 234 5678.'));
    const phone = await ask(w, receptionCookie, 'Who has the phone 081 234 5678?');
    expect(phone.body).toMatchObject({ state: 'answered', reason: null, answer: 'Nobody has the phone 081 234 5678.' });

    script(w, final('The September month-end is where to look.'));
    const month = await ask(w, managerCookie, "Why does September's payroll look wrong?");
    expect(month.body).toMatchObject({ state: 'answered', reason: null, answer: 'The September month-end is where to look.' });

    // By a person with no earlier ask: since the test night (D2) the asker's own recent answers ground
    // too, and reception's first ask above would otherwise lend this one its number.
    const alone = await staff(w, 'ZZ Alone', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    script(w, final('Nobody has the phone 081 234 5678.'));
    const other = await ask(w, alone.cookie, 'Who has the phone 089 000 1111?');
    expect(other.body).toMatchObject({ state: 'failed', reason: 'GUARD_NUMBER', answer: INTERNAL_LINES.guardFallbackNoLink.en });
  });

  it('the ask’s own date is grounding: the current year, month and day in Bangkok pass with no tool called; another year is still refused', async () => {
    // Q6 re-recorded: "the 2026-09 month-end screen" with no tool called was set aside for the year.
    const today = isoDateInTz(new Date(), 'Asia/Bangkok');
    const year = Number(today.slice(0, 4));
    const [monthEn] = monthWords(today).split(' / ');
    const [dayEn] = dayWords(today).split(' / ');
    script(w, final(`The ${today.slice(0, 7)} month-end screen shows that month's run. Today is ${dayEn}, ${monthEn}; the year is ${year}.`));
    const thisYear = await ask(w, managerCookie, 'Why does the payroll look wrong?');
    expect(thisYear.body, JSON.stringify(thisYear.body)).toMatchObject({ state: 'answered', reason: null });

    script(w, final(`The year is ${year + 1}.`));
    const otherYear = await ask(w, managerCookie, 'Why does the payroll look wrong?');
    expect(otherYear.body).toMatchObject({ state: 'failed', reason: 'GUARD_NUMBER', answer: INTERNAL_LINES.guardFallbackNoLink.en });
  });
});

describe('the record: audit and ops carry ids and words, never text (§E.1)', () => {
  it('every ask and tool call is audited, and every model loop is an adapter run', async () => {
    script(w, tool('members.lookup', { phone: '081 234 0001' }), final('Found the ZZ Somchai Family.'));
    const res = await ask(w, receptionCookie, 'Find 081 234 0001');
    const id = res.body.id;
    const rows = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(sql`${s.auditLog.after}->>'askId' = ${id}`);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(['assistant.ask', 'assistant.ask.open', 'assistant.tool.call']);
    const toolAudit = rows.find((r) => r.action === 'assistant.tool.call')!;
    expect(toolAudit.after).toMatchObject({ tool: 'members.lookup', route: 'GET /members/lookup', status: 200, rows: 1 });
    expect(toolAudit.after).not.toHaveProperty('args');
    expect(JSON.stringify(toolAudit.after)).not.toContain('081 234');
    expect(JSON.stringify(rows.map((r) => r.after))).not.toContain('+668123');
    expect(toolAudit.requestId).toMatch(/\.t1$/);
    const closing = rows.find((r) => r.action === 'assistant.ask')!;
    expect(closing.after).toMatchObject({ state: 'answered', tools: ['members.lookup'], toolCalls: 1 });
    const runs = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:assistant.ai'), sql`${s.opsRun.detail}->>'askId' = ${id}`));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('ok');
    // The tool's arguments live on the tool-call row only.
    expect((await toolRows(w.ctx.db, id))[0]!.args).toEqual({ phone: '081 234 0001' });
  });

  it('THE SENTINEL: a question, a note the tool returned, an answer and a correction reach no audit, ops, replay or log', async () => {
    const { memberId } = await zzFamily(w, {
      phone: '+66812340099',
      name: 'ZZ Sentinel Family',
      notes: `ZZ note ${ASK_SENTINEL}`,
    });
    const fake = script(
      w,
      tool('members.get', { memberId }),
      final(`Their note says: ZZ note ${ASK_SENTINEL}`),
    );
    const res = await ask(w, managerCookie, `What does the note say? ${ASK_SENTINEL}`);
    expect(res.body.state).toBe('answered');
    expect(res.body.answer).toContain(ASK_SENTINEL);
    // The tool result carried it to the model, as data.
    expect(JSON.stringify(toolResultsSeen(fake)[0]!.data)).toContain(ASK_SENTINEL);
    const fb = await call(w, managerCookie, 'PATCH', `/assistant/asks/${res.body.id}/feedback`, {
      feedback: 'wrong',
      correction: `It should say ${ASK_SENTINEL}`,
    });
    expect(fb.status).toBe(200);
    expect(JSON.stringify(fb.body)).not.toContain(ASK_SENTINEL);

    // Where it lives: the ask row and nowhere else.
    const row = await askRow(w.ctx.db, res.body.id);
    expect(row!.question).toContain(ASK_SENTINEL);
    expect(row!.answer).toContain(ASK_SENTINEL);
    expect(row!.correction).toContain(ASK_SENTINEL);
    expect(await askLeaks(w.ctx.db, ASK_SENTINEL, w.logLines)).toEqual(NO_ASK_LEAKS);
  });

  it('THE SENTINEL through a tool ARGUMENT on a denied call: the denial’s audit row carries the route, not the query', async () => {
    // A word no record holds, no digit: it travels only as `members.search.q`, which reception may not call.
    const DENIED_SENTINEL = 'ZQXDENIEDARGSENTINELQZX';
    script(w, tool('members.search', { q: DENIED_SENTINEL }), final('I can’t search the register from your role.'));
    const res = await ask(w, receptionCookie, 'Who is that?');
    expect(res.body.state).toBe('refused');
    expect(res.body.refusals.map((r) => r.line)).toEqual(['Platform: Missing permission pos:member:list']);
    const rows = await toolRows(w.ctx.db, res.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'members.search', status: 403, code: 'FORBIDDEN' });
    // The route's own denial row, correlated by the tool call's request id: the URL is scrubbed to the path.
    const [toolAudit] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'assistant.tool.call'), sql`${s.auditLog.after}->>'askId' = ${res.body.id}`));
    const denied = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'auth.permission_denied'), eq(s.auditLog.requestId, toolAudit!.requestId!)));
    expect(denied).toHaveLength(1);
    expect(denied[0]!.after).toMatchObject({ method: 'GET', url: '/members?[redacted]' });
    // The one place the argument lives: the tool-call row (ask-log tier, purged with the ask).
    expect(await askLeaks(w.ctx.db, DENIED_SENTINEL, w.logLines)).toEqual({ ...NO_ASK_LEAKS, toolCalls: 1 });
  });

  it('the tool call’s own request line names the route and carries no query string', async () => {
    script(w, tool('members.lookup', { phone: '0812340001' }), final('Found them.'));
    const res = await ask(w, receptionCookie, 'Look up 0812340001');
    expect(res.body.state).toBe('answered');
    const line = w.logLines.find((l) => l.includes('.t1') && l.includes('/members/lookup'));
    expect(line, 'the tool request is logged like any request').toBeDefined();
    expect(line).not.toContain('0812340001');
    expect(line).not.toContain('?phone');
    expect(w.logLines.filter((l) => l.includes('0812340001'))).toEqual([]);
  });
});

describe('the test night (SCRUM-591, 2026-10-21; plan "Test night 2026-10-21")', () => {
  const bkkToday = () => isoDateInTz(new Date(), 'Asia/Bangkok');
  const closingAudit = async (askId: string) => {
    const [row] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'assistant.ask'), sql`${s.auditLog.after}->>'askId' = ${askId}`));
    return row!;
  };

  it('D1: audit.search offers the actions the api writes, each with its meaning, and every name is a literal in the api', () => {
    const spec = ASSISTANT_TOOLS.find((t) => t.name === 'audit.search')!;
    const json = toJsonSchema(spec.input) as { properties: Record<string, { enum?: string[]; description?: string }>; required?: string[] };
    // Nothing is required: the night's first call was INVALID_ARGUMENTS on a date.
    expect(json.required).toBeUndefined();
    expect(json.properties.action!.enum).toEqual(ASSISTANT_AUDIT_ACTIONS.map((a) => a.action));
    expect(json.properties.action!.description).toContain('auth.sign_in = a person signed in');
    expect(json.properties.q!.description).toContain('not in the action list');
    const sources = sourceFiles(API_SRC).map((f) => readFileSync(f, 'utf8'));
    for (const { action } of ASSISTANT_AUDIT_ACTIONS) {
      expect(sources.some((src) => src.includes(`'${action}'`)), `${action} is an action the api writes`).toBe(true);
    }
    expect(ASSISTANT_AUDIT_ACTIONS.length).toBeGreaterThanOrEqual(ASSISTANT_AUDIT_ACTIONS_SHOWN);
  });

  it('D1: a day or a loose instant is a valid argument and reaches the route as the UTC instant the route takes', () => {
    const input = PLATFORM_TOOLS.get('audit.search')!.input;
    for (const from of ['2026-10-21', '2026-10-21T03:32', '2026-10-21 03:32:10', '2026-10-21T03:32:00Z', '2026-10-21T03:32:00+07:00']) {
      expect(input.safeParse({ from }).success, from).toBe(true);
    }
    expect(input.safeParse({ from: 'yesterday' }).success).toBe(false);
    // A name the audit does not write is not an `action`; `q` is for those, and the summary then says it was a guess.
    expect(input.safeParse({ action: 'auth.login' }).success).toBe(false);
    expect(input.safeParse({ q: 'auth.login' }).success).toBe(true);
    expect(auditInstant('2026-10-21', 'from')).toBe('2026-10-20T17:00:00.000Z');
    expect(auditInstant('2026-10-21', 'to')).toBe('2026-10-21T16:59:59.999Z');
    expect(auditInstant('2026-10-21T03:32', 'from')).toBe('2026-10-20T20:32:00.000Z');
    expect(auditInstant('2026-10-21T03:32:00Z', 'from')).toBe('2026-10-21T03:32:00.000Z');
    expect(auditInstant(undefined, 'from')).toBeUndefined();
    expect(PLATFORM_TOOLS.get('audit.search')!.urls({ q: 'auth.login', from: '2026-10-21' } as never)).toEqual([
      '/audit?action=auth.login&from=2026-10-20T17%3A00%3A00.000Z&limit=20',
    ]);
    expect(auditNothingMatched('auth.login', '2026-10-21 00:00', null, true)).toContain('auth.login is not a name the audit writes, so that action was a guess');
    expect(auditNothingMatched('auth.sign_in', null, null, false)).toContain('nothing of that kind matched, which is not the same as nothing happening');
    expect(auditNothingMatched(undefined, '2026-10-21 00:00', '2026-10-21 04:32', false)).toContain('0 rows for these filters between');
  });

  it('D1: "who logged in today" — a guessed name gets 0 rows and the known names; the real name gets the sign-ins; the answer carries the count', async () => {
    const admin = await staff(w, 'ZZ Trail Admin', 'operator_admin', { scopeType: 'operator', scopeId: w.oto }, w.central);
    const from = bkkToday();
    const direct = await call<{ entries: unknown[] }>(
      w,
      admin.cookie,
      'GET',
      `/audit?action=auth.sign_in&from=${encodeURIComponent(auditInstant(from, 'from')!)}&limit=20`,
    );
    expect(direct.status).toBe(200);
    const n = direct.body.entries.length;
    expect(n).toBeGreaterThan(0); // this file's own sign-ins
    const fake = script(
      w,
      tool('audit.search', { q: 'auth.login', from }),
      tool('audit.search', { action: 'auth.sign_in', from }),
      final(`${n} sign-ins today.`, [{ key: 'console.activity', params: [] }]),
    );
    const res = await ask(w, admin.cookie, 'who logged in today');
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ state: 'answered', reason: null, answer: `${n} sign-ins today.` });
    const seen = toolResultsSeen(fake);
    const guessed = (seen[0]!.data as { data: Record<string, unknown> }).data;
    expect(guessed).toMatchObject({ action: 'auth.login', shown: 0 });
    expect(guessed.nothingMatched).toContain('0 rows for action=auth.login between');
    expect(guessed.nothingMatched).toContain('auth.login is not a name the audit writes, so that action was a guess');
    expect(guessed.nothingMatched).toContain('auth.sign_in = a person signed in');
    const real = (seen[1]!.data as { data: Record<string, unknown> }).data;
    expect(real).toMatchObject({ action: 'auth.sign_in', shown: n });
    expect(real).not.toHaveProperty('nothingMatched');
    expect((await toolRows(w.ctx.db, res.body.id)).map((r) => [r.status, r.rows])).toEqual([
      [200, 0],
      [200, n],
    ]);
  });

  it('D2: the asker’s own earlier asks ride as prior turns, and a follow-up is answered from them with no tool', async () => {
    const me = await staff(w, 'ZZ Follow Up', 'branch_manager', { scopeType: 'branch', scopeId: w.central }, w.central);
    script(w, tool('occupancy.now', { branchId: w.central }), final('Central: 0 children and 0 adults inside right now.'));
    const first = await ask(w, me.cookie, 'How many children are inside at Central right now?');
    expect(first.body, JSON.stringify(first.body)).toMatchObject({ state: 'answered' });
    const fake = script(w, final('Yesterday the same: 0 children at Central.'));
    const res = await ask(w, me.cookie, 'and yesterday?');
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ state: 'answered', reason: null, answer: 'Yesterday the same: 0 children at Central.' });
    expect(await toolRows(w.ctx.db, res.body.id)).toEqual([]);
    const messages = fake.calls[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]!.content).toBe('How many children are inside at Central right now?');
    expect(JSON.parse(messages[1]!.content as string)).toMatchObject({ answer: 'Central: 0 children and 0 adults inside right now.', language: 'en', links: [] });
    expect(messages[2]!.content).toBe('and yesterday?');
    // The conversation sits below the cache breakpoint: the static block is the same bytes as any other ask's.
    expect(fake.calls[0]!.system[0]!.text).not.toContain('Central right now');
    expect(fake.calls[0]!.system[1]!.text).not.toContain('Central right now');
    // The audit says how many turns rode along, and never their words.
    const closing = await closingAudit(res.body.id);
    expect(closing.after).toMatchObject({ state: 'answered', priorTurns: 1, toolCalls: 0 });
    expect(JSON.stringify(closing.after)).not.toContain('Central right now');
  });

  it('D2: a bare follow-up with no earlier ask gets the honest line, not a guard line; a plain question still gets the guard', async () => {
    const me = await staff(w, 'ZZ No Context', 'branch_manager', { scopeType: 'branch', scopeId: w.central }, w.central);
    script(w, final('Yesterday there were 12 children.'));
    const res = await ask(w, me.cookie, 'and yesterday?');
    expect(res.body).toMatchObject({ state: 'failed', reason: 'NO_CONTEXT', answer: INTERNAL_LINES.noContext.en, links: [], smallTalk: false });
    expect(res.body.answer).not.toContain('12');
    expect((await closingAudit(res.body.id)).after).toMatchObject({ state: 'failed', reason: 'NO_CONTEXT', guardRule: 'number', priorTurns: 0 });
    // A failed ask is no prior turn: the next bare follow-up is still without context; a plain question keeps the guard's line.
    script(w, final('Yesterday there were 12 children.'));
    expect((await ask(w, me.cookie, 'แล้วเมื่อวานล่ะ')).body).toMatchObject({ state: 'failed', reason: 'NO_CONTEXT', answer: INTERNAL_LINES.noContext.th });
    script(w, final('There were 12 children.'));
    expect((await ask(w, me.cookie, 'How many children were inside?')).body).toMatchObject({ state: 'failed', reason: 'GUARD_NUMBER' });
    for (const q of ['and yesterday?', 'What about Chalong?', 'แล้วเมื่อวานล่ะ', 'а вчера?', 'and the adults?']) expect(isBareFollowUp(q), q).toBe(true);
    for (const q of ['How many children are inside?', 'ขอบคุณ', 'Anan attendance this month', 'Сколько детей сейчас в парке?', 'and'.repeat(40)]) {
      expect(isBareFollowUp(q), q).toBe(false);
    }
  });

  it('D2: only the asker’s own log is read — another person’s asks never ride along — and the window is the last three within two hours, oldest first', async () => {
    const a = await staff(w, 'ZZ Own Log A', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    const b = await staff(w, 'ZZ Own Log B', 'reception', { scopeType: 'branch', scopeId: w.central }, w.central);
    script(w, final('Noted for A.'));
    expect((await ask(w, a.cookie, 'ZZ a question of A’s')).body.state).toBe('answered');
    const other = script(w, final('Noted for B.'));
    expect((await ask(w, b.cookie, 'ZZ a question of B’s')).body.state).toBe('answered');
    expect(other.calls[0]!.messages).toEqual([{ role: 'user', content: 'ZZ a question of B’s' }]);

    for (const q of ['ZZ one', 'ZZ two', 'ZZ three', 'ZZ four']) {
      script(w, final(`Answer to ${q}.`));
      expect((await ask(w, a.cookie, q)).body.state).toBe('answered');
    }
    // An answered ask three hours old is outside the window.
    const old = new Date(Date.now() - 3 * 3_600_000);
    await w.ctx.db.insert(s.ask).values({
      id: newId(),
      operatorId: w.oto,
      accountId: a.accountId,
      question: 'ZZ stale',
      answer: 'ZZ stale answer',
      state: 'answered',
      createdAt: old,
      updatedAt: old,
    });
    const fake = script(w, final('Five.'));
    const res = await ask(w, a.cookie, 'ZZ five');
    expect(res.body.state).toBe('answered');
    expect(fake.calls[0]!.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['ZZ two', 'ZZ three', 'ZZ four', 'ZZ five']);
    expect((await closingAudit(res.body.id)).after).toMatchObject({ priorTurns: 3 });
  });

  it('W3: the refusal line keeps the route’s words; the prose never repeats a permission string; the model is handed the plain sentence', async () => {
    const fake = script(
      w,
      tool('inbox.queue', { tab: 'team' }),
      final("Missing permission inbox:conversation:read. That's the same answer the screen gives."),
    );
    const res = await ask(w, receptionCookie, 'how many unanswered chats does the team have');
    expect(res.body, JSON.stringify(res.body)).toMatchObject({
      state: 'refused',
      reason: 'TOOL_REFUSED',
      answer: "You don't have access to the team inbox. That's the same answer the screen gives.",
    });
    expect(res.body.refusals.map((r) => r.line)).toEqual(['Platform: Missing permission inbox:conversation:read']);
    expect(res.body.answer).not.toMatch(/Missing permission|inbox:conversation:read/);
    const envelope = toolResultsSeen(fake)[0]!;
    expect(envelope.isError).toBe(true);
    expect((envelope.data as { error: Record<string, unknown> }).error).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Missing permission inbox:conversation:read',
      plain: "You don't have access to the team inbox.",
    });
    expect((await closingAudit(res.body.id)).after).toMatchObject({ refusalWordsRewritten: 1 });
  });

  it('W5: a member lookup carries the children’s allergies as written, and the till’s History on that phone is the link', async () => {
    const fake = script(
      w,
      tool('members.lookup', { phone: '081 234 0001' }),
      final('ZZ Somchai Family: ZZ Ploy, 6, allergies ZZ peanuts; ZZ Tonkla, 4, none on file.', [
        { key: 'pos.member', params: [{ name: 'phone', value: '081 234 0001' }] },
      ]),
    );
    const res = await ask(w, receptionCookie, 'find member 081 234 0001 and the kids’ allergies');
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ state: 'answered', reason: null });
    const member = (toolResultsSeen(fake)[0]!.data as { data: { member: { children: Array<Record<string, unknown>> } } }).data.member;
    expect(member.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ZZ Ploy', age: 6, medicalAlert: true, hasAllergies: true, allergies: 'ZZ peanuts', hasMedicalNotes: false }),
        expect.objectContaining({ name: 'ZZ Tonkla', age: 4, medicalAlert: false, hasAllergies: false, allergies: null }),
      ]),
    );
    // The medical notes only when asked for.
    expect(JSON.stringify(member)).not.toContain('medicalNotes');
    expect(res.body.links).toEqual([
      { key: 'pos.member', app: 'pos', path: '/history?phone=081+234+0001', shows: "The member's sales on the till (History)" },
    ]);
    // The screen the tool itself names (for an ask that ends short) is the same one, on the phone as typed.
    expect(PLATFORM_TOOLS.get('members.lookup')!.deepLink({ phone: ' 081 234 0001 ' } as never)).toEqual({ key: 'pos.member', params: { phone: '081 234 0001' } });
    const withNotes = script(w, tool('members.get', { memberId: somchai, include: ['medical_notes'] }), final('No medical notes.'));
    expect((await ask(w, managerCookie, 'Any medical notes on the Somchai children?')).body.state).toBe('answered');
    const children = (toolResultsSeen(withNotes)[0]!.data as { data: { member: { children: Array<Record<string, unknown>> } } }).data.member.children;
    for (const c of children) expect(c).toHaveProperty('medicalNotes');
  });

  it('W6: "which team has the most open conversations" — the dashboard tool answers it by team, as the Inbox route counts for the asker', async () => {
    const aw = asAiWorld(w);
    const account = await simAccount(aw, { branchId: w.central, aiMode: 'off' });
    await customer(aw, account, nextPhone(), 'ZZ is the party room free on Sunday?');
    await customer(aw, account, nextPhone(), 'ZZ do you have parking?');
    const gm = await staff(w, 'ZZ Hana GM', 'inbox_manager', { scopeType: 'operator', scopeId: w.oto });
    const direct = await call<{ byCategory: { birthdays: number; general: number; marketing: number }; unanswered: number; active: number }>(
      w,
      gm.cookie,
      'GET',
      '/inbox/dashboard',
    );
    expect(direct.status).toBe(200);
    const { general, birthdays, marketing } = direct.body.byCategory;
    expect(general).toBeGreaterThanOrEqual(2);
    const fake = script(
      w,
      tool('inbox.dashboard', {}),
      final(`Reception has the most: ${general} conversations (general); birthdays ${birthdays}, marketing ${marketing}.`, [{ key: 'inbox.queue', params: [] }]),
    );
    const res = await ask(w, gm.cookie, 'which team has the most open conversations');
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ state: 'answered', reason: null });
    const data = (toolResultsSeen(fake)[0]!.data as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      unanswered: direct.body.unanswered,
      active: direct.body.active,
      byTeam: [
        { team: 'birthdays', category: 'birthdays', conversations: birthdays },
        { team: 'reception', category: 'general', conversations: general },
        { team: 'marketing', category: 'marketing', conversations: marketing },
      ],
      mostConversations: ['reception'],
    });
    expect(data.words).toContain('reception has the most conversations');
    expect(JSON.stringify(data)).not.toContain('party room');
    expect((await toolRows(w.ctx.db, res.body.id))[0]).toMatchObject({ tool: 'inbox.dashboard', route: 'GET /inbox/dashboard', status: 200, rows: 1 });
    expect(res.body.links.map((l) => l.key)).toEqual(['inbox.queue']);
    // The fence is the route's: reception is refused with its own sentence.
    script(w, tool('inbox.dashboard', {}), final('Not mine to see.'));
    const refused = await ask(w, receptionCookie, 'which team has the most open conversations');
    expect(refused.body.refusals.map((r) => r.line)).toEqual(['Platform: Missing permission inbox:dashboard:read']);
  });

  it('W7, S11: a one-park count says which park, how many the asker can see and names the others; a stale count says so in one line', async () => {
    await w.ctx.db.insert(s.branch).values({ id: newId(), operatorId: w.oto, name: 'ZZ Kathu', code: 'zz-kathu' });
    const admin = await staff(w, 'ZZ Park Admin', 'operator_admin', { scopeType: 'operator', scopeId: w.oto }, w.central);
    const names = await w.ctx.db.select({ id: s.branch.id, name: s.branch.name }).from(s.branch).where(eq(s.branch.operatorId, w.oto)).orderBy(asc(s.branch.name));
    const central = names.find((b) => b.id === w.central)!;
    const others = names.filter((b) => b.id !== w.central).map((b) => b.name);
    const direct = await call<{ stale: boolean; asOf: string | null }>(w, admin.cookie, 'GET', `/branches/${w.central}/occupancy`);
    expect(direct.status).toBe(200);
    const fake = script(
      w,
      tool('branches.list', {}),
      tool('occupancy.now', { branchId: w.central }),
      final(`${central.name} only: 0 children inside; the other parks you can see are not counted here.`),
    );
    const res = await ask(w, admin.cookie, 'how many children are in the park right now?');
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ state: 'answered', reason: null });
    const data = (toolResultsSeen(fake)[1]!.data as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ park: { id: w.central, name: central.name }, parksYouCanSee: 3, stale: direct.body.stale });
    expect((data.otherParks as Array<{ name: string }>).map((p) => p.name)).toEqual(others);
    expect(data.scope).toBe(
      `This count is for ${central.name} only, 1 of 3 parks you can see; the others are ${others.join(', ')}. For the park as a whole, read each park and add them up, or say which park.`,
    );
    if (!direct.body.stale) expect(data.staleWords).toBeNull();
    else if (direct.body.asOf === null) expect(data.staleWords).toBe('This count is stale: no headcount has been taken yet today (no gate has reported).');
    else expect(data.staleWords).toMatch(/^This count is stale: the gate was last heard from at /);
    // A branch-scoped reader sees one park: the count is said to be the only park they can see.
    const one = script(w, tool('occupancy.now', { branchId: w.central }), final('0 children.'));
    expect((await ask(w, managerCookie, 'how many children are in the park?')).body.state).toBe('answered');
    expect((toolResultsSeen(one)[0]!.data as { data: Record<string, unknown> }).data).toMatchObject({
      parksYouCanSee: 1,
      otherParks: [],
      scope: `This count is for ${central.name}, the one park you can see.`,
    });
  });

  it('W4: the calendar the asker named grounds a link parameter — a month by name in three languages, a typed ISO month or day', () => {
    const oct = new Date('2026-10-21T03:00:00Z');
    expect(questionCalendar("Why does September's payroll look wrong?", oct)).toBe('2026-09 (September 2026 / กันยายน 2569 / сентябрь 2026)');
    expect(questionCalendar('เงินเดือนเดือนกันยายนผิดตรงไหน', oct)).toContain('2026-09');
    expect(questionCalendar('Что не так с зарплатой за сентябрь?', oct)).toContain('2026-09');
    // A month still ahead is last year's; a typed ISO month or day is itself; "you may" is not a month.
    expect(questionCalendar('the December run', oct)).toContain('2025-12');
    expect(questionCalendar('the 2026-09-15 run and 2026-08', oct)).toBe('2026-09-15; 2026-08');
    expect(questionCalendar('You may look at it', oct)).toBe('');
    expect(questionCalendar('How many children are inside?', oct)).toBe('');
    const link = [{ key: 'oto.payroll.month', params: { month: '2026-09', tab: 'preview' } }];
    expect(groundedLinks(link, [questionCalendar('September payroll', oct)])).toHaveLength(1);
    expect(groundedLinks(link, [questionCalendar('August payroll', oct)])).toEqual([]);
  });

  it('S10: small talk is the model’s word, kept on the row and shown on the view; every other answer and every server line is false', async () => {
    script(w, final('ยินดีค่ะ', [], 'th', { smallTalk: true }));
    const social = await ask(w, receptionCookie, 'ขอบคุณ');
    expect(social.body).toMatchObject({ state: 'answered', smallTalk: true, answer: 'ยินดีค่ะ' });
    expect((await askRow(w.ctx.db, social.body.id))!.smallTalk).toBe(true);
    expect((await closingAudit(social.body.id)).after).toMatchObject({ smallTalk: true });
    const one = await call<Record<string, unknown>>(w, receptionCookie, 'GET', `/assistant/asks/${social.body.id}`);
    expect(one.body.smallTalk).toBe(true);
    script(w, final('Noted.'));
    expect((await ask(w, receptionCookie, 'Anything?')).body.smallTalk).toBe(false);
    script(w, final('There are 31 children inside.', [], 'en', { smallTalk: true }));
    expect((await ask(w, receptionCookie, 'How many children are inside?')).body).toMatchObject({ state: 'failed', reason: 'GUARD_NUMBER', smallTalk: false });
  });
});
