import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { Fragment, createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertTriangle, Baby, CheckCircle2, Ticket, Users } from 'lucide-react';
import { KIOSK_REASONS, KioskRedeemAnswerSchema, type KioskRedeemAnswer } from '@oto/shared';
import {
  KioskAttract,
  KioskResult,
  KioskScan,
  KioskShell,
  KioskWorking,
} from '@/components/kiosk/KioskScreens';
import {
  RedeemBandCodes,
  RedeemCallout,
  RedeemCountRow,
  RedeemOutcomeHeader,
} from '@/components/till/redeemParts';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { LANGUAGES, type SupportedLang } from '@/i18n/types';
import { kioskScreenOf, type KioskScreenKind } from '@/lib/kiosk';

/**
 * S2-20 K2 (SCRUM-217) — FOCUSED REVIEW OF THE KIOSK SURFACE, its screens as
 * a guest's browser would draw them (server-rendered markup, no DOM needed).
 *
 *   1. each failure screen, in each of the five languages, says its own
 *      thing in guest words: never a reason code, never an untranslated key,
 *      always a way back (Done);
 *   3. nothing staff-only on `/kiosk`: no staff chrome in any kiosk screen,
 *      the route outside every staff provider, and no staff-only module
 *      imported by the kiosk's files;
 *   6. reuse: the kiosk is built from the redeem dialog's own parts, the parts
 *      draw the dialog exactly as it was on main, and no private copy of them
 *      exists anywhere in the till's source.
 */

// The components are compiled with the classic JSX runtime in this runner (as eod-r1.test.ts does).
Object.assign(globalThis, { React });

const SRC = path.resolve(import.meta.dirname, '../src');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

function answer(overrides: Partial<KioskRedeemAnswer> = {}): KioskRedeemAnswer {
  return KioskRedeemAnswerSchema.parse({
    sessionId: '01a33333-0000-7000-8000-0000000000ff',
    outcome: 'issued',
    reason: null,
    replay: false,
    booking: { reference: 'OTO-REVW-0003', kids: 2, adults: 1 },
    bands: [
      { kind: 'kid', shortCode: 'K1-AAAA' },
      { kind: 'kid', shortCode: 'K1-BBBB' },
      { kind: 'adult', shortCode: 'K1-CCCC' },
    ],
    walletCreditSatang: 30_000,
    desk: { required: false, supervisedChildren: 0 },
    alreadyRedeemed: null,
    ...overrides,
  });
}
const failed = (reason: string, extra: Partial<KioskRedeemAnswer> = {}) =>
  answer({ outcome: 'failed', reason, bands: [], walletCreditSatang: 0, desk: { required: true, supervisedChildren: 0 }, ...extra });

const ENDINGS: Array<{ what: string; answer: KioskRedeemAnswer; screen: KioskScreenKind }> = [
  { what: 'printer offline', answer: failed('PRINTER_UNREACHABLE'), screen: 'printer' },
  { what: 'paper out', answer: failed('PRINTER_PAPER_OUT'), screen: 'printer' },
  { what: 'box offline', answer: failed(KIOSK_REASONS.boxOffline), screen: 'offline' },
  {
    what: 'already redeemed',
    answer: failed('BOOKING_ALREADY_REDEEMED', {
      alreadyRedeemed: { at: '2026-10-07T03:00:00.000Z', branchName: 'Central', stationName: 'Kiosk 1' },
    }),
    screen: 'already',
  },
  { what: 'not paid', answer: failed('BOOKING_NOT_REDEEMABLE'), screen: 'not_paid' },
  { what: 'not a booking', answer: failed(KIOSK_REASONS.notABookingQr, { booking: null }), screen: 'unrecognised' },
  { what: 'another park', answer: failed(KIOSK_REASONS.otherBranch), screen: 'other_branch' },
  { what: 'internal', answer: failed(KIOSK_REASONS.internal), screen: 'desk' },
  {
    what: 'drop-off only',
    answer: answer({
      outcome: 'handed_off',
      reason: KIOSK_REASONS.supervised,
      bands: [],
      walletCreditSatang: 0,
      desk: { required: true, supervisedChildren: 1 },
    }),
    screen: 'desk_supervised',
  },
  {
    what: 'mixed',
    answer: answer({ outcome: 'handed_off', reason: KIOSK_REASONS.supervisedRest, desk: { required: true, supervisedChildren: 1 } }),
    screen: 'done_desk',
  },
  { what: 'issued', answer: answer(), screen: 'done' },
];

