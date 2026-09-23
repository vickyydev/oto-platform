import { expect, type Locator, type Page } from '@playwright/test';

/**
 * What every case here needs before it can look at anything: who is signed in,
 * and which park's rows are on screen.
 *
 * The person is the seed's operator administrator (`packages/db/src/seed`),
 * because the Console's pages are an administrator's — Devices, Branches and
 * Booths are all read with permissions reception does not hold.
 */
export const OPERATOR_ADMIN = { phone: '900000001', password: 'admin1234' };

/** The seeded park the fleet, the booth and the stations belong to. */
export const CENTRAL_FLORESTA = 'Oto Play Park, Central Floresta';
export const ROBINSON_CHALONG = 'Oto Play Park, Robinson Chalong';

/**
 * Sign in on the Console's own sign-in panel, by phone and password.
 *
 * Typed as `090…` would be typed at a desk — the platform normalises it to
 * E.164 on the way in — and located by input type rather than by the panel's
 * placeholders, which are example text and not a contract.
 */
export async function signIn(page: Page, password: string = OPERATOR_ADMIN.password): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="tel"]').fill(OPERATOR_ADMIN.phone);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Sign in and wait for the console to open on Health, its default section. */
export async function signInAndWait(page: Page): Promise<void> {
  await signIn(page);
  await page.waitForURL(/\/health$/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Health', exact: true })).toBeVisible();
}

/**
 * Open a section from the sidebar, the way somebody gets there — rather than
 * by address, which would not notice a nav that had stopped rendering it.
 */
export async function openSection(page: Page, label: string): Promise<void> {
  await page.getByRole('link', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Point a branch-scoped page at one park.
 *
 * Every one of these pages opens on the first branch it is given and the
 * picker only appears when there is more than one, so the choice is made
 * explicitly here: which park is on screen is what the assertions are about.
 */
export async function chooseBranch(page: Page, name: string): Promise<void> {
  await page.getByLabel('Branch').selectOption({ label: name });
}

/**
 * What a mouse press at the centre of this element would actually land on,
 * named the way a person would say it: `button “Add the box”`.
 *
 * Being visible is not the same as being pressable, and SCRUM-377 was the gap
 * between them: the add-a-box dialog rendered, read correctly to a locator and
 * to `toBeVisible`, and a press at its Cancel button went to the Stations card
 * painted over it. Playwright's own click would have caught that too, but only
 * as a timeout that says "element intercepts pointer events" with no word on
 * WHAT is in front — so this asks the browser directly and returns the
 * offender, which is the line worth having in a red run.
 */
export async function pressLandsOn(locator: Locator): Promise<string> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('That element has no box on screen, so nothing could be pressed on it');
  return locator.page().evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return 'nothing';
      const words = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${words ? ` “${words}”` : ''}`;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}
