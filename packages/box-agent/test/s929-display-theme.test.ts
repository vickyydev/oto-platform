import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { StationSessionDocumentSchema } from '@oto/shared';
import type { StationChannelMessage, StationSessionDocument } from '../src/contract';
import { StationSessionManager } from '../src/station-session';
import { SqlBoxStore } from '../src/store-sql';
import { addSqliteSessionTheme, prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, STATION_ID } from './_support';

/**
 * SCRUM-929 — THE TILL'S DISPLAY SWITCH REACHES A PAIRED DISPLAY.
 *
 * The till's Theme > Display switch changed only the customer half drawn on
 * the till itself: a separate display, paired to the station, was always
 * dark, because nothing the till published carried a look. Now a publication
 * may carry `theme`, the box keeps it with the document until a till tells it
 * another, and every screen watching the station is sent it.
 *
 * Additive for older parts. A document says `theme: null` until a till tells
 * one, and a till sends a theme only to a box whose document has the field, so
 * an older box (which refuses a publication with a field it does not know) is
 * never sent one. A card from before this round gains the column at start.
 */

const AT = '2026-11-12T03:00:00.000Z';
const STAFF = '018f0000-0000-7000-8000-0000000000a1';

const till = { source: 'till' as const, accountId: STAFF };

interface Harness {
  db: DatabaseSync;
  manager: StationSessionManager;
  close(): void;
}

function openManager(db = new DatabaseSync(':memory:'), prepare = true): Harness {
  if (prepare) prepareSqliteBoxStore(db);
  const now = new Date(AT);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  const manager = new StationSessionManager({
    store,
    boxId: BOX_ID,
    resolveStation: (stationId) =>
      stationId === STATION_ID ? { stationId, boxId: BOX_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID } : null,
    queueFact: async () => undefined,
    now: () => now,
  });
  return { db, manager, close: () => db.close() };
}

/** The ticket till's welcome frame, as `ticketDisplayPresentation` sends it. */
const welcomeFrame = (theme?: string) => ({
  stage: 'welcome', step: 2, cart: { supported: true, sale: { tier: 'tourist' } }, member: null, totals: null, payment: null,
  prompt: null, ...(theme === undefined ? {} : { theme }),
});

/** The F&B station's welcome frame, as `fnbDisplayPresentation` sends it. */
const fnbWelcomeFrame = (theme?: string) => ({
  stage: 'welcome', step: null, cart: { kind: 'fnb', supported: true, lines: [], orderNote: '', manualDiscounts: [], completion: null },
  member: null, totals: null, payment: null, prompt: null, ...(theme === undefined ? {} : { theme }),
});

async function claim(h: Harness, holder = 'tab-1') {
  const claimed = await h.manager.claim({ stationId: STATION_ID, holder, holderKind: 'till', accountId: STAFF });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  if (!claimed.ok) throw new Error('unreachable');
  return claimed;
}

async function publish(h: Harness, leaseId: string, lastSeenSequence: number, payload: Record<string, unknown>) {
  return h.manager.applyIntent(STATION_ID,
    { type: 'session.publish_display', leaseId, lastSeenSequence, actionId: `publish-${lastSeenSequence}`, payload }, till);
}

