// SCRUM-860 — a contact made by staff, a contact's name set by staff. Node,
// no DOM: the two dialogs rendered with react-dom/server on their first
// paint, and the words and refusals they are built from as the pure
// functions ChatPanel and Workspace call.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContactChannel, ContactView, ConversationRow } from '@/api/inbox';
import { ApiError } from '@/api/client';
import { ContactNameDialog, NewContactDialog, existingContactOf } from '@/components/ContactDialogs';
import {
  CHANNEL_REQUIRED,
  CLEAR_NAME_LABEL,
  CREATED_OUT_OF_VIEW,
  EDIT_NAME_LABEL,
  IDENTITY_REQUIRED,
  NAME_REQUIRED,
  NEW_CONTACT_LABEL,
  NO_PROFILE_NAME,
  USE_PROFILE_NAME_LABEL,
  clearNameLabel,
  contactChannelLabel,
  contactNameDraft,
  firstContactChannel,
  identityLabel,
  identityPlaceholder,
  newContactProblem,
  profileNameLine,
} from '@/lib/contacts';

const NOW = new Date('2026-11-12T05:00:00.000Z');

function row(displayName: string | null, erased = false): ConversationRow {
  return {
    id: '0192f0a0-1234-7abc-8def-0123456789ab',
    channel: 'whatsapp',
    channelAccountId: '0192f0a0-1234-7abc-8def-0000000000a1',
    channelAccountName: 'Reception · Central Floresta',
    canReply: true,
    contact: {
      id: '0192f0a0-1234-7abc-8def-0123456789ac',
      channel: 'whatsapp',
      handle: '+66812345678',
      displayName,
      phone: '+66812345678',
      language: 'en',
      erased,
    },
    category: 'general',
    intent: null,
    language: 'en',
    branchId: '00000000-0000-7000-8000-00000000000c',
    teamId: '00000000-0000-7000-8000-0000000000b1',
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-11-12T03:00:00.000Z',
    lastMessagePreview: 'hello',
    unanswered: true,
    unread: 1,
    mine: true,
    assignments: [],
    createdAt: '2026-11-12T02:00:00.000Z',
  };
}

function view(partial: Partial<ContactView>): ContactView {
  return {
    id: '0192f0a0-1234-7abc-8def-0123456789ac',
    channel: 'whatsapp',
    handle: '+66812345678',
    displayName: 'ZZ TEST Khun Somchai',
    phone: '+66812345678',
    language: 'en',
    erased: false,
    profileName: 'Somchai J.',
    nameSetByStaff: true,
    nameSetAt: '2026-11-12T04:00:00.000Z',
    ...partial,
  };
}

const CENTRAL_WA: ContactChannel = {
  id: '0192f0a0-1234-7abc-8def-0000000000a1',
  channel: 'whatsapp',
  displayName: 'Reception · Central',
  branchId: '00000000-0000-7000-8000-00000000000c',
};
const PAGE_IG: ContactChannel = {
  id: '0192f0a0-1234-7abc-8def-0000000000a2',
  channel: 'instagram',
  displayName: 'OTO Park',
  branchId: null,
};

const noop = () => undefined;
const never = async () => undefined;

describe('the edit-name dialog', () => {
  it('opens on the shown name, with the pencil’s title and the clear button for a name staff set', () => {
    const html = renderToStaticMarkup(
      createElement(ContactNameDialog, { open: true, onClose: noop, row: row('ZZ TEST Khun Somchai'), now: NOW, onChanged: never }),
    );
    expect(html).toContain(`>${EDIT_NAME_LABEL}<`);
    expect(html).toContain('ZZ TEST Khun Somchai · WhatsApp');
    expect(html).toContain('value="ZZ TEST Khun Somchai"');
    expect(html).toContain('Save name');
    // Before the contact is read, the field shows the row's name and the profile line says it is reading.
    expect(html).toContain('Reading the contact…');
  });

  it('closed, it renders nothing', () => {
    const html = renderToStaticMarkup(
      createElement(ContactNameDialog, { open: false, onClose: noop, row: row('Somchai J.'), now: NOW, onChanged: never }),
    );
    expect(html).toBe('');
  });

  it('starts from an empty field for a contact with no name, so the handle is never typed as a name', () => {
    const html = renderToStaticMarkup(
      createElement(ContactNameDialog, { open: true, onClose: noop, row: row(null), now: NOW, onChanged: never }),
    );
    expect(html).toContain('value=""');
    expect(html).toContain('+66812345678 · WhatsApp');
  });

  it('the profile line names the channel’s own name, or says there is none; the clear button follows it', () => {
    expect(profileNameLine(view({}))).toBe('Name on WhatsApp: Somchai J.');
    expect(profileNameLine(view({ channel: 'line', profileName: '  มาลี  ' }))).toBe('Name on LINE: มาลี');
    expect(profileNameLine(view({ profileName: null }))).toBe(NO_PROFILE_NAME);
    expect(profileNameLine(view({ profileName: '   ' }))).toBe(NO_PROFILE_NAME);
    expect(profileNameLine(null)).toBe('');
    expect(clearNameLabel(view({}))).toBe(USE_PROFILE_NAME_LABEL);
    expect(clearNameLabel(view({ profileName: null }))).toBe(CLEAR_NAME_LABEL);
    expect(contactNameDraft(view({ displayName: 'Somchai J.' }))).toBe('Somchai J.');
    expect(contactNameDraft(view({ displayName: null }))).toBe('');
    expect(contactNameDraft(null)).toBe('');
  });
});

