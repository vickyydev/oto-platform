// SCRUM-897 point 3: one picture from runs 02 and 03 (their receipts and till crops). Reads files only; touches no service.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { chromium } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const here = import.meta.dirname;
const r2 = JSON.parse(readFileSync(resolve(here, 'out-run-02/receipt.json'), 'utf8'));
const r3 = JSON.parse(readFileSync(resolve(here, 'out-run-03/receipt.json'), 'utf8'));
const w2 = r2.points['3'].seen.windows;
const f3 = r3.checks.point3b;
const t0 = Date.parse(r2.startedAt);
const s = t => ((t - t0) / 1000).toFixed(1);
const timer2 = r2.held.map(h => `${s(h.t)} s ${h.failed ? 'aborted' : h.status} (${h.at.split(':')[0]})`).join('; ');
const img = (file, caption, width) => existsSync(resolve(here, file)) ? `<figure style="margin:0 20px 12px 0;display:inline-block;vertical-align:top;max-width:${width}px"><img src="data:image/png;base64,${readFileSync(resolve(here, file)).toString('base64')}" style="max-width:100%;border:1px solid #bbb"><figcaption style="font-size:14px;margin-top:6px">${caption}</figcaption></figure>` : '';
const esc = v => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const rows = [
  ['Why two runs', 'In the long-outage window the till is on the drop-off form (step 7). The Held sales panel lives in the order column, which the till draws only while step < 6 (Till.tsx:3956), so on that form "could not be read" is held but not on screen. Run 02 measured the re-read on the wire in both windows and looked at the payment step; run 03 held the online sale to bring the till back to its first screen, where the panel is drawn.'],
  ['Run 02, window g1', `the list's timed read aborted while the lane was on the box; Continue again: the list read again (200) ${w2[0].firstOk.secondsAfterFailedRead} s after the failed read, at the platform's first answers to the press (${Math.abs(w2[0].firstOk.secondsAfterRegistrationAnswered)} s before the registration's own answer); the timer's next read came 20.1 s after the failure; at the payment step no "could not be read" (${(w2[0].heldErrorGoneAfterAgainMs / 1000).toFixed(1)} s after the press)`],
  ['Run 02, window g2', `the same: read again ${w2[1].firstOk.secondsAfterFailedRead} s after the failed read; no "could not be read" at the payment step (${(w2[1].heldErrorGoneAfterAgainMs / 1000).toFixed(1)} s after the press)`],
  ['Run 02, every read of the list', timer2],
  ['Run 03, on screen', `after the hold, every read of the list aborted until the box said "platform": the panel said "${esc(f3.errorShown)}"; the status read let through ${f3.releasedAfterFirstFailureS} s after the first failed read; the box answered "platform" ${f3.boxSaidPlatformAfterReleaseS} s later; the list read again (200) ${f3.rereadAfterBoxSaidPlatformS} s after that, ${f3.rereadBeforeNextTimerS} s before the timer's next read; the line gone ${f3.lineGoneAfterBoxSaidPlatformS} s after the box answered`],
  ['Run 03, what the list then held', 'nothing: the ZZ TEST held sale had been resumed at another till at 17:15:56 Bangkok (see the report), so the panel was no longer drawn after the re-read and there is no crop of it after; the till\'s screen at 17:17 (failed-3b-till.png) has no "could not be read" anywhere'],
  ['Verdict', 'PASS: a list that met no connection is read again by itself within 0.2-1.8 s of the platform answering, well before its 20 s timer, and "could not be read" does not stay'],
];
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1300, height: 600 } });
await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:24px;background:#fff;color:#111"><h2 style="margin-top:0">SCRUM-897 point 3 — Held sales, which could not be read, is read again as soon as the platform answers</h2>
  <div>${img('out-run-03/g3-a-held-sales-could-not-be-read.png', 'Run 03 (348caa58): lane on the box, the list\'s reads failing — "could not be read" (who held it masked)', 360)}${img('out-run-02/g1-d-payment-step-online-hold-sale-open.png', 'Run 02 (348caa58), window g1: the payment step 2.4 s after Continue again — no "could not be read"', 700)}</div>
  <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px;margin-top:8px">${rows.map(([k, v]) => `<tr><th style="text-align:left;vertical-align:top;white-space:nowrap">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
  <p style="color:#555">Times are the till browser's own request records in out-run-02/receipt.json and out-run-03/receipt.json; drawn ${new Date().toISOString()}.</p></body></html>`);
await page.screenshot({ path: resolve(here, '03-held-sales-read-again-runs-02-03.png'), fullPage: true });
await browser.close();
console.log('picture 03-held-sales-read-again-runs-02-03.png');
