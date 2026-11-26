import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, box, gateMessageSetting, gateMessageText, station } from '@oto/db';
import {
  GATE_MESSAGE_CASES,
  GATE_MESSAGE_LABELS,
  composeGateScreen,
  defaultGateMessages,
  newId,
  readGateMessagesWire,
  type GateMessagesRead,
} from '@oto/shared';
import { boxAuthFromRow, configBundle } from '../src/services/box';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1078 — the Console's Gate messages: a park's own wording for the gate
 * readers, per case and language, stored only where it differs from the
 * built-in wording, audited, administrators only, and sent to the park's
 * gate box in its config bundle once anything was changed.
 */
let ctx: TestContext;
let admin: string;
let branchId: string;
const path = () => `/branches/${branchId}/gate-messages`;

const read = (cookie = admin) => ctx.app.inject({ method: 'GET', url: path(), headers: { cookie } });
const put = (payload: unknown, cookie = admin, key = newId()) =>
  ctx.app.inject({ method: 'PUT', url: path(), headers: { cookie, 'idempotency-key': key }, payload });

/** The whole effective wording as a PUT body, which is what the Console sends. */
function bodyOf(texts: GateMessagesRead['texts']) {
  return { languages: texts.languages, cases: texts.cases, labels: texts.labels };
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
});

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('reading', () => {
  it('reads the built-in wording for a park nobody has edited', async () => {
    const res = await read();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as GateMessagesRead;
    expect(body.changed).toBe(0);
    expect(body.updatedAt).toBeNull();
    expect(body.texts).toEqual(defaultGateMessages());
    expect(body.defaults).toEqual(defaultGateMessages());
    expect(body.texts.languages).toEqual(['en', 'th']);
    for (const key of GATE_MESSAGE_CASES) expect(Object.keys(body.texts.cases[key] ?? {}).sort()).toEqual(['en', 'fr', 'ru', 'th', 'zh']);
    for (const key of GATE_MESSAGE_LABELS) expect(body.texts.labels[key]?.en).toBeTruthy();
  });

  it('is administrators only', async () => {
    for (const who of [RECEPTION, BRANCH_MANAGER]) {
      const cookie = await signInAs(ctx.app, who.phone, who.password);
      expect((await read(cookie)).statusCode, who.phone).toBe(403);
      expect((await put(bodyOf(defaultGateMessages()), cookie)).statusCode, who.phone).toBe(403);
    }
  });

  it('does not reach another operator’s park', async () => {
    const other = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    expect([403, 404]).toContain((await read(other)).statusCode);
  });
});

