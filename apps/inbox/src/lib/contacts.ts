import type { InboxChannelKey } from '@oto/shared/inbox';
import type { ContactChannel, ContactView } from '@/api/inbox';
import { CHANNEL_LABEL } from '@/lib/view';

/**
 * The words and arithmetic of the two contact dialogs (SCRUM-860): what the
 * identity field is called on each channel, how an account is named in the
 * channel picker, what the edit dialog starts with, and what the shell
 * refuses before asking the api. Pure, so the dialogs' tests run in Node.
 */

export const NEW_CONTACT_LABEL = 'New contact';
export const EDIT_NAME_LABEL = 'Edit name';
export const USE_PROFILE_NAME_LABEL = 'Use the profile name';
/** The clear button where the channel has sent no name: the list falls back to the handle. */
export const CLEAR_NAME_LABEL = 'Clear the name';
/** Shown under the name field when the channel has said a name of its own. */
export const PROFILE_NAME_PREFIX = 'Name on';
export const NO_PROFILE_NAME = 'The channel has not sent a name for this contact yet.';
export const NAME_REQUIRED = 'Enter a name.';
export const CHANNEL_REQUIRED = 'Choose the number or account the contact is on.';
export const IDENTITY_REQUIRED = (channel: InboxChannelKey | null) =>
  channel === 'whatsapp' || channel === null ? 'Enter a phone number.' : `Enter the ${identityLabel(channel)}.`;
export const CREATED_OUT_OF_VIEW = (teamName: string | null) =>
  teamName
    ? `Contact created. Its conversation is with ${teamName}, outside your inbox.`
    : 'Contact created. Its conversation is outside your inbox.';
export const OPEN_EXISTING_LABEL = 'Open';

/** What the identity field asks for on each channel. */
export function identityLabel(channel: InboxChannelKey | null): string {
  switch (channel) {
    case 'whatsapp':
    case null:
      return 'Phone number';
    case 'instagram':
      return 'Instagram ID';
    case 'facebook':
      return 'Facebook ID';
    case 'line':
      return 'LINE user ID';
    case 'telegram':
      return 'Telegram handle';
    case 'webform':
      return 'Email or handle';
  }
}

export function identityPlaceholder(channel: InboxChannelKey | null): string {
  return channel === 'whatsapp' || channel === null ? '081 234 5678' : `As ${CHANNEL_LABEL[channel]} sends it`;
}

/** An account in the channel picker: its number's name, then the channel. */
export function contactChannelLabel(a: Pick<ContactChannel, 'displayName' | 'channel'>): string {
  return `${a.displayName} · ${CHANNEL_LABEL[a.channel]}`;
}

export interface NewContactDraft {
  displayName: string;
  channelAccountId: string;
  identity: string;
}

export const EMPTY_NEW_CONTACT: NewContactDraft = { displayName: '', channelAccountId: '', identity: '' };

/** The first account offered, so a one-number park never has to pick. */
export function firstContactChannel(channels: readonly ContactChannel[]): string {
  return channels.length === 1 ? channels[0]!.id : '';
}

/** What the shell refuses before asking the api; null when the draft can go. */
export function newContactProblem(draft: NewContactDraft, channels: readonly ContactChannel[]): string | null {
  if (draft.displayName.trim() === '') return NAME_REQUIRED;
  const account = channels.find((a) => a.id === draft.channelAccountId) ?? null;
  if (!account) return CHANNEL_REQUIRED;
  if (draft.identity.trim() === '') return IDENTITY_REQUIRED(account.channel);
  return null;
}

/** The edit dialog's first value: the staff-set name, else the channel's as shown. */
export function contactNameDraft(c: Pick<ContactView, 'displayName'> | null): string {
  return c?.displayName ?? '';
}

/** What clearing a staff-set name is called: back to the profile name when there is one. */
export function clearNameLabel(c: Pick<ContactView, 'profileName'> | null): string {
  return c?.profileName?.trim() ? USE_PROFILE_NAME_LABEL : CLEAR_NAME_LABEL;
}

/** The secondary line under the field: the channel's own name, when it has one. */
export function profileNameLine(c: Pick<ContactView, 'channel' | 'profileName'> | null): string {
  if (!c) return '';
  return c.profileName?.trim() ? `${PROFILE_NAME_PREFIX} ${CHANNEL_LABEL[c.channel]}: ${c.profileName.trim()}` : NO_PROFILE_NAME;
}