async function published(h: Harness, leaseId: string, lastSeenSequence: number, payload: Record<string, unknown>) {
  const result = await publish(h, leaseId, lastSeenSequence, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.document;
}

test('SCRUM-929: a station never told a look says so, with the field there for a till to see', async () => {
  const h = openManager();
  try {
    const claimed = await claim(h);
    assert.equal('theme' in claimed.document, true);
    assert.equal(claimed.document.theme, null);
  } finally { h.close(); }
});

test('SCRUM-929: the look a till publishes is kept with the document and sent to the display', async () => {
  const h = openManager();
  try {
    const claimed = await claim(h);
    const seen: StationChannelMessage[] = [];
    const unsubscribe = h.manager.subscribe(STATION_ID, 'customer', (message) => { seen.push(message); });
    let shown: StationSessionDocument;
    try {
      shown = await published(h, claimed.lease.leaseId, claimed.document.sequence, welcomeFrame('light'));
    } finally { unsubscribe(); }
    assert.equal(shown.theme, 'light');
    assert.equal((await h.manager.open(STATION_ID)).theme, 'light');
    const snapshot = seen.find((message) => message.kind === 'snapshot');
    assert.ok(snapshot && snapshot.kind === 'snapshot');
    assert.equal(snapshot.view, 'customer');
    assert.equal(snapshot.document.theme, 'light', 'the redacted display view carries the look');
    // What the display's own read parses it with keeps it too.
    assert.equal(StationSessionDocumentSchema.parse(snapshot.document).theme, 'light');
  } finally { h.close(); }
});

test('SCRUM-929: a switch with nothing else changed is a publication of its own and moves the fence', async () => {
  const h = openManager();
  try {
    const claimed = await claim(h);
    const light = await published(h, claimed.lease.leaseId, claimed.document.sequence, welcomeFrame('light'));
    const dark = await published(h, claimed.lease.leaseId, light.sequence, welcomeFrame('dark'));
    assert.equal(dark.theme, 'dark');
    assert.equal(dark.sequence, light.sequence + 1);
    assert.equal(dark.stage, light.stage);
    assert.deepEqual(dark.cart, light.cart);
  } finally { h.close(); }
});

test('SCRUM-929: a publication without a look, a release and the next till leave the told look alone', async () => {
  const h = openManager();
  try {
    const claimed = await claim(h);
    const told = await published(h, claimed.lease.leaseId, claimed.document.sequence, welcomeFrame('light'));
    // An older till, or a till nobody has pressed Display on, says nothing about it.
    const quiet = await published(h, claimed.lease.leaseId, told.sequence, welcomeFrame());
    assert.equal(quiet.theme, 'light');
    // SCRUM-870: giving the station up clears the sale from the screen, not its look.
    const released = await h.manager.release(STATION_ID, claimed.lease.leaseId, { accountId: STAFF });
    assert.deepEqual(released, { ok: true, released: true });
    const idle = await h.manager.open(STATION_ID);
    assert.equal(idle.cart, null);
    assert.equal(idle.theme, 'light');
    // The F&B station takes the screen, and its publication carries the look the same way.
    const fnb = await claim(h, 'fnb-tab');
    assert.equal(fnb.document.theme, 'light');
    const fnbShown = await published(h, fnb.lease.leaseId, fnb.document.sequence, fnbWelcomeFrame());
    assert.equal(fnbShown.theme, 'light');
    const fnbDark = await published(h, fnb.lease.leaseId, fnbShown.sequence, fnbWelcomeFrame('dark'));
    assert.equal(fnbDark.theme, 'dark');
  } finally { h.close(); }
});

test('SCRUM-929: anything but light or dark is refused, and the screen is left as it was', async () => {
  const h = openManager();
  try {
    const claimed = await claim(h);
    const told = await published(h, claimed.lease.leaseId, claimed.document.sequence, welcomeFrame('dark'));
    for (const theme of ['blue', '', 'LIGHT', null, 1, { theme: 'light' }]) {
      const refused = await publish(h, claimed.lease.leaseId, told.sequence, { ...welcomeFrame(), theme });
      assert.equal(refused.ok, false, JSON.stringify(theme));
      if (refused.ok) return;
      assert.equal(refused.refusal, 'not_permitted');
    }
    const kept = await h.manager.open(STATION_ID);
    assert.equal(kept.theme, 'dark');
    assert.equal(kept.sequence, told.sequence);
  } finally { h.close(); }
});

test('SCRUM-929: a display cannot set the look; only a till holding the station can', async () => {
  const h = openManager();
  try {
    const claimed = await claim(h);
    const refused = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claimed.lease.leaseId,
      lastSeenSequence: claimed.document.sequence, actionId: 'display-theme', payload: welcomeFrame('light') },
    { source: 'display', deviceId: 'display-1' });
    assert.equal(refused.ok, false);
    assert.equal((await h.manager.open(STATION_ID)).theme, null);
  } finally { h.close(); }
});

test('SCRUM-929: a card from before this round gains the column at start, and its rows read as never told', async () => {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  // The card as an older agent left it: no theme column on its station session.
  db.exec('alter table station_session drop column theme');
  const before = openManager(db, false);
  const old = await claim(before);
  // A store without the column leaves the field out, so no till sends this box a look.
  assert.equal('theme' in old.document, false);
  assert.equal(StationSessionDocumentSchema.parse(old.document).theme, undefined);

  // The box restarts on this build.
  prepareSqliteBoxStore(db);
  assert.equal(addSqliteSessionTheme(db), false, 'once added, a later start leaves it alone');
  const after = openManager(db, false);
  try {
    const kept = await after.manager.open(STATION_ID);
    assert.equal(kept.theme, null);
    assert.equal(kept.sequence, old.document.sequence, 'the row itself is untouched');
    const shown = await published(after, old.lease.leaseId, kept.sequence, welcomeFrame('light'));
    assert.equal(shown.theme, 'light');
  } finally { after.close(); }
});

test('SCRUM-929: a reader from before the field drops it harmlessly and still reads the document', () => {
  // The station document as every screen parsed it before this round.
  const OlderDocumentSchema = StationSessionDocumentSchema.omit({ theme: true });
  const document = {
    stationId: STATION_ID, boxId: BOX_ID, schemaVersion: 1, sequence: 4, stage: 'welcome', step: null,
    cart: { supported: true, sale: { tier: 'tourist' } }, member: null, totals: null, payment: null, prompt: null,
    language: 'en', theme: 'light', lease: null, takeoverCount: 0, updatedAt: AT,
  };
  const older = OlderDocumentSchema.parse(document);
  assert.equal('theme' in older, false);
  assert.equal(older.sequence, 4);
  assert.deepEqual(older.cart, document.cart);
  // And this round's reader takes a document from an older box, which has no field at all.
  const fromOlderBox: Record<string, unknown> = { ...document };
  delete fromOlderBox.theme;
  const current = StationSessionDocumentSchema.parse(fromOlderBox);
  assert.equal('theme' in current, false);
});
