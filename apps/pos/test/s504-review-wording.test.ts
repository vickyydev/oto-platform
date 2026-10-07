import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KIOSK_REASONS, KioskRedeemAnswerSchema, type KioskRedeemAnswer } from '@oto/shared';
import { KioskResult } from '@/components/kiosk/KioskScreens';
import { DICTIONARY } from '@/i18n/dictionary';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { LANGUAGES, type SupportedLang } from '@/i18n/types';
import { deskReasonOf, kioskScreenOf } from '@/lib/kiosk';

/**
 * SCRUM-504 — INDEPENDENT REVIEW of fix lane F1, the wording (review brief
 * item 5): in all five languages, no kiosk screen tells a guest "nothing was
 * used up" when wristbands came out of a set that was called off, whatever
 * the reason the set stopped for; and the desk is told to take them back.
 */

Object.assign(globalThis, { React });

function answer(overrides: Partial<KioskRedeemAnswer> = {}): KioskRedeemAnswer {
  return KioskRedeemAnswerSchema.parse({
    sessionId: '01a33333-0000-7000-8000-000000000504',
    outcome: 'issued',
    reason: null,
    replay: false,
    booking: { reference: 'OTO-S504-0001', kids: 3, adults: 2 },
    bands: [],
    walletCreditSatang: 0,
    desk: { required: false, supervisedChildren: 0 },
    alreadyRedeemed: null,
    ...overrides,
  });
}
const failed = (reason: string, calledOffBands?: number) =>
  answer({
    outcome: 'failed',
    reason,
    desk: { required: true, supervisedChildren: 0 },
    ...(calledOffBands === undefined ? {} : { calledOffBands }),
  });

function inLanguage(lang: SupportedLang, child: ReactElement): string {
  vi.stubGlobal('window', { localStorage: { getItem: () => lang, setItem: () => undefined } });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 's504.review.lang', children: child }));
}
const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const screenText = (lang: SupportedLang, a: KioskRedeemAnswer) =>
  textOf(inLanguage(lang, createElement(KioskResult, { screen: kioskScreenOf(a), onDone: () => undefined, onScanAgain: () => undefined })));

afterEach(() => vi.unstubAllGlobals());

/**
 * Every reason a session can end `failed` with once its print has begun: the
 * box agent's printer codes, the kiosk's own stops, and the catch-alls.
 */
const AFTER_PRINT_BEGAN = [
  'PRINTER_UNREACHABLE',
  'PRINTER_OFFLINE',
  'PRINTER_PAPER_OUT',
  'PRINTER_PAPER_JAM',
  'PRINTER_HEAD_OPEN',
  'PRINTER_COVER_OPEN',
  'PRINTER_WRITE_FAILED',
  'PRINTER_SILENT_BEFORE_JOB',
  'PRINTER_SILENT_AFTER_JOB',
  'PRINTER_NO_STATUS',
  'PRINT_FAILED',
  KIOSK_REASONS.printTimeout,
  KIOSK_REASONS.printHoldLost,
  KIOSK_REASONS.internal,
];

describe('item 5 — the guest wording when wristbands came out', () => {
  for (const { code: lang } of LANGUAGES) {
    it(`${lang}: never "nothing was used up" with a band in the tray, always the hand-them-in line`, () => {
      const nothingUsed = DICTIONARY['kiosk.printer.subtitle']![lang];
      const partial = DICTIONARY['kiosk.printer.partial']![lang];
      expect(partial, 'translated, not the English copy').toBeTruthy();
      if (lang !== 'en') expect(partial).not.toBe(DICTIONARY['kiosk.printer.partial']!.en);
      for (const reason of AFTER_PRINT_BEGAN) {
        for (const n of [1, 3]) {
          const text = screenText(lang, failed(reason, n));
          expect(text, `${lang} ${reason} ${n}`).toContain(partial);
          expect(text, `${lang} ${reason} ${n}`).not.toContain(nothingUsed);
          expect(text, `${lang} ${reason} ${n}: no key leaks`).not.toMatch(/kiosk\.[a-zA-Z]+\./);
        }
      }
      // No band out: the printer screens say nothing was used up, as before, and never "may have come out".
      for (const reason of ['PRINTER_UNREACHABLE', 'PRINTER_PAPER_OUT', KIOSK_REASONS.printTimeout]) {
        const text = screenText(lang, failed(reason, 0));
        expect(text, `${lang} ${reason}`).toContain(nothingUsed);
        expect(text, `${lang} ${reason}`).not.toContain(partial);
        expect(screenText(lang, failed(reason))).not.toContain(partial);
      }
      // A count on an ending that issued is never read as a part-printed set.
      expect(screenText(lang, answer({ calledOffBands: 2 }))).not.toContain(partial);
    });
  }
});

describe('item 5 — the desk wording', () => {
  it('every failed reason with bands out tells the desk to take them back, in the right number', () => {
    for (const reason of AFTER_PRINT_BEGAN) {
      const one = deskReasonOf({ outcome: 'failed', reason, supervisedChildren: 0, bandsIssued: 0, calledOffBands: 1 });
      const many = deskReasonOf({ outcome: 'failed', reason, supervisedChildren: 0, bandsIssued: 0, calledOffBands: 3 });
      expect(one, reason).toMatch(/1 wristband may have come out at the kiosk — take it back from the family; it opens nothing at the gate\.$/);
      expect(many, reason).toMatch(/3 wristbands may have come out at the kiosk — take them back from the family; they open nothing at the gate\.$/);
      expect(deskReasonOf({ outcome: 'failed', reason, supervisedChildren: 0, bandsIssued: 0, calledOffBands: 0 }), reason).not.toMatch(
        /may have come out/,
      );
    }
    // A hand-off never carries a call-off line.
    expect(
      deskReasonOf({ outcome: 'handed_off', reason: KIOSK_REASONS.supervisedRest, supervisedChildren: 1, bandsIssued: 2, calledOffBands: 0 }),
    ).not.toMatch(/may have come out/);
  });
});
