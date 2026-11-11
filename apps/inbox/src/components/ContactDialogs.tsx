import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, PenLine, UserPlus } from 'lucide-react';
import { ApiError } from '@/api/client';
import { inboxApi, type ContactChannel, type ContactCreated, type ContactView, type ConversationRow } from '@/api/inbox';
import { Dialog } from '@/components/Dialog';
import {
  CREATED_OUT_OF_VIEW,
  EDIT_NAME_LABEL,
  EMPTY_NEW_CONTACT,
  NEW_CONTACT_LABEL,
  OPEN_EXISTING_LABEL,
  clearNameLabel,
  contactChannelLabel,
  contactNameDraft,
  firstContactChannel,
  identityLabel,
  identityPlaceholder,
  newContactProblem,
  profileNameLine,
  type NewContactDraft,
} from '@/lib/contacts';
import { CHANNEL_LABEL, bubbleTime, contactName } from '@/lib/view';

/**
 * The two contact dialogs (SCRUM-860), on the house `Dialog`:
 *
 *   - EDIT NAME, from the chat header's pencil: the name the inbox shows for
 *     this contact, with the channel's own profile name under it so a
 *     correction loses nothing; "Use the profile name" clears a staff-set
 *     name. The api keeps a staff-set name over any later profile name.
 *   - NEW CONTACT, from the list header: a name, the number or account the
 *     contact is on (`me.contactChannels`), and the phone number or channel
 *     handle. A duplicate is refused with the existing contact and an Open
 *     button to its conversation when the viewer can see one. A contact whose
 *     thread sits outside the viewer's inbox says so instead of opening.
 *
 * Nothing here sends anything to the customer: both are records.
 */

const CANCEL =
  'rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60';
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-60';
const INPUT =
  'w-full min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[13px] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:border-slate-300 dark:focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:focus:ring-slate-600 disabled:opacity-60';
const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400';
const HINT = 'text-[12px] text-slate-500 dark:text-slate-400';
const ERROR = 'text-[12.5px] text-rose-700 dark:text-rose-300';

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// --- Edit name -----------------------------------------------------------------------