/** The guest's language, as the kiosk's provider would hold it after a tap on the pill. */
function inLanguage(lang: SupportedLang, child: ReactElement): string {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => lang, setItem: () => undefined },
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'review.kiosk.lang', children: child }));
}

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const noop = () => undefined;

/** Words that only ever belong on a staff screen. */
const STAFF_ONLY = /\b(Sign in|Sign out|Lock|Admin|Console|Reception|Till|Shift|Cash|Refund|Manager|Staff|History|Messages|F&amp;B|Shop)\b/;

afterEach(() => vi.unstubAllGlobals());

// --- 1 ------------------------------------------------------------------------------

describe('attack 1 — every failure screen, in every language, in guest words with a way back', () => {
  for (const { code: lang } of LANGUAGES) {
    it(`${lang}: each ending draws its own screen, no code, no raw key, and Done`, () => {
      const texts = new Map<string, string>();
      for (const e of ENDINGS) {
        const screen = kioskScreenOf(e.answer);
        expect(screen.kind, e.what).toBe(e.screen);
        const html = inLanguage(lang, createElement(KioskResult, { screen, onDone: noop, onScanAgain: noop }));
        const text = textOf(html);
        expect(html, e.what).toContain(`data-testid="kiosk-result-${e.screen}"`);
        // Never a reason code, never an untranslated key.
        expect(text, `${lang} ${e.what}`).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}/);
        expect(text, `${lang} ${e.what}`).not.toMatch(/\b(kiosk|common|till)\.[A-Za-z]+/);
        // Always a way back: the Done button (and Scan again where a second try makes sense).
        expect((html.match(/<button/g) ?? []).length, `${lang} ${e.what}`).toBeGreaterThanOrEqual(1);
        if (e.screen === 'unrecognised') expect((html.match(/<button/g) ?? []).length).toBe(2);
        texts.set(e.what, text);
      }
      // Each failure says its own thing: no two endings draw the same words.
      const all = [...texts.values()];
      expect(new Set(all).size, `${lang}: two endings read the same`).toBe(all.length);
      // Paper out is told in a word of its own.
      expect(texts.get('paper out')).not.toBe(texts.get('printer offline'));
    });
  }

  it('already redeemed says when and where — the park and the kiosk, never a person', () => {
    const e = ENDINGS.find((x) => x.screen === 'already')!;
    const text = textOf(inLanguage('en', createElement(KioskResult, { screen: kioskScreenOf(e.answer), onDone: noop, onScanAgain: noop })));
    expect(text).toContain('Central (Kiosk 1)');
    expect(text).toMatch(/already been used/);
  });

  it('a printer fault tells the guest nothing was used up; paper out says paper', () => {
    const off = textOf(inLanguage('en', createElement(KioskResult, { screen: kioskScreenOf(failed('PRINTER_UNREACHABLE')), onDone: noop, onScanAgain: noop })));
    const paper = textOf(inLanguage('en', createElement(KioskResult, { screen: kioskScreenOf(failed('PRINTER_PAPER_OUT')), onDone: noop, onScanAgain: noop })));
    expect(off).toMatch(/still ready/);
    expect(paper).toMatch(/paper/i);
    expect(off).not.toMatch(/paper/i);
  });
});

// --- 3 ------------------------------------------------------------------------------