describe('the new-contact dialog', () => {
  it('asks for a name, the number or account, and a phone number; says nothing is sent', () => {
    const html = renderToStaticMarkup(
      createElement(NewContactDialog, { open: true, onClose: noop, channels: [CENTRAL_WA, PAGE_IG], onCreated: never, onOpen: noop }),
    );
    expect(html).toContain(`>${NEW_CONTACT_LABEL}<`);
    expect(html).toContain('nothing is sent to the customer');
    expect(html).toContain('aria-label="Name"');
    expect(html).toContain('Choose the number or account');
    expect(html).toContain('Reception · Central · WhatsApp');
    expect(html).toContain('OTO Park · Instagram');
    // Two accounts: none chosen yet, so the identity field is the phone number until one is.
    expect(html).toContain('aria-label="Phone number"');
    expect(html).toContain('placeholder="081 234 5678"');
    expect(html).toContain('Create contact');
  });

  it('with one account there is nothing to choose: it is picked, and no empty option is offered', () => {
    const html = renderToStaticMarkup(
      createElement(NewContactDialog, { open: true, onClose: noop, channels: [CENTRAL_WA], onCreated: never, onOpen: noop }),
    );
    expect(html).not.toContain('Choose the number or account');
    expect(html).toContain('Reception · Central · WhatsApp');
    expect(firstContactChannel([CENTRAL_WA])).toBe(CENTRAL_WA.id);
    expect(firstContactChannel([CENTRAL_WA, PAGE_IG])).toBe('');
    expect(firstContactChannel([])).toBe('');
  });

  it('closed, it renders nothing', () => {
    expect(
      renderToStaticMarkup(createElement(NewContactDialog, { open: false, onClose: noop, channels: [CENTRAL_WA], onCreated: never, onOpen: noop })),
    ).toBe('');
  });

  it('names the identity field by channel, and the picker by number then channel', () => {
    expect(identityLabel('whatsapp')).toBe('Phone number');
    expect(identityLabel(null)).toBe('Phone number');
    expect(identityLabel('instagram')).toBe('Instagram ID');
    expect(identityLabel('facebook')).toBe('Facebook ID');
    expect(identityLabel('line')).toBe('LINE user ID');
    expect(identityLabel('telegram')).toBe('Telegram handle');
    expect(identityLabel('webform')).toBe('Email or handle');
    expect(identityPlaceholder('whatsapp')).toBe('081 234 5678');
    expect(identityPlaceholder('line')).toBe('As LINE sends it');
    expect(contactChannelLabel(CENTRAL_WA)).toBe('Reception · Central · WhatsApp');
    expect(contactChannelLabel(PAGE_IG)).toBe('OTO Park · Instagram');
  });

  it('refuses an empty name, an unchosen channel and an empty identity before asking the api', () => {
    const channels = [CENTRAL_WA, PAGE_IG];
    expect(newContactProblem({ displayName: '  ', channelAccountId: CENTRAL_WA.id, identity: '0812345678' }, channels)).toBe(NAME_REQUIRED);
    expect(newContactProblem({ displayName: 'ZZ TEST', channelAccountId: '', identity: '0812345678' }, channels)).toBe(CHANNEL_REQUIRED);
    expect(newContactProblem({ displayName: 'ZZ TEST', channelAccountId: 'not-a-channel', identity: '0812345678' }, channels)).toBe(CHANNEL_REQUIRED);
    expect(newContactProblem({ displayName: 'ZZ TEST', channelAccountId: CENTRAL_WA.id, identity: ' ' }, channels)).toBe(IDENTITY_REQUIRED('whatsapp'));
    expect(IDENTITY_REQUIRED('whatsapp')).toBe('Enter a phone number.');
    expect(newContactProblem({ displayName: 'ZZ TEST', channelAccountId: PAGE_IG.id, identity: '' }, channels)).toBe('Enter the Instagram ID.');
    expect(newContactProblem({ displayName: 'ZZ TEST', channelAccountId: CENTRAL_WA.id, identity: '081 234 5678' }, channels)).toBeNull();
  });

  it('reads the duplicate out of the api’s refusal, and only that refusal', () => {
    const dup = new ApiError(409, 'CONTACT_EXISTS', 'ZZ TEST Twice is already a contact on WhatsApp.', {
      contactId: '0192f0a0-1234-7abc-8def-0123456789ac',
      displayName: 'ZZ TEST Twice',
      handle: '+66812345678',
      conversationId: '0192f0a0-1234-7abc-8def-0123456789ab',
    });
    expect(existingContactOf(dup)).toEqual({
      contactId: '0192f0a0-1234-7abc-8def-0123456789ac',
      displayName: 'ZZ TEST Twice',
      conversationId: '0192f0a0-1234-7abc-8def-0123456789ab',
    });
    const unseen = new ApiError(409, 'CONTACT_EXISTS', 'x', { contactId: '0192f0a0-1234-7abc-8def-0123456789ac', conversationId: null });
    expect(existingContactOf(unseen)).toEqual({ contactId: '0192f0a0-1234-7abc-8def-0123456789ac', displayName: null, conversationId: null });
    expect(existingContactOf(new ApiError(400, 'BAD_REQUEST', 'Enter a phone number the inbox can reach.'))).toBeNull();
    expect(existingContactOf(new Error('network'))).toBeNull();
  });

  it('words the thread that sits outside the viewer’s inbox', () => {
    expect(CREATED_OUT_OF_VIEW('Reception · Central')).toBe(
      'Contact created. Its conversation is with Reception · Central, outside your inbox.',
    );
    expect(CREATED_OUT_OF_VIEW(null)).toBe('Contact created. Its conversation is outside your inbox.');
  });
});
