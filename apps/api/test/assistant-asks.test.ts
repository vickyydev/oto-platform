import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { ASSISTANT_ASK_RETENTION_DAYS, newId, type AssistantAskList, type AssistantReviewList } from '@oto/shared';
import { loadEnv } from '../src/env';
import { closeAbandoned } from '../src/services/assistant/engine';
import { runAssistantPurge } from '../src/services/assistant/views';
import { ASSISTANT_PURGE_JOB, buildDefaultJobs } from '../src/services/jobs';
import { ask, askRow, askWorld, call, final, script, tool, toolRows, type AskWorld } from './assistant-support';
import { ADMIN, BRANCH_MANAGER, RECEPTION, signInAs, teardownAll } from './helpers';

/**
 * SCRUM-591 — THE ASK-LOG, round I2 (plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §D.3, G3, G4).
 *
 *   - "My questions": the asker's own, newest first, paged; nobody else's.
 *   - Another person's ask: 403 unless the reader holds assistant:log:review
 *     operator-wide (operator admins), and every such read is audited,
 *     naming the asks read.
 *   - Feedback: own asks only, a correction only with "wrong", the words kept
 *     on the row and out of the audit and the replay store.
 *   - Retention: `purge_after` is set on every row; `job:assistant.purge`
 *     deletes past it with the tool calls, and keeps the audit rows.
 */

let w: AskWorld;
let reception: string;
let manager: string;
let admin: string;