describe('attack 3 — nothing staff-only on /kiosk', () => {
  it('no kiosk screen draws staff chrome, in any language', () => {
    const screens: Array<[string, ReactNode]> = [
      ['attract', createElement(KioskAttract, { resting: false, onStart: noop })],
      ['resting', createElement(KioskAttract, { resting: true, onStart: noop })],
      ['scan', createElement(KioskScan, { onStartOver: noop })],
      ['working', createElement(KioskWorking)],
      ...ENDINGS.map((e): [string, ReactNode] => [
        e.what,
        createElement(KioskResult, { screen: kioskScreenOf(e.answer), onDone: noop, onScanAgain: noop }),
      ]),
    ];
    for (const { code: lang } of LANGUAGES) {
      for (const [what, body] of screens) {
        const html = inLanguage(lang, createElement(KioskShell, { children: body }));
        expect(html, `${lang} ${what}`).not.toMatch(STAFF_ONLY);
        expect(html, `${lang} ${what}`).not.toMatch(/<nav\b|<input\b|type="password"/);
        expect(html, `${lang} ${what}`).not.toMatch(/allerg|medical|guardian|\+66\d{8,9}|\b0\d{9}\b/i);
      }
    }
  });

  it('the /kiosk route sits outside every staff provider, as /display does', () => {
    const app = read('App.tsx');
    const kioskRoute = app.match(/<Route path="\/kiosk">([\s\S]*?)<\/Route>/);
    expect(kioskRoute).not.toBeNull();
    // Only the tooltip and language providers around the kiosk page.
    const tags = [...kioskRoute![1]!.matchAll(/<([A-Z][A-Za-z]*)/g)].map((m) => m[1]);
    expect(tags).toEqual(['TooltipProvider', 'LanguageProvider', 'Kiosk']);
    // Matched before the staff app's catch-all.
    expect(app.indexOf('<Route path="/kiosk">')).toBeLessThan(app.indexOf('<Route component={StaffApp} />'));
  });

  it("the kiosk's own files import nothing that belongs to a staff session", () => {
    const files = ['pages/Kiosk.tsx', 'components/kiosk/KioskScreens.tsx', 'lib/kiosk.ts', 'api/kiosk.ts'];
    for (const file of files) {
      const imports = [...read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(
          /@\/api\/client|@\/auth\/|@\/station\/|@\/store\/|@\/branch\/|@\/components\/(admin|layout|header)|@\/pages\/(Till|Admin)|staffToken|KioskDeskPanel|kioskDesk/,
        );
      }
    }
    // The staff desk's words stay off the guest's screen.
    expect(read('components/kiosk/KioskScreens.tsx')).not.toMatch(/deskReasonOf/);
    // And the kiosk client never sends a staff cookie.
    expect(read('api/kiosk.ts')).toMatch(/credentials: 'omit'/);
  });
});

// --- 6 ------------------------------------------------------------------------------

