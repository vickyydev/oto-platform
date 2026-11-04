// Opening a page of the OTO App as the person signed in here (SCRUM-775: the
// inbox's Create BEO opens a birthday's BEO form). The suite hand-off the
// launcher and the Console use: the api mints a one-use token for the OTO App
// (`POST /auth/handoff`, audited as `auth.handoff_issue`), and the page rides
// beside it in the fragment (`withHandoffTarget`), which the OTO App checks
// again before it lands there. Nothing here reaches a server but the mint.
import type { ApiBody, ApiResponse } from '@oto/api-types';
import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey } from './client';

export const OTO_APP_UNREACHABLE = 'The OTO App has no configured address here.';

/** The hand-off address for one OTO App page, or a refusal in words. */
export async function otoAppAddress(target: string): Promise<string> {
  const issued = await api.post<ApiResponse<'/auth/handoff', 'post'>>(
    '/auth/handoff',
    { app: 'oto_app' } satisfies ApiBody<'/auth/handoff', 'post'>,
    { idempotencyKey: idemKey() },
  );
  if (!issued?.launchUrl) throw new Error(OTO_APP_UNREACHABLE);
  try {
    const destination = new URL(issued.launchUrl);
    if (!['https:', 'http:'].includes(destination.protocol) || !/^#handoff=[^&]+$/.test(destination.hash)) {
      throw new Error();
    }
  } catch {
    throw new Error(OTO_APP_UNREACHABLE);
  }
  return withHandoffTarget(issued.launchUrl, target);
}

/**
 * A tab for the OTO App, opened while the press is still a press (a browser
 * allows a new tab only then) and cut loose from this one; null when the
 * browser refused it, and the page then opens in this tab instead.
 */
export function openBlankTab(): Window | null {
  try {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    return tab;
  } catch {
    return null;
  }
}

/** Send the tab (or, with none, this one) to the OTO App page; a refusal closes the tab and is thrown. */
export async function openOtoAppPage(target: string, tab: Window | null): Promise<void> {
  let address: string;
  try {
    address = await otoAppAddress(target);
  } catch (err) {
    tab?.close();
    throw err;
  }
  try {
    if (tab) tab.location.href = address;
    else window.location.assign(address);
  } catch {
    // A browser exception can carry the one-use address: say it in words only.
    tab?.close();
    throw new Error('The OTO App could not be opened. Please try again.');
  }
}
