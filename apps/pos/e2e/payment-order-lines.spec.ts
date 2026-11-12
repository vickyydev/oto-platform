import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chooseLanguageFirst, walkInByPhone } from './walk-in';

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
 * `POS_E2E_SHOTS` names a folder to keep the screens (and each frame's
 * measurements, as JSON) in.
 *
 * THE FAMILY READS THE ORDER AND THE AMOUNT AT ONCE. "On the screen" is
 * measured by boxes, never by Playwright's in-viewport check (one visible
 * pixel passes it: a staging proof found a card showing 32px of its 186px).
 * Each frame is checked for:
 * - the first line card WHOLLY inside the list's visible area, and that area
 *   at least one card tall, so a longer order scrolls in a window that shows
 *   a whole card (the split view; on the phone the list keeps a scrolling
 *   area of its own above the amount);
 * - the Total row wholly on the screen and clear of the amount block and of
 *   the QR;
 * - the amount figure wholly visible inside its block (which scrolls within
 *   itself on a short screen), on the screen and, on the phone, above the
 *   "Done — return phone to staff" bar;
 * - the QR, when shown, wholly visible the same way and at least 200px.
 *
 * THE SPLIT VIEW IS READ AT 1440 x 900 WITH STAGING'S BARS. Staging's till
 * carries a stock bar and an overdue bar above the sale (about 95px together);
 * the spec puts a block of their height at the top of the station, on top of
 * any bar the harness shows, so the customer half is at least as short as it
 * is there. The ticket's cash screen is read there and again at 1920 x 1080,
 * where the half is as wide as a paired display's two columns; the
 * phone-width till is read at 390 x 844 with the QR handed to the customer.
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

/** Staging's stock and overdue bars above the sale, measured on 12 November. */
const STAGING_BARS_PX = 95;
const SPLIT = { width: 1440, height: 900 };
const WIDE = { width: 1920, height: 1080 };
const PHONE_SIZE = { width: 390, height: 844 };
const HAND_BACK = 'Done — return phone to staff';

test.use({ trace: 'off', video: 'off', screenshot: 'off', viewport: SPLIT });
test.setTimeout(240_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(process.env.PAYMENTS_SIMULATOR !== 'on', 'Set PAYMENTS_SIMULATOR=on: the QR comes from the simulated gateway');
}

/** A picture of the screen; `settled` waits half a second for a screen with nothing racing it. */
async function shot(page: Page, name: string, settled = true): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  if (settled) await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

/** A frame's measurements beside its picture. */
async function keep(name: string, frame: Frame): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await writeFile(resolve(SHOTS, `${name}.json`), JSON.stringify(frame, null, 2));
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

/**
 * Staging's two bars above the sale: a block of their height at the top of the
 * station's full-height column, so the customer half is as short as it is
 * there. Put once per page; the station's column keeps it across stages.
 */
async function stagingBars(page: Page): Promise<void> {
  await page.evaluate((height) => {
    if (document.querySelector('[data-e2e="staging-bars"]')) return;
    const frame = document.querySelector('[data-testid="customer-payment"]');
    let column: HTMLElement | null = null;
    for (let el = frame?.parentElement ?? null; el; el = el.parentElement) {
      if (getComputedStyle(el).flexDirection === 'column' && Math.abs(el.getBoundingClientRect().height - window.innerHeight) < 2) column = el;
    }
    if (!column) throw new Error('The station column was not found');
    const bars = document.createElement('div');
    bars.dataset.e2e = 'staging-bars';
    bars.style.cssText = `height:${height}px;flex-shrink:0;background:#fde2e2;border-bottom:1px solid #f5b5b5;`;
    column.insertBefore(bars, column.firstChild);
  }, STAGING_BARS_PX);
  await page.waitForTimeout(300);
}