export function ContactNameDialog({
  open,
  onClose,
  row,
  now,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  row: ConversationRow;
  now: Date;
  /** After a save: re-read the thread and the list, so the new name shows everywhere. */
  onChanged: () => Promise<void>;
}) {
  const initial = row.contact.displayName ?? '';
  const [view, setView] = useState<ContactView | null>(null);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the contact is read, the field shows the row's name and the profile
  // line says it is reading; the read fills both.
  const loading = view === null && error === null;

  // Opened: start from the row's name, then read the contact for the profile
  // name and whether staff set the shown one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setView(null);
    setError(null);
    setName(initial);
    inboxApi
      .contact(row.id)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setName(contactNameDraft(v));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageOf(err, 'The contact could not be read.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, row.id, initial]);

  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await inboxApi.renameContact(row.id, value);
      await onChanged();
      onClose();
    } catch (err) {
      setError(messageOf(err, 'The name could not be saved.'));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === '' || busy || loading) return;
    void save(name);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={PenLine}
      title={EDIT_NAME_LABEL}
      subtitle={`${contactName(row.contact)} · ${CHANNEL_LABEL[row.contact.channel]}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          {view?.nameSetByStaff && (
            <button type="button" onClick={() => void save(null)} disabled={busy || loading} className={CANCEL}>
              {clearNameLabel(view)}
            </button>
          )}
          <button type="submit" form="contact-name-form" disabled={busy || loading || name.trim() === ''} className={PRIMARY}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}
            Save name
          </button>
        </>
      }
    >
      <form id="contact-name-form" onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1">
          <span className={LABEL}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name"
            maxLength={120}
            autoFocus
            disabled={busy || loading}
            className={INPUT}
          />
        </label>
        <p className={HINT} data-testid="profile-name-line">
          {loading ? 'Reading the contact…' : profileNameLine(view)}
        </p>
        {view?.nameSetByStaff && (
          <p className={HINT} data-testid="name-set-line">
            {view.nameSetAt ? `This name was set by staff, ${bubbleTime(view.nameSetAt, now)}.` : 'This name was set by staff.'}
          </p>
        )}
        {error && (
          <p className={ERROR} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

// --- New contact ---------------------------------------------------------------------

export interface ExistingContact {
  contactId: string;
  displayName: string | null;
  conversationId: string | null;
}

/** What a 409 CONTACT_EXISTS carries, read defensively: the api's `details` is untyped on the client. */
export function existingContactOf(err: unknown): ExistingContact | null {
  if (!(err instanceof ApiError) || err.code !== 'CONTACT_EXISTS') return null;
  const d = (err.details ?? {}) as Partial<Record<'contactId' | 'displayName' | 'conversationId', unknown>>;
  if (typeof d.contactId !== 'string') return null;
  return {
    contactId: d.contactId,
    displayName: typeof d.displayName === 'string' ? d.displayName : null,
    conversationId: typeof d.conversationId === 'string' ? d.conversationId : null,
  };
}

export function NewContactDialog({
  open,
  onClose,
  channels,
  onCreated,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  /** `me.contactChannels`: the numbers and accounts a contact can be put on. */
  channels: readonly ContactChannel[];
  /** After a create: re-read the list; the shell then opens the thread when it can see it. */
  onCreated: (result: ContactCreated) => Promise<void>;
  /** Open an existing contact's conversation (the duplicate's). */
  onOpen: (conversationId: string) => void;
}) {
  const [draft, setDraft] = useState<NewContactDraft>(EMPTY_NEW_CONTACT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingContact | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...EMPTY_NEW_CONTACT, channelAccountId: firstContactChannel(channels) });
    setError(null);
    setExisting(null);
    setDone(null);
  }, [open, channels]);

  const account = channels.find((a) => a.id === draft.channelAccountId) ?? null;
  const channel = account?.channel ?? null;
  const set = <K extends keyof NewContactDraft>(key: K, value: NewContactDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || done) return;
    setExisting(null);
    const problem = newContactProblem(draft, channels);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await inboxApi.createContact({
        channelAccountId: draft.channelAccountId,
        displayName: draft.displayName.trim(),
        identity: draft.identity.trim(),
      });
      await onCreated(result);
      if (result.visible) onClose();
      else setDone(CREATED_OUT_OF_VIEW(result.teamName));
    } catch (err) {
      setExisting(existingContactOf(err));
      setError(messageOf(err, 'The contact could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={UserPlus}
      title={NEW_CONTACT_LABEL}
      subtitle="A record only: nothing is sent to the customer."
      footer={
        done ? (
          <button type="button" onClick={onClose} className={PRIMARY}>
            Close
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy} className={CANCEL}>
              Cancel
            </button>
            <button type="submit" form="new-contact-form" disabled={busy} className={PRIMARY}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              Create contact
            </button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-[13px] text-slate-700 dark:text-slate-200" data-testid="created-line">
          {done}
        </p>
      ) : (
        <form id="new-contact-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Name</span>
            <input
              value={draft.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              aria-label="Name"
              maxLength={120}
              autoFocus
              disabled={busy}
              className={INPUT}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Channel</span>
            <select
              value={draft.channelAccountId}
              onChange={(e) => set('channelAccountId', e.target.value)}
              aria-label="Channel"
              disabled={busy}
              className={INPUT}
            >
              {channels.length !== 1 && <option value="">Choose the number or account</option>}
              {channels.map((a) => (
                <option key={a.id} value={a.id}>
                  {contactChannelLabel(a)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>{identityLabel(channel)}</span>
            <input
              value={draft.identity}
              onChange={(e) => set('identity', e.target.value)}
              aria-label={identityLabel(channel)}
              placeholder={identityPlaceholder(channel)}
              inputMode={channel === 'whatsapp' || channel === null ? 'tel' : 'text'}
              maxLength={190}
              disabled={busy}
              className={INPUT}
            />
          </label>
          {error && (
            <div className="flex flex-wrap items-center gap-2" role="alert">
              <p className={ERROR}>{error}</p>
              {existing?.conversationId && (
                <button
                  type="button"
                  onClick={() => {
                    onOpen(existing.conversationId!);
                    onClose();
                  }}
                  className={CANCEL}
                >
                  {OPEN_EXISTING_LABEL}
                </button>
              )}
            </div>
          )}
        </form>
      )}
    </Dialog>
  );
}
