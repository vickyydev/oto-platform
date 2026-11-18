// SCRUM-1011 staging proof, bounded by the rules of 19 November 2026.
//
// Staging sends the booking site's six-digit code as a real text message
// (Twilio; the api refuses to start with codes in its log anywhere but a
// developer's machine), so the family pass cannot be obtained for a ZZ TEST
// phone without texting a real number. This proof therefore stops before the
// code and checks, on the deployed services, only what writes nothing:
//   1. the booking site served is the new one (its bundle carries the new
//      review note in all five languages and calls the new save route);
//   2. the new save route refuses without a family pass for that phone, and
//      writes nothing;
//   3. a booking naming a saved child without the pass is refused before any
//      booking is written.
// No sign-in, no record made, no setting changed, nobody messaged. Run from
// the Desktop checkout's helpers: node <this file> <out-dir> <live-sha>
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELPERS = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/evidence.mjs';
const { launch, card, png, POS } = await import(pathToFileURL(HELPERS).href);

const outDir = resolve(process.argv[2]);
const liveSha = process.argv[3] ?? 'unknown';
mkdirSync(outDir, { recursive: true });

// A made-up number in a range that is not texted: nothing below sends a message.
const FAKE_PHONE = '0800001011';
const NOTE = {
  en: 'saved to your family\'s record when you continue to payment, whether or not you pay',
  zh: '保存到家庭记录中（无论是否付款）',
  th: 'ไม่ว่าจะชำระเงินหรือไม่ก็ตาม',
  ru: 'оплатите вы или нет',
  fr: 'que vous payiez ou non',
};

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${POS}/book`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const bookShot = resolve(outDir, '01-booking-site-live.png');
await page.screenshot({ path: bookShot, fullPage: false });

const result = await page.evaluate(async ({ fakePhone, pass, childId, note }) => {
  const out = {};
  // 1. The bundle the booking site runs.
  // Every script the page loaded, the entry and the chunks it pulled in.
  const sources = [...new Set([
    ...[...document.querySelectorAll('script[src]')].map((s) => s.src),
    ...performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /\.js(\?|$)/.test(n)),
  ])].filter((src) => src.startsWith(location.origin));
  let text = '';
  for (const src of sources) text += await (await fetch(src)).text();
  // A minifier may write non-ASCII letters as \uXXXX escapes.
  const lower = text.toLowerCase();
  const escaped = (v) => [...v].map((ch) => (ch.charCodeAt(0) > 126 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch)).join('').toLowerCase();
  const has = (v) => text.includes(v) || lower.includes(escaped(v));
  out.bundle = {
    scripts: sources.length,
    saveRoute: has('/public/saved-children/save'),
    note: Object.fromEntries(Object.entries(note).map(([k, v]) => [k, has(v)])),
    oldNoteGone: !has('apply to this booking only'),
  };
  // 2. The save route without a family pass for this phone.
  const parks = await (await fetch('/api/public/branches/hkt-central/parks')).json();
  const branch = parks.branches?.[0]?.code ?? 'hkt-central';
  const save = await fetch('/api/public/saved-children/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: fakePhone, branch, pass, children: [], remove: [childId] }),
  });
  out.save = { status: save.status, body: await save.json() };
  // 3. A booking naming a saved child, without the pass.
  const cat = await (await fetch(`/api/public/branches/${branch}/catalog`)).json();
  const pkg = cat.packages.find((p) => p.name === '1 Hour Play') ?? cat.packages[0];
  const confirmations = cat.supervision.policy.confirmations.filter((c) => c.required).map((c) => c.id);
  const booking = await fetch('/api/public/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      branchCode: branch,
      phone: fakePhone,
      parentName: 'ZZ TEST 1011 proof',
      tier: 'tourist',
      consentAck: true,
      acknowledgedConfirmationIds: confirmations,
      lines: [{ packageId: pkg.id, kids: 1, adults: 0, supervision: { childName: 'ZZ TEST child', ageYears: 6, savedChildId: childId } }],
    }),
  });
  out.booking = { status: booking.status, body: await booking.json(), branch, package: pkg.name };
  return out;
}, { fakePhone: FAKE_PHONE, pass: randomBytes(32).toString('hex'), childId: randomUUID(), note: NOTE });

writeFileSync(resolve(outDir, 'receipt.json'), JSON.stringify({ liveSha, capturedAt: new Date().toISOString(), result }, null, 2));

const okBundle = result.bundle.saveRoute && Object.values(result.bundle.note).every(Boolean) && result.bundle.oldNoteGone;
const okSave = result.save.status === 403 && result.save.body?.error?.code === 'FAMILY_CHECK_EXPIRED';
const okBooking = result.booking.status === 403 && result.booking.body?.error?.code === 'FAMILY_CHECK_EXPIRED';
const cardPage = await (await browser.newContext()).newPage();
await cardPage.goto('about:blank');
await card(cardPage, {
  title: 'SCRUM-1011 on staging: what can be checked without a real text message',
  subtitle: 'Booking site and api at the landed source; no sign-in, no record made, no setting changed, nobody messaged',
  identity: 'No sign-in: the booking site is open to the public, as a family meets it',
  deploy: `live: ${liveSha}`,
  rows: [
    { ok: okBundle, tag: okBundle ? 'PASS' : 'FAIL', head: 'The booking site served is the new one',
      note: 'its code calls the new save route and carries the new review note in all five languages; the old "this booking only" note is gone',
      body: JSON.stringify(result.bundle, null, 1) },
    { ok: okSave, tag: okSave ? 'PASS' : 'FAIL', head: 'Saving to a family record without its family pass is refused',
      note: 'a made-up pass for a phone: 403, nothing written',
      body: `${result.save.status} ${result.save.body?.error?.code}: ${result.save.body?.error?.message}` },
    { ok: okBooking, tag: okBooking ? 'PASS' : 'FAIL', head: 'A booking naming a saved child without the pass is refused',
      note: 'refused before any booking is written',
      body: `${result.booking.status} ${result.booking.body?.error?.code}: ${result.booking.body?.error?.message}` },
    { ok: false, tag: 'STOP', head: 'The family walk-through stops at the SMS code',
      note: 'staging texts the code to the real phone (Twilio); a ZZ TEST phone would mean texting a stranger, so the rest is proved by the automatic tests',
      body: 'Not shown live: change an allergy, add a sibling, remove a saved child, pick a contact app, confirm without paying, then the record at the till.\nProved by apps/api/test/s1011-family-record-online.test.ts (11) and apps/pos/test/s1011-book-family-record.test.ts (10).' },
  ],
  images: [{ heading: 'The booking site, live', items: [{ label: 'First screen of /book on staging', url: `${POS}/book`, src: png(bookShot) }] }],
}, resolve(outDir, '02-staging-checks-card.png'));

await browser.close();
console.log(JSON.stringify({ okBundle, okSave, okBooking }));