beforeAll(async () => {
  w = await askWorld();
  reception = await signInAs(w.ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(w.ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

async function answered(cookie: string, question: string): Promise<string> {
  script(w, final('Noted.'));
  const res = await ask(w, cookie, question);
  expect(res.body.state).toBe('answered');
  return res.body.id;
}

const readAudits = (askId: string) =>
  w.ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, 'assistant.ask.read'), sql`${s.auditLog.after}->'askIds' ? ${askId}`));

describe('my questions (§D.3)', () => {
  it('lists the asker’s own asks, newest first, paged — and nobody else’s', async () => {
    const mine = [await answered(manager, 'First'), await answered(manager, 'Second'), await answered(manager, 'Third')];
    const theirs = await answered(reception, 'Not the manager’s');
    const page1 = await call<AssistantAskList>(w, manager, 'GET', '/assistant/asks?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.asks.map((a) => a.id)).toEqual([mine[2], mine[1]]);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await call<AssistantAskList>(
      w,
      manager,
      'GET',
      `/assistant/asks?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor!)}`,
    );
    expect(page2.body.asks.map((a) => a.id)).toContain(mine[0]);
    const all = [...page1.body.asks, ...page2.body.asks].map((a) => a.id);
    expect(all).not.toContain(theirs);
    // Reading your own leaves no review audit row.
    expect(await readAudits(mine[0]!)).toHaveLength(0);
  });

  it('carries the answer, links, refusal lines and tool calls as numbers — never a tool’s arguments', async () => {
    script(w, tool('members.lookup', { phone: '0812340002' }), final('Nobody on that number.'));
    const res = await ask(w, reception, 'Who is 0812340002?');
    const one = await call<Record<string, unknown>>(w, reception, 'GET', `/assistant/asks/${res.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      id: res.body.id,
      state: 'answered',
      toolCalls: [{ seq: 1, tool: 'members.lookup', system: 'platform', status: 200, code: null, rows: 0, truncated: false }],
    });
    expect(JSON.stringify(one.body.toolCalls)).not.toContain('0812340002');
  });

  it('sets purge_after explicitly, at the retention the plan names', async () => {
    const id = await answered(reception, 'When do I go?');
    const row = await askRow(w.ctx.db, id);
    const days = (row!.purgeAfter.getTime() - row!.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(ASSISTANT_ASK_RETENTION_DAYS);
  });
});

describe('another person’s asks (G3)', () => {
  it('a non-reviewer gets 403 on another person’s ask; a reviewer reads it, audited', async () => {
    const id = await answered(reception, 'Reception’s own question');
    const byManager = await call<{ error: { code: string; message: string } }>(w, manager, 'GET', `/assistant/asks/${id}`);
    expect(byManager.status).toBe(403);
    expect(byManager.body.error.message).toBe('Missing permission assistant:log:review');
    expect(await readAudits(id)).toHaveLength(0);

    const byAdmin = await call<{ id: string; question: string }>(w, admin, 'GET', `/assistant/asks/${id}`);
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.question).toBe('Reception’s own question');
    const audits = await readAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ askIds: [id], count: 1 });
    expect(JSON.stringify(audits[0]!.after)).not.toContain('Reception’s own question');
  });

  it('an ask of another operator is not found', async () => {
    const res = await call(w, manager, 'GET', `/assistant/asks/${newId()}`);
    expect(res.status).toBe(404);
  });

  it('the review list needs assistant:log:review operator-wide, and every read is audited with the asks read', async () => {
    const id = await answered(reception, 'Was this right?');
    expect((await call(w, reception, 'PATCH', `/assistant/asks/${id}/feedback`, { feedback: 'wrong', correction: 'ZZ it was not' })).status).toBe(200);

    const refused = await call<{ error: { message: string } }>(w, manager, 'GET', '/assistant/review/asks');
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe('Missing permission assistant:log:review');

    const list = await call<AssistantReviewList>(w, admin, 'GET', '/assistant/review/asks?feedback=wrong&limit=50');
    expect(list.status).toBe(200);
    expect(list.body.asks.map((a) => a.id)).toContain(id);
    expect(list.body.asks.every((a) => a.feedback === 'wrong')).toBe(true);
    const audits = await readAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityType).toBe('assistant.ask_review');
    expect(audits[0]!.after).toMatchObject({
      askIds: list.body.asks.map((a) => a.id),
      count: list.body.asks.length,
      filters: { feedback: 'wrong' },
    });
    expect(JSON.stringify(audits[0]!.after)).not.toContain('ZZ it was not');
  });
});

describe('feedback (spec §4)', () => {
  it('own asks only; a correction goes with "wrong"; the words stay on the row', async () => {
    const id = await answered(manager, 'How many today?');
    const url = `/assistant/asks/${id}/feedback`;

    expect((await call(w, reception, 'PATCH', url, { feedback: 'good' })).status).toBe(403);
    expect((await call(w, manager, 'PATCH', url, { feedback: 'good', correction: 'x' })).status).toBe(400);

    const wrong = await call<Record<string, unknown>>(w, manager, 'PATCH', url, { feedback: 'wrong', correction: 'ZZ forty, not four' });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ id, feedback: 'wrong', hasCorrection: true });
    expect(JSON.stringify(wrong.body)).not.toContain('forty');
    expect((await askRow(w.ctx.db, id))!.correction).toBe('ZZ forty, not four');

    // A verdict is once per ask (assistant-feedback.test.ts); "good" on another carries no correction.
    const other = await answered(manager, 'And now?');
    const good = await call(w, manager, 'PATCH', `/assistant/asks/${other}/feedback`, { feedback: 'good' });
    expect(good.body).toMatchObject({ feedback: 'good', hasCorrection: false });
    expect((await askRow(w.ctx.db, other))!.correction).toBeNull();

    const audits = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'assistant.ask.feedback'), eq(s.auditLog.entityId, id)));
    expect(audits.map((a) => a.after)).toEqual([
      { feedback: 'wrong', hasCorrection: true, correctionLength: 'ZZ forty, not four'.length },
    ]);
  });

  it('an ask still being answered cannot be rated yet', async () => {
    const [acc] = await w.ctx.db.select().from(s.account).where(eq(s.account.phone, BRANCH_MANAGER.phone)).limit(1);
    const id = newId();
    await w.ctx.db.insert(s.ask).values({ id, operatorId: w.oto, accountId: acc!.id, question: 'ZZ running' });
    const res = await call<{ error: { code: string } }>(w, manager, 'PATCH', `/assistant/asks/${id}/feedback`, { feedback: 'good' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASK_IN_FLIGHT');
  });
});

describe('retention (§D.3, G4)', () => {
  it('the purge deletes asks past purge_after with their tool calls, keeps the audit, and closes abandoned asks', async () => {
    script(w, tool('me.whoami', {}), final('You are Khun Lek.'));
    const old = await ask(w, manager, 'Who am I?');
    expect(await toolRows(w.ctx.db, old.body.id)).toHaveLength(1);
    const keep = await answered(manager, 'Keep me');
    await w.ctx.db.update(s.ask).set({ purgeAfter: new Date(Date.now() - 1000) }).where(eq(s.ask.id, old.body.id));

    const [acc] = await w.ctx.db.select().from(s.account).where(eq(s.account.phone, BRANCH_MANAGER.phone)).limit(1);
    const stale = newId();
    const twoHours = new Date(Date.now() - 2 * 3_600_000);
    await w.ctx.db
      .insert(s.ask)
      .values({ id: stale, operatorId: w.oto, accountId: acc!.id, question: 'ZZ stale', createdAt: twoHours, updatedAt: twoHours });

    const summary = await runAssistantPurge(w.ctx.db, new Date(), (row) => closeAbandoned(w.ctx.db, row, null));
    expect(summary).toEqual({ purged: 1, abandoned: 1 });
    expect(await askRow(w.ctx.db, old.body.id)).toBeUndefined();
    expect(await toolRows(w.ctx.db, old.body.id)).toEqual([]);
    expect(await askRow(w.ctx.db, keep)).toBeDefined();
    expect(await askRow(w.ctx.db, stale)).toMatchObject({ state: 'failed', reason: 'ABANDONED' });
    // The audit rows hold no text, and are not the ask-log's to sweep.
    const kept = await w.ctx.db.select().from(s.auditLog).where(sql`${s.auditLog.after}->>'askId' = ${old.body.id}`);
    expect(kept.map((a) => a.action).sort()).toEqual(['assistant.ask', 'assistant.ask.open', 'assistant.tool.call']);
  });

  it('is a daily job of the runner', async () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' });
    const job = buildDefaultJobs({ db: w.ctx.db, env, log: w.ctx.app.log, channels: [] }).find((j) => j.name === ASSISTANT_PURGE_JOB);
    expect(job).toMatchObject({ intervalSeconds: 86_400, exclusive: true });
    const result = await job!.run({ db: w.ctx.db, env, log: w.ctx.app.log, now: new Date() });
    expect(result).toEqual({ detail: { purged: 0, abandoned: 0 } });
  });
});
