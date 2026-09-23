import { expect, test } from '@playwright/test';
import { CENTRAL_FLORESTA, chooseBranch, openSection, signInAndWait } from './console';

/**
 * THE BOX DRAWER'S TEST PRINT — SCRUM-358, as a case rather than a drive.
 *
 * This is the walk that was done by hand when that fix landed: sign in as the
 * operator administrator, Devices, the virtual box, Controls, the printer
 * picker, Test print, and then the command history until it says the box did
 * it. Until now that walk was a screenshot in a Jira comment, which proves the
 * day it was taken and nothing afterwards; the control it covers is one whose
 * whole failure mode was being quietly wrong — the button sent a station and
 * no device, the platform refused every press, and the drawer said "queued"
 * over the top of it.
 *
 * So the case asserts the halves separately: that the picker NAMES the right
 * printer, that the box ran what it was handed, and — since SCRUM-364 — that
 * the platform has a print job for it with the box's own result on it. A press
 * that queues and never succeeds passes the first and fails the second; a press
 * that prints paper the platform never records passes both and fails the third,
 * which is the shape each bug had.
 *
 * It runs against the harness's own seeded database (`e2e/run.mjs`), with the
 * api carrying the `edge` role so the virtual box is there to take the command
 * off the queue — it polls every five seconds.
 */
test('the test print names the station’s receipt printer, and the box reports it succeeded', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);

  await page.getByRole('button', { name: 'Virtual box 1', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Virtual box 1' });
  const station = drawer.getByLabel('Station a test print goes to');
  const printer = drawer.getByLabel('Printer it comes out of');
  await expect(station).toBeVisible({ timeout: 30_000 });

  /**
   * THE PRINTER FOLLOWS THE STATION. Both of this box's stations are asked
   * for, because one of them on its own would not tell the two rules apart:
   * the booth has a single printer, so any default looks right there; the till
   * has four, and only the one doing the `receipt` job is the paper path
   * somebody at that counter is standing in front of.
   */
  await station.selectOption({ label: 'Booth 1' });
  await expect(printer.locator('option:checked')).toHaveText('Receipt Printer 2');

  await station.selectOption({ label: 'Reception Till 1' });
  await expect(printer.locator('option:checked')).toHaveText('Receipt Printer 1');
  // Chosen from among the till's printers rather than being its only one.
  await expect(printer.locator('option', { hasText: 'Kitchen Printer' })).toHaveCount(1);

  await drawer.getByRole('button', { name: 'Test print', exact: true }).click();
  await expect(drawer.getByText('Test print queued. The box takes it on its next poll.')).toBeVisible();

  /**
   * And then the box's own answer. The history does not poll — it reloads when
   * a command is sent and on its own Refresh — so the case presses Refresh the
   * way a person watching for their test print would.
   */
  const history = drawer
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Command history' }) });
  const testPrint = history.getByRole('listitem').filter({ hasText: 'Test print' }).first();
  await expect(testPrint).toBeVisible();

  await expect(async () => {
    await history.getByRole('button', { name: 'Refresh' }).click();
    await expect(testPrint).toContainText('succeeded', { timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  // A command the box refused is also "finished", so the reading that matters
  // is the state and not the timestamp beside it.
  await expect(testPrint).not.toContainText('failed');

  /**
   * AND THE PRINT JOB — the half SCRUM-364 was about.
   *
   * A succeeded command says the box understood the instruction and routed it.
   * It does NOT say the platform has any record of what came out: the drawer
   * used to queue a bare `test_print` command, so the outcome the box reported
   * afterwards named an `edge.print_job` row nobody had written and was refused
   * `PRINT_JOB_NOT_FOUND` — paper on the counter, a green command, and this
   * panel empty. Reading it here is what tells the two apart, and it is read
   * the way a person reads it: press the Printing panel's own Refresh, because
   * that panel reloads on its button and not on a timer.
   */
  const printing = drawer
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Printing', exact: true }) });
  const job = printing.getByRole('listitem').filter({ hasText: 'test page' }).first();

  await expect(async () => {
    await printing.getByRole('button', { name: 'Refresh' }).click();
    await expect(job).toContainText('printed', { timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  // The row carries WHERE it went as well as what became of it, which is the
  // reason the panel is worth opening: the printer the picker named above.
  await expect(job).toContainText('Receipt Printer 1');
});
