// Opening a page of the OTO App as the person signed in here (SCRUM-775: the
// inbox's Create BEO opens a birthday's BEO form). The api mints the suite
// hand-off the launcher and the Console use, with the BEO form as its target
// (`POST /inbox/conversations/{id}/open-beo`, recorded as `auth.handoff_issue`
// naming the conversation and the event); the OTO App checks the target again
// before it lands there. The address is checked here before a tab goes to it.
import { inboxApi } from './inbox';

export const OTO_APP_UNREACHABLE = 'The OTO App has no configured address here.';

/** A hand-off address as the api answered it, checked before a tab is sent there; a refusal in words otherwise. */
export function checkedLaunchUrl(launchUrl: string | null | undefined): string {
  if (!launchUrl) throw new Error(OTO_APP_UNREACHABLE);
  try {
    const destination = new URL(launchUrl);
    if (!['https:', 'http:'].includes(destination.protocol) || !/^#handoff=[^&]+(&to=[^&]+)?$/.test(destination.hash)) {
      throw new Error();
    }
  } catch {
    throw new Error(OTO_APP_UNREACHABLE);
  }
  return launchUrl;
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

/**
 * Create BEO: send the tab (or, with none, this one) to the conversation's
 * event's BEO form in the OTO App. A refusal closes the tab and is thrown.
 * With `aiFill` (SCRUM-660) the form opens with its AI Fill run on the
 * conversation's confirmation message, which the OTO App reads itself.
 */
export async function openConversationBeo(
  conversationId: string,
  tab: Window | null,
  opts: { aiFill?: boolean } = {},
): Promise<void> {
  let address: string;
  try {
    const opened = await inboxApi.openBeo(conversationId, opts);
    address = checkedLaunchUrl(opened?.launchUrl);
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