describe('attack 6 — reuse: the redeem dialog’s own parts, no private copies', () => {
  const html = (node: ReactElement) => renderToStaticMarkup(node);
  const h = createElement;

  it('the parts draw the dialog exactly as main drew it', () => {
    // The issued head, as RedeemBookingModal had it inline on main.
    const oldIssued = h(
      'div',
      { className: 'flex flex-col items-center text-center gap-3 py-4' },
      h('div', { className: 'w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center' }, h(CheckCircle2, { className: 'w-8 h-8 text-primary' })),
      h(
        'div',
        null,
        h('p', { className: 'font-semibold text-lg' }, "Redeemed on this counter's box"),
        h('p', { className: 'font-mono text-muted-foreground mt-0.5' }, 'OTO-REVW-0003'),
        h('p', { className: 'text-sm text-muted-foreground mt-0.5' }, 'Receipt ', 'R-1'),
      ),
    );
    expect(
      html(
        h(RedeemOutcomeHeader, {
          tone: 'ok',
          title: "Redeemed on this counter's box",
          reference: 'OTO-REVW-0003',
          children: h('p', { className: 'text-sm text-muted-foreground mt-0.5' }, 'Receipt ', 'R-1'),
        }),
      ),
    ).toBe(html(oldIssued));

    const oldAlready = h(
      'div',
      { className: 'flex flex-col items-center text-center gap-3 py-4' },
      h(
        'div',
        { className: 'w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center' },
        h(AlertTriangle, { className: 'w-8 h-8 text-amber-500' }),
      ),
      h(
        'div',
        null,
        h('p', { className: 'font-semibold text-lg' }, 'Already redeemed'),
        h('p', { className: 'font-mono text-muted-foreground mt-0.5' }, 'OTO-REVW-0003'),
      ),
    );
    expect(html(h(RedeemOutcomeHeader, { tone: 'warn', title: 'Already redeemed', reference: 'OTO-REVW-0003' }))).toBe(
      html(oldAlready),
    );

    const oldRow = h('div', { className: 'flex items-center gap-2 text-muted-foreground' }, h(Users, { className: 'w-4 h-4 shrink-0' }), h('span', null, 2, ' adult', 's'));
    expect(html(h(RedeemCountRow, { icon: Users, children: h(Fragment, null, 2, ' adult', 's') }))).toBe(html(oldRow));
    const oldWide = h('div', { className: 'flex items-center gap-2 text-muted-foreground col-span-2' }, h(Baby, { className: 'w-4 h-4 shrink-0' }), h('span', null, 'Drop-off: ', 'Ploy'));
    expect(html(h(RedeemCountRow, { icon: Baby, wide: true, children: h(Fragment, null, 'Drop-off: ', 'Ploy') }))).toBe(html(oldWide));

    const oldAmber = h(
      'div',
      {
        className:
          'flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2',
      },
      h(Baby, { className: 'w-3.5 h-3.5 mt-0.5 shrink-0' }),
      h('span', null, 'note'),
    );
    expect(html(h(RedeemCallout, { tone: 'amber', icon: Baby, children: 'note' }))).toBe(html(oldAmber));
    const oldViolet = h(
      'div',
      {
        className:
          'flex items-start gap-2 text-xs text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 rounded-lg px-3 py-2',
      },
      h(Ticket, { className: 'w-3.5 h-3.5 mt-0.5 shrink-0' }),
      h('span', null, 'pass'),
    );
    expect(html(h(RedeemCallout, { tone: 'violet', icon: Ticket, children: 'pass' }))).toBe(html(oldViolet));

    const oldCodes = h(
      'div',
      { className: 'flex flex-wrap gap-x-3 gap-y-0.5', 'data-testid': 'band-codes' },
      h('span', { key: 'b1', className: 'whitespace-nowrap' }, h('span', { className: 'font-mono font-semibold text-foreground' }, 'K1-AAAA'), h('span', { className: 'text-muted-foreground' }, ' ', 'Ploy')),
      h('span', { key: 'b2', className: 'whitespace-nowrap' }, h('span', { className: 'font-mono font-semibold text-foreground' }, 'No code'), null),
    );
    expect(
      html(
        h(RedeemBandCodes, {
          noCode: 'No code',
          bands: [
            { key: 'b1', shortCode: 'K1-AAAA', label: 'Ploy' },
            { key: 'b2', shortCode: null, label: null },
          ],
        }),
      ),
    ).toBe(html(oldCodes));
  });

  it('the kiosk and the dialog import the one set of parts, and nobody keeps a copy', () => {
    const screens = read('components/kiosk/KioskScreens.tsx');
    expect(screens).toMatch(/from '@\/components\/till\/redeemParts'/);
    for (const part of ['RedeemOutcomeHeader', 'RedeemCountRow', 'RedeemCallout', 'RedeemBandCodes']) {
      expect(screens, `the kiosk uses ${part}`).toContain(`<${part}`);
    }
    const modal = read('components/till/RedeemBookingModal.tsx');
    expect(modal).toMatch(/from '\.\/redeemParts'/);
    for (const part of ['RedeemOutcomeHeader', 'RedeemCountRow', 'RedeemCallout', 'RedeemBandCodes']) {
      expect(modal, `the dialog uses ${part}`).toContain(`<${part}`);
    }

    // Every source file of the till: the parts are defined once, and their markup lives once.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(name)) files.push(full);
      }
    };
    walk(SRC);
    const PARTS_FILE = path.join(SRC, 'components/till/redeemParts.tsx');
    const markers = [
      /function\s+(RedeemOutcomeHeader|RedeemCountRow|RedeemCallout|RedeemBandCodes)\b/,
      /w-16 h-16 rounded-full bg-primary\/10 flex items-center justify-center/,
      /w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-950\/40/,
      /Wristband codes|data-testid="band-codes"/,
    ];
    for (const file of files) {
      if (file === PARTS_FILE) continue;
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(SRC, file);
      for (const marker of markers.slice(0, 1)) expect(text, `${rel} defines a redeem part of its own`).not.toMatch(marker);
      if (rel.startsWith('components/kiosk') || rel.startsWith('pages/Kiosk')) {
        for (const marker of markers.slice(1)) expect(text, `${rel} copies the dialog's markup`).not.toMatch(marker);
      }
    }
    // The dialog itself kept none of the moved markup inline.
    expect(modal).not.toMatch(markers[1]!);
    expect(modal).not.toMatch(markers[2]!);
    expect(modal).not.toMatch(/data-testid="band-codes"/);
  });
});