/** Step one of the order panel's steppers to `target`. */
async function stepTo(panel: Locator | Page, label: 'Kids' | 'Adults', target: number): Promise<void> {
  const add = panel.getByRole('button', { name: `Add one ${label}` }).first();
  const remove = panel.getByRole('button', { name: `Remove one ${label}` }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 8; i += 1) {
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

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };

/** One frame of the customer's payment screen: the words of each block, and where each sits. */
type Frame = {
  lines: string;
  summary: string;
  amount: string;
  /** The timer's text when the amount block carries one, else null. */
  countdown: string | null;
  viewport: { w: number; h: number };
  /** The scrolling list of line cards, with its visible height and its content's. */
  list: Rect & { clientHeight: number; scrollHeight: number };
  firstCard: Rect | null;
  summaryRect: Rect | null;
  /** The row that reads "Total". */
  totalRow: Rect | null;
  amountRect: Rect;
  figure: Rect | null;
  qr: Rect | null;
  /** The phone's hand-back bar, while the phone is handed over. */
  handBack: Rect | null;
};

type Read = { missed: true } | ({ missed: false } & Frame);

/**
 * Reads the payment frame in one pass, or null while it is not drawn (with
 * `withQr`, until the code's image is). `settledText` names the heading that
 * says the payment already went through: then `{ missed: true }`.
 */
function readFrame({ figureText, settledText, withQr, handBackText }: { figureText: string; settledText: string; withQr: boolean; handBackText: string }) {
  const frame = document.querySelector('[data-testid="customer-payment"]');
  const amount = frame?.querySelector('[data-testid="payment-amount"]') ?? null;
  const qr = amount?.querySelector('img[data-testid="payment-qr"]') ?? null;
  if (!frame || !amount || (withQr && !qr)) {
    const settled = Array.from(document.querySelectorAll('h1, h2, h3'))
      .some((h) => (h.textContent ?? '').trim() === settledText);
    return settled ? { missed: true as const } : null;
  }
  // The block zooms in as it is drawn: a frame is read once it stands at its own size.
  if (amount.getAnimations().some((a) => a.playState === 'running')) return null;
  const box = (el: Element | null | undefined) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const leaf = (root: Element | null, text: string) => (root
    ? Array.from(root.querySelectorAll('*')).find((el) => el.childElementCount === 0 && (el.textContent ?? '').trim() === text) ?? null
    : null);
  const lines = frame.querySelector('[data-testid="payment-order-lines"]') as HTMLElement;
  const summary = frame.querySelector('[data-testid="payment-order-summary"]');
  const countdown = amount.querySelector('[data-testid="payment-qr-countdown"]');
  // The first card: the list's first child, or the first child of the one wrapper a list puts its cards in.
  let holder: Element = lines;
  while (holder.children.length === 1 && holder.firstElementChild!.children.length > 1 && !/rounded/.test(holder.firstElementChild!.className)) {
    holder = holder.firstElementChild!;
  }
  const totalLabel = leaf(summary, 'Total');
  const handBack = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === handBackText) ?? null;
  return {
    missed: false as const,
    lines: lines.textContent ?? '',
    summary: summary?.textContent ?? '',
    amount: amount.textContent ?? '',
    countdown: countdown?.textContent ?? null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    list: { ...box(lines)!, clientHeight: lines.clientHeight, scrollHeight: lines.scrollHeight },
    firstCard: box(holder.firstElementChild),
    summaryRect: box(summary),
    totalRow: box(totalLabel?.parentElement),
    amountRect: box(amount)!,
    figure: box(leaf(amount, figureText)),
    qr: box(qr),
    handBack: box(handBack),
  };
}

/** The frame as it stands now (the cash screen: nothing races it). */
async function frameNow(page: Page, figure: string): Promise<Frame> {
  const handle = await page.waitForFunction(readFrame, { figureText: figure, settledText: '\u0000', withQr: false, handBackText: HAND_BACK }, { timeout: 15_000 });
  const read = (await handle.jsonValue()) as Read;
  if (read.missed) throw new Error('The payment frame was not drawn');
  const { missed: _missed, ...frame } = read;
  return frame;
}

/**
 * The QR's frame, read in ONE atomic pass the moment the code's image is
 * drawn, and the picture taken at once. Null when the sale settled before any
 * frame with the code drawn could be read: the simulated terminal approves a
 * QR a few seconds after it is sent, and on a loaded machine the code can be
 * up for less than a frame. The caller then rings the sale again; nothing is
 * asserted on a missed frame.
 */
