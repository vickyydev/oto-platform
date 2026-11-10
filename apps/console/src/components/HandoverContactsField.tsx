/**
 * SCRUM-823 — who an inbox Birthdays & Events hand-over tells at this park:
 * the birthday manager on duty (an OTO App notification and a WhatsApp or
 * Telegram ping, at once) and the GM (told once when nobody has picked the
 * conversation up within fifteen minutes). Both are branch settings; until a
 * park names them, a hand-over there is recorded "manager not notified".
 */

export interface NoticeContactDraft {
  name: string;
  appUserId: string;
  phone: string;
  channel: 'whatsapp' | 'telegram';
}

export interface NoticeContactValue {
  name: string | null;
  appUserId: string | null;
  phone: string | null;
  channel: 'whatsapp' | 'telegram';
}

export const EMPTY_CONTACT: NoticeContactDraft = { name: '', appUserId: '', phone: '', channel: 'whatsapp' };

/** The stored contact as the editor's fields. */
export function draftOf(value: NoticeContactValue | null | undefined): NoticeContactDraft {
  if (!value) return { ...EMPTY_CONTACT };
  return { name: value.name ?? '', appUserId: value.appUserId ?? '', phone: value.phone ?? '', channel: value.channel };
}

/** The editor's fields as the branch PATCH takes them: null when nobody is named. */
export function contactBody(draft: NoticeContactDraft): NoticeContactValue | null {
  const name = draft.name.trim();
  const appUserId = draft.appUserId.trim();
  const phone = draft.phone.trim();
  if (!appUserId && !phone) return null;
  return { name: name || null, appUserId: appUserId || null, phone: phone || null, channel: draft.channel };
}

/** Whether the fields say something other than what is stored. */
export function contactChanged(draft: NoticeContactDraft, stored: NoticeContactValue | null | undefined): boolean {
  return JSON.stringify(contactBody(draft)) !== JSON.stringify(contactBody(draftOf(stored)));
}

export const BIRTHDAY_MANAGER_SENTENCE =
  'Told at once when the assistant hands a Birthdays & Events conversation to a person: in the OTO App’s notifications and by a ping to this number. Until someone is named, the hand-over is recorded “manager not notified”.';
export const GM_CONTACT_SENTENCE =
  'Told once when nobody has picked up a Birthdays & Events hand-over within 15 minutes (no reply, no assignment by a person).';

function ContactFields({
  legend,
  sentence,
  value,
  fieldClass,
  onChange,
  testId,
}: {
  legend: string;
  sentence: string;
  value: NoticeContactDraft;
  fieldClass: string;
  onChange: (next: NoticeContactDraft) => void;
  testId: string;
}) {
  const set = (patch: Partial<NoticeContactDraft>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-xl border p-3" data-testid={testId}>
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      <span className="text-xs font-normal text-muted-foreground">{sentence}</span>
      <label className="flex flex-col gap-1 text-xs font-semibold">
        Person
        <input className={fieldClass} value={value.name} placeholder="Name" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold">
        OTO App user id
        <input
          className={fieldClass}
          value={value.appUserId}
          placeholder="The person’s OTO App user id"
          onChange={(e) => set({ appUserId: e.target.value })}
        />
      </label>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold">
          Phone
          <input
            className={fieldClass}
            value={value.phone}
            inputMode="tel"
            placeholder="+66 81 234 5678"
            onChange={(e) => set({ phone: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          Ping by
          <select
            className={fieldClass}
            value={value.channel}
            onChange={(e) => set({ channel: e.target.value === 'telegram' ? 'telegram' : 'whatsapp' })}
          >
            <option value="whatsapp">WhatsApp</option>
            <option value="telegram">Telegram</option>
          </select>
        </label>
      </div>
    </fieldset>
  );
}

export function HandoverContactsField({
  birthdayManager,
  gm,
  fieldClass,
  onBirthdayManager,
  onGm,
}: {
  birthdayManager: NoticeContactDraft;
  gm: NoticeContactDraft;
  fieldClass: string;
  onBirthdayManager: (next: NoticeContactDraft) => void;
  onGm: (next: NoticeContactDraft) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ContactFields
        legend="Birthday manager on duty"
        sentence={BIRTHDAY_MANAGER_SENTENCE}
        value={birthdayManager}
        fieldClass={fieldClass}
        onChange={onBirthdayManager}
        testId="branch-birthday-manager-contact"
      />
      <ContactFields
        legend="GM contact"
        sentence={GM_CONTACT_SENTENCE}
        value={gm}
        fieldClass={fieldClass}
        onChange={onGm}
        testId="branch-gm-contact"
      />
    </div>
  );
}
