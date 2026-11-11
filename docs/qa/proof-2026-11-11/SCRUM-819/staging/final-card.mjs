import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../../../..');
const { card } = await import(pathToFileURL(resolve(root, 'scripts/agent/evidence.mjs')));
const { chromium } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const r = JSON.parse(readFileSync(resolve(import.meta.dirname, 'receipt.json')));
const v = JSON.parse(readFileSync(resolve(import.meta.dirname, 'runtime-comparison.json')));
if (!v.checksPassed || !v.cleanupPassed) throw new Error('Verified result required');
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  await card(page, {
    title: 'SCRUM-819 - pairing and real silence',
    subtitle: 'Labelled test-run card from the completed staging observation and version readback',
    identity: 'Seeded staging administrator during the observation; session now signed out',
    deploy: `Initial API ${r.sha}; later API ${v.live['oto-api-staging'].sha}; display and alert code identical`,
    rows: [
      { ok: true, tag: 'PASS', head: 'Pairing records the first sighting', note: `${r.checks.firstSighting.pairedAt}; Online before the first protected poll` },
      { ok: true, tag: 'PASS', head: 'Ten minutes connected without an Offline alert', note: `${r.checks.onlineWindow.sampleCount} Console samples over ${Math.floor(r.checks.onlineWindow.elapsedMs / 1000)} seconds` },
      { ok: true, tag: 'PASS', head: 'Real silence opens one alert', note: `Threshold 180 seconds; alert ${r.checks.realSilence.alertId}; same ID on a later Console read` },
      { ok: true, tag: 'PASS', head: 'Exact test fixtures retired', note: 'Display revoked, printer-free till archived, alert closed, sign-out confirmed by HTTP 401' },
      { ok: true, tag: 'SCOPE', head: 'Concurrent deployments are recorded separately', note: 'The original final version check failed during a rollout. Runtime comparison preserves it and verifies unchanged display, watchdog and alert code, plus unchanged Console/till source trees.' },
      { ok: true, tag: 'SCOPE', head: 'Bounded evidence', note: 'Notification delivery and repeat watchdog execution are covered by integration tests. Staging proves one alert and a later read; it does not claim a second watchdog sweep or an external notification. Exact-source CI is still running.' },
    ],
  }, resolve(import.meta.dirname, 's819-final-observation-card.png'));
} finally { await browser.close(); }