async function qrFrame(page: Page, figure: string, picture: string, settledHeading: string): Promise<Frame | null> {
  const handle = await page.waitForFunction(
    readFrame,
    { figureText: figure, settledText: settledHeading, withQr: true, handBackText: HAND_BACK },
    { timeout: 30_000, polling: 'raf' },
  );
  const read = (await handle.jsonValue()) as Read;
  if (read.missed) return null;
  await shot(page, picture, false);
  const { missed: _missed, ...frame } = read;
  await keep(picture, frame);
  return frame;
}

const EDGE = 1;

/** `inner` lies wholly inside `outer`. */
function within(inner: Rect | null, outer: { top: number; bottom: number; left: number; right: number }, what: string, where: string): void {
  expect(inner, `${what} is drawn`).not.toBeNull();
  expect(inner!.top, `${what}: top edge inside ${where}`).toBeGreaterThanOrEqual(outer.top - EDGE);
  expect(inner!.bottom, `${what}: bottom edge inside ${where}`).toBeLessThanOrEqual(outer.bottom + EDGE);
  expect(inner!.left, `${what}: left edge inside ${where}`).toBeGreaterThanOrEqual(outer.left - EDGE);
  expect(inner!.right, `${what}: right edge inside ${where}`).toBeLessThanOrEqual(outer.right + EDGE);
}

/** `a` and `b` share no area. */
function apart(a: Rect | null, b: Rect | null, what: string): void {
  if (!a || !b) return;
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  expect(overlapX <= EDGE || overlapY <= EDGE, `${what} do not overlap (${Math.round(overlapX)} x ${Math.round(overlapY)}px shared)`).toBe(true);
}

/** `split`: the half of a 1440 split view; `columns`: as wide as a paired display; `phone`: the phone-width till. */
type Layout = 'split' | 'columns' | 'phone';

/** The family can read the order and the amount at once, by boxes: see this file's header. */
function expectReadable(frame: Frame, layout: Layout): void {
  const screen = { top: 0, left: 0, bottom: frame.handBack ? frame.handBack.top : frame.viewport.h, right: frame.viewport.w };
  const where = frame.handBack ? 'the screen above the hand-back bar' : 'the screen';
  // The list's visible area: the part of its box that is on the screen.
  const listShown = { top: Math.max(frame.list.top, 0), bottom: Math.min(frame.list.top + frame.list.clientHeight, screen.bottom), left: frame.list.left, right: frame.list.right };
  expect(frame.firstCard, 'the first line card is drawn').not.toBeNull();
  if (layout === 'phone') {
    // The phone keeps the lines in a scrolling area of their own above the amount: some of a card always shows.
    expect(listShown.bottom - listShown.top, 'the phone keeps a list area of its own').toBeGreaterThanOrEqual(96);
    expect(Math.min(frame.firstCard!.bottom, listShown.bottom) - Math.max(frame.firstCard!.top, listShown.top), 'the first card shows in the list').toBeGreaterThanOrEqual(64);
  } else {
    within(frame.firstCard, listShown, 'the first line card', 'the list\'s visible area');
    expect(frame.list.clientHeight, 'the list area is at least one card tall, so a longer order scrolls in it').toBeGreaterThanOrEqual(frame.firstCard!.height);
  }
  within(frame.totalRow, screen, 'the Total row', where);
  within(frame.summaryRect, screen, 'the order summary', where);
  // The amount block scrolls within itself on a short screen: what must be read is inside its visible part.
  const amountShown = { top: Math.max(frame.amountRect.top, 0), bottom: Math.min(frame.amountRect.bottom, screen.bottom), left: frame.amountRect.left, right: frame.amountRect.right };
  within(frame.figure, amountShown, 'the amount figure', `the amount block's visible part on ${where}`);
  apart(frame.summaryRect, frame.amountRect, 'the order summary and the amount block');
  apart(frame.totalRow, frame.figure, 'the Total row and the amount figure');
  if (frame.qr) {
    within(frame.qr, amountShown, 'the QR', `the amount block's visible part on ${where}`);
    expect(frame.qr.width, 'the QR keeps a scannable size').toBeGreaterThanOrEqual(200);
    apart(frame.totalRow, frame.qr, 'the Total row and the QR');
    apart(frame.summaryRect, frame.qr, 'the order summary and the QR');
  }
  // Beside the order (two columns) or below its footer (stacked), never over it.
  const beside = frame.amountRect.left >= frame.list.right - EDGE;
  if (layout === 'columns') expect(beside, 'two columns: the amount stands to the right of the order').toBe(true);
  if (layout === 'phone') expect(beside, 'the phone stacks the amount below the order').toBe(false);
  if (!beside) {
    expect(frame.amountRect.top, 'stacked: the amount stands below the order').toBeGreaterThanOrEqual((frame.summaryRect ?? frame.list).bottom - EDGE);
  }
}

