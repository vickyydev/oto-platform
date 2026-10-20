import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { ask, askRow, askWorld, final, script, type AskWorld } from './assistant-support';
import { BRANCH_MANAGER, signInAs, teardownAll } from './helpers';

/**
 * SCRUM-591 — FEEDBACK IS ONCE PER ASK (plan §D.3, spec §4). The first
 * verdict stands: a second PATCH under a fresh Idempotency-Key is 409
 * FEEDBACK_GIVEN and changes nothing — not the verdict, not the correction,
 * not the audit — while a resend of the SAME request under the SAME key is
 * answered from the first (the replay store, `plugins/idempotency.ts`) and
 * never refused.
 */

let w: AskWorld;
let manager: string;

beforeAll(async () => {
  w = await askWorld();
  manager = await signInAs(w.ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

async function answered(question: string): Promise<string> {
  script(w, final('Noted.'));
  const res = await ask(w, manager, question);
  expect(res.body.state).toBe('answered');
  return res.body.id;
}

/** A PATCH under a key of the test's choosing, so a resend can reuse it. */
async function patch(url: string, payload: unknown, key: string) {
  const res = await w.ctx.app.inject({
    method: 'PATCH',
    url,
    headers: { cookie: manager, 'idempotency-key': key },
    payload: payload as never,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, replay: res.headers['x-oto-replay'] };
}

const feedbackAudits = (askId: string) =>
  w.ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, 'assistant.ask.feedback'), eq(s.auditLog.entityId, askId)));

describe('feedback is once per ask (spec §4)', () => {
  it('a second verdict under a fresh key is 409 FEEDBACK_GIVEN, and the first stands', async () => {
    const id = await answered('How many today?');
    const url = `/assistant/asks/${id}/feedback`;

    const first = await patch(url, { feedback: 'wrong', correction: 'ZZ forty, not four' }, newId());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id, feedback: 'wrong', hasCorrection: true });

    // Neither flipping the verdict nor replacing the correction gets through.
    for (const body of [{ feedback: 'good' }, { feedback: 'wrong', correction: 'ZZ a second thought' }, { feedback: 'wrong' }]) {
      const again = await patch(url, body, newId());
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({ code: 'FEEDBACK_GIVEN', message: 'This answer has already been rated' });
    }
    expect(await askRow(w.ctx.db, id)).toMatchObject({ feedback: 'wrong', correction: 'ZZ forty, not four' });
    expect((await feedbackAudits(id)).map((a) => a.after)).toEqual([
      { feedback: 'wrong', hasCorrection: true, correctionLength: 'ZZ forty, not four'.length },
    ]);
  });

  it('a resend under the same Idempotency-Key is answered from the first, not refused', async () => {
    const id = await answered('Is it raining?');
    const url = `/assistant/asks/${id}/feedback`;
    const key = newId();

    const first = await patch(url, { feedback: 'good' }, key);
    expect(first.status).toBe(200);
    expect(first.replay).toBeUndefined();

    const resend = await patch(url, { feedback: 'good' }, key);
    expect(resend.status).toBe(200);
    expect(resend.replay).toBe('true');
    expect(resend.body).toEqual(first.body);
    expect(await feedbackAudits(id)).toHaveLength(1);
  });
});