describe('saving', () => {
  it('stores only what differs, cleans it, audits it, and resets by sending the default back', async () => {
    const start = (await read()).json() as GateMessagesRead;
    const edited = structuredClone(start.texts);
    edited.languages = ['ru', 'en'];
    // A tab becomes a space, a bell is removed; the line break stays.
    edited.cases.ANTI_PASSBACK!.ru = 'Вы уже\tвнутри\u0007\nСпасибо';
    edited.labels.adult!.ru = 'Взрослый билет';
    const saved = await put(bodyOf(edited));
    expect(saved.statusCode, saved.body).toBe(200);
    const after = saved.json() as GateMessagesRead;
    expect(after.changed).toBe(3);
    expect(after.texts.languages).toEqual(['ru', 'en']);
    expect(after.texts.cases.ANTI_PASSBACK!.ru).toBe('Вы уже внутри\nСпасибо');
    expect(after.texts.cases.ANTI_PASSBACK!.en).toBe('Already entered');
    expect(after.updatedAt).not.toBeNull();

    const rows = await ctx.db.select().from(gateMessageText).where(eq(gateMessageText.branchId, branchId));
    expect(rows.map((r) => `${r.kind}:${r.key}:${r.lang}`).sort()).toEqual(['case:ANTI_PASSBACK:ru', 'label:adult:ru']);
    const [setting] = await ctx.db.select().from(gateMessageSetting).where(eq(gateMessageSetting.branchId, branchId));
    expect(setting?.languages).toEqual(['ru', 'en']);

    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'gate_message.update'), eq(auditLog.branchId, branchId)));
    expect(row?.entityType).toBe('gate_messages');
    expect((row?.after as { changed: number }).changed).toBe(3);
    expect((row?.before as { changed: number }).changed).toBe(0);

    // Reading back gives what was saved.
    expect(((await read()).json() as GateMessagesRead).texts).toEqual(after.texts);

    // Reset: the defaults sent back leave no row behind.
    const reset = await put(bodyOf(defaultGateMessages()));
    expect(reset.statusCode, reset.body).toBe(200);
    expect((reset.json() as GateMessagesRead).changed).toBe(0);
    expect(await ctx.db.select().from(gateMessageText).where(eq(gateMessageText.branchId, branchId))).toHaveLength(0);
    expect(await ctx.db.select().from(gateMessageSetting).where(eq(gateMessageSetting.branchId, branchId))).toHaveLength(0);
  });

  it('refuses a text longer than 200 characters after cleaning, and a label longer than 40', async () => {
    const texts = defaultGateMessages();
    texts.cases.welcome.en = 'x'.repeat(201);
    const long = await put(bodyOf(texts));
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe('GATE_MESSAGE_TOO_LONG');
    const label = defaultGateMessages();
    label.labels.brand.en = 'y'.repeat(41);
    expect((await put(bodyOf(label))).statusCode).toBe(400);
    expect(await ctx.db.select().from(gateMessageText).where(eq(gateMessageText.branchId, branchId))).toHaveLength(0);
  });

  it('refuses a languages list that repeats a language or is empty', async () => {
    expect((await put({ languages: ['en', 'en'] })).statusCode).toBe(400);
    expect((await put({ languages: [] })).statusCode).toBe(400);
    expect((await put({ languages: ['de'] })).statusCode).toBe(400);
  });

  it('answers a repeated save with the same key once', async () => {
    const audits = async () =>
      (await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'gate_message.update'), eq(auditLog.branchId, branchId)))).length;
    const before = await audits();
    const texts = defaultGateMessages();
    texts.cases.GATE_BUSY.fr = 'Un instant';
    const key = newId();
    const first = await put(bodyOf(texts), admin, key);
    const again = await put(bodyOf(texts), admin, key);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await audits()).toBe(before + 1);
    await put(bodyOf(defaultGateMessages()));
  });
});

describe('the gate box', () => {
  it('is sent the wording only once the park changed something, and the box draws it', async () => {
    const [held] = await ctx.db.select().from(box).where(eq(box.branchId, branchId)).limit(1);
    expect(held).toBeDefined();
    const auth = boxAuthFromRow(held!);
    const plain = await configBundle(ctx.db, auth);
    expect(plain.gateMessages).toBeUndefined();

    // A box with a gate station on it, and still nothing changed: nothing new is sent.
    await ctx.db.insert(station).values({
      id: newId(),
      operatorId: held!.operatorId,
      branchId,
      boxId: held!.id,
      name: 'Gate messages test lane',
      kind: 'gate',
    });
    const withGate = await configBundle(ctx.db, auth);
    expect(withGate.gateMessages).toBeUndefined();

    const texts = defaultGateMessages();
    texts.languages = ['ru', 'en'];
    texts.cases.welcome.ru = 'Привет!';
    expect((await put(bodyOf(texts))).statusCode).toBe(200);
    const changed = await configBundle(ctx.db, auth);
    expect(changed.configVersion).not.toBe(withGate.configVersion);
    const wire = readGateMessagesWire(changed.gateMessages);
    expect(wire?.languages).toEqual(['ru', 'en']);
    expect(composeGateScreen(wire!, 'welcome').split('\n').slice(0, 3)).toEqual(['OTO PLAY PARK', '✅ ПРИВЕТ!', 'Welcome']);

    // Back to the defaults: the bundle is what it was.
    expect((await put(bodyOf(defaultGateMessages()))).statusCode).toBe(200);
    const back = await configBundle(ctx.db, auth);
    expect(back.gateMessages).toBeUndefined();
    expect(back.configVersion).toBe(withGate.configVersion);
  });
});