/** The frame read with the QR up: the order's lines and total, the code and the amount, all readable. */
function expectQrFrame(frame: Frame, layout: Layout, lineName: string, total: string, figure: string): void {
  expect(frame.lines, 'the order lines beside the QR').toContain(lineName);
  expect(frame.summary, 'the Total row beside the QR').toContain('Total');
  expect(frame.summary, 'the total is the charged figure').toContain(total);
  expect(frame.amount, 'the QR block says Scan to Pay').toContain('Scan to Pay');
  expect(frame.amount, 'the amount beside the QR').toContain(figure);
  if (frame.countdown !== null) expect(frame.countdown, 'the timer counts minutes and seconds').toMatch(/^\d+:\d\d$/);
  expect(frame.qr, 'the QR is drawn').not.toBeNull();
  expectReadable(frame, layout);
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
 * pictured at 1440 x 900 with staging's bars and again at 1920 x 1080, then
 * the QR read in one frame. Null when the QR was settled by the simulated
 * terminal before a frame with the code drawn could be read. Each attempt
 * walks in with its own number.
 */
async function ticketSaleToQr(page: Page, attempt: number): Promise<Frame | null> {
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
  await stagingBars(page);
  const split = await frameNow(page, figure);
  await shot(page, 'split-ticket-cash-1440x900');
  await keep('split-ticket-cash-1440x900', split);
  expectReadable(split, 'split');

  // The same screen where the half is as wide as a paired display's two columns.
  await page.setViewportSize(WIDE);
  await page.waitForTimeout(500);
  const wide = await frameNow(page, figure);
  await shot(page, 'split-ticket-cash-1920x1080');
  await keep('split-ticket-cash-1920x1080', wide);
  expectReadable(wide, 'columns');
  await page.setViewportSize(SPLIT);
  await page.waitForTimeout(500);

  // QR: the code, the order still beside it, read in one frame.
  await page.getByRole('heading', { name: /QR|PromptPay/ }).first().click();
  await page.getByRole('button', { name: 'Show payment QR', exact: true }).click();
  const frame = await qrFrame(page, figure, 'split-ticket-qr-1440x900', 'Payment Successful');
  if (frame) {
    expectQrFrame(frame, 'split', '1 Hour Play', total, figure);
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
async function fnbOrderToQr(page: Page): Promise<Frame | null> {
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
  await stagingBars(page);
  const split = await frameNow(page, figure);
  await shot(page, 'split-fnb-cash-1440x900');
  await keep('split-fnb-cash-1440x900', split);
  expectReadable(split, 'split');

  // QR: the code, the order still beside it, read in one frame.
  await page.getByRole('button', { name: /Customer scans to pay/ }).click();
  await page.getByRole('button', { name: 'Show payment QR', exact: true }).click();
  const frame = await qrFrame(page, figure, 'split-fnb-qr-1440x900', 'Order Confirmed');
  if (frame) {
    expectQrFrame(frame, 'split', 'French Fries', figure, figure);
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

/**
 * One ticket sale on the phone-width till (390 x 844, no display): the phone
 * handed over for the number, then PromptPay, and the QR handed to the
 * customer, read in one frame. Null when the code was settled first.
 */
async function phoneSaleToQr(page: Page, attempt: number): Promise<Frame | null> {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByText('1 Hour Play', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
  await stepTo(page, 'Kids', 2);
  await stepTo(page, 'Adults', 1);
  await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
  // The phone is handed over for the family's number.
  await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
  // The guest's language is asked once per sale, before the number, when the phone asks it.
  const language = page.getByTestId('language-choice');
  const details = page.getByRole('heading', { name: 'Enter your details' });
  await expect.poll(async () => (await language.isVisible()) || (await details.isVisible()), { timeout: 20_000 }).toBe(true);
  if (await language.isVisible()) await chooseLanguageFirst(page, 'en');
  for (const digit of `81207686${attempt}`) await page.getByRole('button', { name: digit, exact: true }).last().click();
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  const walkIn = page.getByRole('button', { name: 'Continue as walk-in', exact: true });
  const pay = page.getByRole('button', { name: /^Pay ฿/ });
  await expect.poll(async () => (await walkIn.isVisible()) || (await pay.isVisible()), { timeout: 20_000 }).toBe(true);
  if (await walkIn.isVisible()) await walkIn.click();
  await expect(pay).toBeEnabled({ timeout: 20_000 });
  const due = ((await pay.textContent()) ?? '').replace(/^Pay ฿/, '').replace(/,/g, '').trim();
  const total = `฿${Number(due)}`;
  const figure = `฿${Number(due).toFixed(2)}`;
  await pay.click();
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 20_000 });

  // PromptPay: the till asks for the code and hands the phone over once it is drawn.
  await page.getByRole('heading', { name: 'PromptPay', exact: true }).first().click();
  await page.getByRole('button', { name: 'Show payment QR', exact: true }).first().click();
  const ready = page.getByRole('button', { name: 'Customer is ready', exact: true });
  const settled = page.getByRole('heading', { name: 'Payment Successful' });
  // The simulated gateway settles the code within seconds: hand the phone over the moment it is drawn.
  await Promise.race([ready.waitFor({ timeout: 30_000 }), settled.waitFor({ timeout: 30_000 })]);
  let frame: Frame | null = null;
  if (await ready.isVisible()) {
    await ready.click({ timeout: 5_000 }).catch(() => undefined);
    // A code settled under the hand-over closes the customer screen: that sale is rung again.
    frame = await qrFrame(page, figure, 'phone-ticket-qr-390x844', 'Payment Successful').catch((error: unknown) => {
      console.log(`[phone attempt ${attempt}] the QR frame was not read: ${String(error).slice(0, 160)}`);
      return null;
    });
    if (!frame) console.log(`[phone attempt ${attempt}] the code was settled before a frame with it drawn was read`);
    if (frame) {
      expect(frame.handBack, `the "${HAND_BACK}" bar is drawn`).not.toBeNull();
      expectQrFrame(frame, 'phone', '1 Hour Play', total, figure);
    }
    const handBack = page.getByRole('button', { name: HAND_BACK, exact: true });
    if (await handBack.isVisible()) await handBack.click();
  }

  // The terminal settles the QR by itself, or it is cancelled and the sale closed with cash.
  await closeAfterQr(page, settled, async () => {
    await page.getByRole('heading', { name: 'Cash', exact: true }).first().click();
    await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  });
  return frame;
}

test('ticket sale: the customer half lists the order beside "Please pay", then beside the QR', async ({ page }) => {
  requireFixture();
  await signIn(page);
  let frame: Frame | null = null;
  for (let attempt = 1; attempt <= QR_ATTEMPTS && !frame; attempt += 1) frame = await ticketSaleToQr(page, attempt);
  expect(frame, `the QR was read drawn beside the order within ${QR_ATTEMPTS} sales`).not.toBeNull();
});

test('F&B order: the customer half lists the order beside "Amount to pay", then beside the QR', async ({ page }) => {
  requireFixture();
  await signIn(page);
  let frame: Frame | null = null;
  for (let attempt = 1; attempt <= QR_ATTEMPTS && !frame; attempt += 1) frame = await fnbOrderToQr(page);
  expect(frame, `the QR was read drawn beside the order within ${QR_ATTEMPTS} orders`).not.toBeNull();
});

test('phone-width till: the QR handed over keeps the order, the Total and the amount above the hand-back bar', async ({ page }) => {
  requireFixture();
  await signIn(page);
  await page.setViewportSize(PHONE_SIZE);
  let frame: Frame | null = null;
  for (let attempt = 1; attempt <= QR_ATTEMPTS && !frame; attempt += 1) frame = await phoneSaleToQr(page, attempt);
  expect(frame, `the QR was read drawn beside the order within ${QR_ATTEMPTS} sales`).not.toBeNull();
});
