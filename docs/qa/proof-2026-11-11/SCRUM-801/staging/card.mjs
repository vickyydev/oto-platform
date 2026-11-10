import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../..');
const { chromium } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const receipt = JSON.parse(readFileSync(resolve(import.meta.dirname, 'receipt.json'), 'utf8'));
assert.equal(receipt.passed, true);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sale = receipt.checks.cancel;
const staff = receipt.cleanup.find(row => row.kind === 'staff-session');
const admin = receipt.cleanup.find(row => row.kind === 'admin-session');
const till = receipt.cleanup.find(row => row.kind === 'station');
assert.equal(sale.status, 'voided');
assert.equal(staff.readback, 401);
assert.equal(admin.readback, 401);
assert.equal(till.archived, true);
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 830 } });
  await page.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;background:#f6f3ed;color:#163a37;font:19px Arial,sans-serif}
    main{margin:40px;padding:36px;background:white;border:1px solid #d5e3dc;border-radius:20px}
    .eyebrow{color:#59706c;font-size:15px;letter-spacing:1px}h1{font-size:35px;margin:14px 0 10px}
    .sub{color:#59706c;margin-bottom:24px}.row{display:flex;justify-content:space-between;gap:24px;padding:15px 0;border-top:1px solid #e5ece8}
    strong{color:#137653}.small{font:14px monospace;overflow-wrap:anywhere;line-height:1.7}.foot{margin-top:24px;color:#59706c;font-size:15px;line-height:1.5}
  </style></head><body><main><div class="eyebrow">STAGING TEST-RUN CARD · SCRUM-801 / SCRUM-800</div>
    <h1>Phone cancellation leaves no open sale</h1><div class="sub">Pay → Back → Cancel, then reload the phone and counter.</div>
    <div class="row"><span>Cancel request / sale readback</span><strong>HTTP 200 / voided</strong></div>
    <div class="row"><span>Phone and counter reload</span><strong>Nothing to resume</strong></div>
    <div class="row"><span>Payment column / phone viewport</span><strong>${escape(receipt.checks.paymentWidth.sizes[0].width)} px / 375 px</strong></div>
    <div class="row"><span>Test till cleanup</span><strong>Archived</strong></div>
    <div class="row"><span>Staff and admin after sign-out</span><strong>401 / 401</strong></div>
    <p class="small">Source: ${escape(receipt.sha)}<br>Sale: ${escape(sale.saleId)}<br>Finished: ${escape(receipt.finishedAt)}</p>
    <div class="foot">Recorded browser checks and API readbacks from receipt.json; this card is not an application screen. Only a ZZ TEST till and an unpaid test sale were used. The voided sale remains as history. Landed-SHA CI is checked separately before Deployed.</div>
  </main></body></html>`);
  await page.screenshot({ path: resolve(import.meta.dirname, 's801-void-readback.png') });
} finally {
  await browser.close();
}
