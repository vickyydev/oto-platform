import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-859 — THE CUSTOMER'S PAYMENT SCREEN SHOWS THE FULL ORDER.
 *
 * The owner (8 and 12 November): "The customer-facing payment screen should
 * show the full order details, not just the final amount." A ticket sale and
 * an F&B order, each walked to the payment step on the split view: the
 * customer half lists the order's lines and its total beside "Please pay" or
 * "Amount to pay", and beside the QR once one is shown. The amount is the
 * figure the staff half charges.
 *
 * Runs on the isolated harness with the simulated gateway for the QR:
 * `PAYMENTS_SIMULATOR=on pnpm --filter @oto/pos e2e e2e/payment-order-lines.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 *
 * THE QR IS READ IN ONE FRAME. The simulated gateway settles a code by itself
 * a few seconds after the till asks for it, so the QR screen is captured in a
 * single atomic read of the page the moment the code is drawn — its words, its
 * figures and where each block sits — the picture taken at once, and every
 * assertion made on that frame rather than on the live page. The timer is
 * asserted whenever the frame carries one: the component test covers it with
 * an expiry, and the simulated gateway on this harness answers the display
 * state without one. Afterwards the sale is closed by whichever the staff half
 * shows first: the thank-you (the gateway settled it) or the QR still up
 * (cancelled, and closed with cash). On a loaded machine the code can be
 * settled before a frame with it drawn is ever painted; that sale asserts
 * nothing on the QR and the test rings another, up to three, and fails if
 * none was caught.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(process.env.PAYMENTS_SIMULATOR !== 'on', 'Set PAYMENTS_SIMULATOR=on: the QR comes from the simulated gateway');
}

/** A picture of the split view; `settled` waits half a second for a screen with nothing racing it. */
async function shot(page: Page, name: string, settled = true): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  if (settled) await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect
    .poll(async () => (await picker.isVisible()) || (await page.getByText('Membership Check', { exact: true }).isVisible()), {
      timeout: 30_000,
    })
    .toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** Step one of the order panel's steppers to `target`. */
async function stepTo(panel: Locator, label: 'Kids' | 'Adults', target: number): Promise<void> {
  const add = panel.getByRole('button', { name: `Add one ${label}` }).first();
  const remove = panel.getByRole('button', { name: `Remove one ${label}` }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 6; i += 1) {
    const now = Number(await value.textContent());
    if (now === target) return;
    await (now < target ? add : remove).click();
  }
  await expect(value).toHaveText(String(target));
}

/** The customer half's payment frame: its lines, its total row and its amount block. */
function customerPayment(page: Page) {
  const frame = page.getByTestId('customer-payment');
  return {
    frame,
    lines: frame.getByTestId('payment-order-lines'),
    summary: frame.getByTestId('payment-order-summary'),
    amount: frame.getByTestId('payment-amount'),
  };
}

/** The amount block, the first line and the total row are all on the screen at once: nothing is pushed off. */
async function allOnScreen(customer: ReturnType<typeof customerPayment>): Promise<void> {
  await expect(customer.amount).toBeInViewport();
  await expect(customer.summary).toBeInViewport();
  await expect(customer.lines.locator('> *').first()).toBeInViewport();
}

type Rect = { top: number; bottom: number; left: number; right: number };

/** One frame of the customer half with the QR drawn: the words and figures of each block, and where each sits. */
type QrFrame = {
  lines: string;
  summary: string;
  amount: string;
  /** The timer's text when the amount block carries one, else null. */
  countdown: string | null;
  qr: Rect | null;
  figure: Rect | null;
  summaryRect: Rect | null;
  firstLine: Rect | null;
  amountRect: Rect | null;
  viewport: { w: number; h: number };
};

/**
 * The staff half asks for the QR; the customer half is read in ONE atomic
 * pass the moment the code's image is drawn, and the picture is taken at once.
 * `figure` is the amount as the block prints it, so its own box is measured.
 *
 * Null when the sale settled before any frame with the code drawn could be
 * read: the simulated terminal approves a QR a few seconds after it is sent,
 * and on a loaded machine the code can be up for less than a frame. The
 * caller then rings the sale again; nothing is asserted on a missed frame.
 */
async function showQr(page: Page, figure: string, picture: string, settledHeading: string): Promise<QrFrame | null> {
  await page.getByRole('button', { name: 'Show payment QR', exact: true }).click();
  const handle = await page.waitForFunction(
    ({ figureText, settledText }: { figureText: string; settledText: string }) => {
      const frame = document.querySelector('[data-testid="customer-payment"]');
      const amount = frame?.querySelector('[data-testid="payment-amount"]') ?? null;
      const qr = amount?.querySelector('img[data-testid="payment-qr"]') ?? null;
      if (!frame || !amount || !qr) {
        const settled = Array.from(document.querySelectorAll('h1, h2, h3'))
          .some((h) => (h.textContent ?? '').trim() === settledText);
        return settled ? { missed: true as const } : null;
      }
      const box = (el: Element | null | undefined): Rect | null => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      const lines = frame.querySelector('[data-testid="payment-order-lines"]');
      const summary = frame.querySelector('[data-testid="payment-order-summary"]');
      const countdown = amount.querySelector('[data-testid="payment-qr-countdown"]');
      const figureEl = Array.from(amount.querySelectorAll('*'))
        .find((el) => el.childElementCount === 0 && (el.textContent ?? '').trim() === figureText) ?? null;
      return {
        missed: false as const,
        lines: lines?.textContent ?? '',
        summary: summary?.textContent ?? '',
        amount: amount.textContent ?? '',
        countdown: countdown?.textContent ?? null,
        qr: box(qr),
        figure: box(figureEl),
        summaryRect: box(summary),
        firstLine: box(lines?.firstElementChild),
        amountRect: box(amount),
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    },
    { figureText: figure, settledText: settledHeading },
    { timeout: 30_000, polling: 'raf' },
  );
  const read = (await handle.jsonValue()) as { missed: true } | ({ missed: false } & QrFrame);
  if (read.missed) return null;
  await shot(page, picture, false);
  const { missed: _missed, ...frame } = read;
  return frame;
}

/** `what` sits wholly inside the viewport of the frame it was read from. */
function onScreen(rect: Rect | null, frame: QrFrame, what: string): void {
  expect(rect, `${what} is drawn`).not.toBeNull();
  expect(rect!.top, `${what} top edge`).toBeGreaterThanOrEqual(0);
  expect(rect!.left, `${what} left edge`).toBeGreaterThanOrEqual(0);
  expect(rect!.bottom, `${what} bottom edge`).toBeLessThanOrEqual(frame.viewport.h);
  expect(rect!.right, `${what} right edge`).toBeLessThanOrEqual(frame.viewport.w);
}

/** The frame read with the QR up: the order's lines and total, the code and the amount, all on the screen. */
function expectQrFrame(frame: QrFrame, lineName: string, total: string, figure: string): void {
  expect(frame.lines, 'the order lines beside the QR').toContain(lineName);
  expect(frame.summary, 'the Total row beside the QR').toContain('Total');
  expect(frame.summary, 'the total is the charged figure').toContain(total);
  expect(frame.amount, 'the QR block says Scan to Pay').toContain('Scan to Pay');
  expect(frame.amount, 'the amount beside the QR').toContain(figure);
  if (frame.countdown !== null) expect(frame.countdown, 'the timer counts minutes and seconds').toMatch(/^\d+:\d\d$/);
  onScreen(frame.qr, frame, 'the QR');
  expect(frame.qr!.right - frame.qr!.left, 'the QR keeps a scannable size').toBeGreaterThanOrEqual(200);
  onScreen(frame.figure, frame, 'the amount figure');
  onScreen(frame.summaryRect, frame, 'the Total row');
  onScreen(frame.firstLine, frame, 'the first line');
  onScreen(frame.amountRect, frame, 'the amount block');
}

/**
 * The simulated gateway settles the QR by itself a few seconds after it is
 * shown: close the sale by whichever the staff half shows first — `done` (the
 * gateway settled it), or the QR still up, which is cancelled and closed with
 * cash. A settlement landing under the cancel or the cash is `done` as well.
 */
async function closeAfterQr(page: Page, done: Locator, byCash: () => Promise<void>): Promise<void> {
  const cancel = page.getByTestId('payment-cancel-qr');
  await expect.poll(async () => (await done.isVisible()) || (await cancel.isVisible()), { timeout: 30_000 }).toBe(true);
  if (!(await done.isVisible())) {
    await cancel.click({ timeout: 5_000 }).catch(() => undefined);
    await expect.poll(async () => (await done.isVisible()) || !(await cancel.isVisible()), { timeout: 30_000 }).toBe(true);
    if (!(await done.isVisible())) await byCash().catch(() => undefined);
  }
  await expect(done).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

/** How many sales a test rings before it gives up on catching the QR drawn. */
const QR_ATTEMPTS = 3;

/**
 * One ticket sale walked to the payment step: the cash screen checked and
 * pictured, then the QR read in one frame. Null when the QR was settled by
 * the simulated terminal before a frame with the code drawn could be read.
 * Each attempt walks in with its own number.
 */
async function ticketSaleToQr(page: Page, attempt: number): Promise<QrFrame | null> {
  await walkInByPhone(page, `81207685${attempt}`);
  await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await page.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
  const order = page.getByRole('heading', { name: 'Current Order' }).locator('../..');
  await stepTo(order, 'Kids', 2);
  await stepTo(order, 'Adults', 1);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  await expect(payButton).toBeEnabled({ timeout: 20_000 });
  const due = ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').replace(/,/g, '').trim();
  const total = `฿${Number(due)}`;
  const figure = `฿${Number(due).toFixed(2)}`;
  await payButton.click();
  // A walk-in hands the display over for a phone number; Done hands it back.
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible().catch(() => false)) await done.click();
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 15_000 });

  // Cash: "Please pay" the charged amount, with the order's lines and total beside it.
  await page.getByRole('heading', { name: 'Cash', exact: true }).click();
  const customer = customerPayment(page);
  await expect(customer.frame).toBeVisible({ timeout: 15_000 });
  await expect(customer.lines.getByText('1 Hour Play', { exact: true })).toBeVisible();
  await expect(customer.lines.getByText(/^Kids/)).toBeVisible();
  await expect(customer.summary.getByText('Total', { exact: true })).toBeVisible();
  await expect(customer.summary.getByText(total, { exact: true })).toBeVisible();
  await expect(customer.amount.getByText('Please pay', { exact: true })).toBeVisible();
  await expect(customer.amount.getByText(figure, { exact: true })).toBeVisible();
  await expect(customer.amount.getByText(/^Paying by/)).toBeVisible();
  await allOnScreen(customer);
  await shot(page, 'split-ticket-cash');

  // QR: the code, the order still beside it, read in one frame.
  await page.getByRole('heading', { name: /QR|PromptPay/ }).first().click();
  const frame = await showQr(page, figure, 'split-ticket-qr', 'Payment Successful');
  if (frame) {
    expectQrFrame(frame, '1 Hour Play', total, figure);
    expect(frame.lines).toMatch(/Kids/);
  }

  // The terminal settles the QR by itself, or it is cancelled and the sale closed with cash.
  await closeAfterQr(page, page.getByRole('heading', { name: 'Payment Successful' }), async () => {
    await page.getByRole('heading', { name: 'Cash', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  });
  await page.getByRole('button', { name: 'Start New Sale', exact: true }).click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 15_000 });
  return frame;
}

/** One F&B order walked to the payment step, as the ticket sale above. */
async function fnbOrderToQr(page: Page): Promise<QrFrame | null> {
  const wristband = page.getByRole('heading', { name: 'Scan Wristband', exact: true });
  // A New Order after the last one already stands at the wristband step.
  if (!(await wristband.isVisible())) await page.getByRole('button', { name: 'F&B', exact: true }).click();
  await expect(wristband).toBeVisible();
  await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  await page.getByPlaceholder('Search dish…').fill('French Fries');
  await page.getByRole('button', { name: /French Fries/ }).click();
  const options = page.getByRole('dialog');
  await options.getByRole('button', { name: /Cheese sauce/ }).click();
  await options.getByRole('button', { name: 'Add one French Fries', exact: true }).click();
  await options.getByPlaceholder('e.g. no pickles, extra crispy').fill('ZZ TEST no salt');
  await options.getByRole('button', { name: /^Add to order/ }).click();
  const charge = page.getByRole('button', { name: /^Charge ฿/ });
  await expect(charge).toBeEnabled({ timeout: 20_000 });
  const total = ((await charge.textContent()) ?? '').replace(/^Charge ฿/, '').replace(/,/g, '').trim();
  const figure = `฿${Number(total)}`;
  await charge.click();
  const pickup = page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  await pickup.getByRole('button', { name: '8', exact: true }).click();
  await pickup.getByRole('button', { name: '5', exact: true }).click();
  await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();

  // Cash: "Amount to pay" with the order's lines, options, note and total beside it.
  await page.getByRole('button', { name: /^Cash / }).click();
  const customer = customerPayment(page);
  await expect(customer.frame).toBeVisible({ timeout: 15_000 });
  await expect(customer.lines.getByTestId('fnb-display-line')).toHaveCount(1);
  await expect(customer.lines.getByText('French Fries', { exact: true })).toBeVisible();
  await expect(customer.lines.getByText('Cheese sauce', { exact: true })).toBeVisible();
  await expect(customer.lines.getByText('ZZ TEST no salt', { exact: true })).toBeVisible();
  await expect(customer.summary.getByText('Total', { exact: true })).toBeVisible();
  await expect(customer.summary.getByText(figure, { exact: true })).toBeVisible();
  await expect(customer.amount.getByText('Amount to pay', { exact: true })).toBeVisible();
  await expect(customer.amount.getByText(figure, { exact: true })).toBeVisible();
  await allOnScreen(customer);
  await shot(page, 'split-fnb-cash');

  // QR: the code, the order still beside it, read in one frame.
  await page.getByRole('button', { name: /Customer scans to pay/ }).click();
  const frame = await showQr(page, figure, 'split-fnb-qr', 'Order Confirmed');
  if (frame) {
    expectQrFrame(frame, 'French Fries', figure, figure);
    expect(frame.lines).toContain('Cheese sauce');
    expect(frame.lines).toContain('ZZ TEST no salt');
  }

  // The gateway settles the QR by itself, or it is cancelled and the order closed with cash.
  await closeAfterQr(page, page.getByRole('heading', { name: 'Order Confirmed', exact: true }), async () => {
    await page.getByRole('button', { name: /^Cash / }).click();
    await page.getByLabel('Cash received', { exact: true }).fill((Number(total) + 10).toFixed(2));
    await page.getByRole('button', { name: 'Record cash', exact: true }).click();
  });
  await page.getByRole('button', { name: 'New Order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scan Wristband', exact: true })).toBeVisible({ timeout: 15_000 });
  return frame;
}

test('ticket sale: the customer half lists the order beside "Please pay", then beside the QR', async ({ page }) => {
  requireFixture();
  await signIn(page);
  let frame: QrFrame | null = null;
  for (let attempt = 1; attempt <= QR_ATTEMPTS && !frame; attempt += 1) frame = await ticketSaleToQr(page, attempt);
  expect(frame, `the QR was read drawn beside the order within ${QR_ATTEMPTS} sales`).not.toBeNull();
});

test('F&B order: the customer half lists the order beside "Amount to pay", then beside the QR', async ({ page }) => {
  requireFixture();
  await signIn(page);
  let frame: QrFrame | null = null;
  for (let attempt = 1; attempt <= QR_ATTEMPTS && !frame; attempt += 1) frame = await fnbOrderToQr(page);
  expect(frame, `the QR was read drawn beside the order within ${QR_ATTEMPTS} orders`).not.toBeNull();
});
