import { useState, type FormEvent, type ReactNode } from 'react';
import { CheckCheck, FlaskConical, Loader2, Mic, PlayCircle, Send } from 'lucide-react';
import { ApiError } from '@/api/client';
import { inboxApi, type InboxMe, type SimulatedInbound, type SimulatorAccount } from '@/api/inbox';
import { Eyebrow } from '@/components/atoms';
import { Refusal } from '@/components/confirms';
import { Dialog } from '@/components/Dialog';
import { CATEGORY_LABEL, CHANNEL_LABEL, LANGUAGE_OPTIONS } from '@/lib/view';

const FIELD =
  'w-full min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12.5px] text-slate-800 dark:text-slate-200 focus:border-slate-300 dark:focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:focus:ring-slate-600';
const PRIMARY_BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-60';

type Category = NonNullable<NonNullable<SimulatedInbound['hint']>['category']>;

const accountLabel = (a: SimulatorAccount) => `${a.displayName} · ${CHANNEL_LABEL[a.channel]}`;

/** SCRUM-824: the largest voice note the simulator plays (the api's own limit). */
export const SIMULATOR_VOICE_MAX_BYTES = 1024 * 1024;

const AUDIO_BY_EXTENSION: Record<string, string> = {
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  amr: 'audio/amr',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

/** A file's audio type: the browser's when it says audio, else read from its extension; null when it is no audio. */
export function voiceContentTypeOf(name: string, browserType: string): string | null {
  if (browserType.startsWith('audio/')) return browserType;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return AUDIO_BY_EXTENSION[ext] ?? null;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

function said(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The simulator panel (plan §4.3; I2d's `/inbox/simulator/*`): plays the demo
 * conversations, sends a customer message as any fictional contact, and
 * pushes the delivery receipts for the replies the simulator accepted — every
 * press signed in the api and sent through the real webhook handler.
 *
 * It exists only where the api says so: `me.simulator` is non-null only on a
 * deployment running the simulator (never production) and for a viewer who
 * holds `inbox:channel:manage`. Nothing here reaches a real customer.
 */
export function SimulatorBody({
  me,
  onChanged,
  onReloadMe,
}: {
  me: InboxMe;
  /** After a press: re-read the list and the open thread. */
  onChanged: () => Promise<void>;
  /** After the demo: re-read `/inbox/me` — the demo lays people and channel accounts. */
  onReloadMe: () => Promise<void>;
}) {
  const accounts = me.simulator?.channelAccounts ?? [];
  const [busy, setBusy] = useState<'demo' | 'inbound' | 'receipts' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('66812345678');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState<Category | ''>('');
  const [language, setLanguage] = useState('');
  // SCRUM-824: an uploaded voice note, played as WhatsApp's voice message.
  const [voice, setVoice] = useState<{ name: string; contentType: string; dataBase64: string } | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const pickVoice = async (file: File | undefined) => {
    setVoiceError(null);
    setVoice(null);
    if (!file) return;
    const contentType = voiceContentTypeOf(file.name, file.type);
    if (!contentType) return setVoiceError('Choose an audio file (ogg, opus, mp3, m4a, wav or webm).');
    if (file.size === 0 || file.size > SIMULATOR_VOICE_MAX_BYTES) return setVoiceError('A voice note here is at most 1 MB.');
    try {
      setVoice({ name: file.name, contentType, dataBase64: await readAsBase64(file) });
    } catch {
      setVoiceError('The file could not be read.');
    }
  };

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;

  const press = async (what: 'demo' | 'inbound' | 'receipts', fn: () => Promise<string>, fallback: string) => {
    setBusy(what);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
    } catch (err) {
      setError(said(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  const playDemo = () =>
    press(
      'demo',
      async () => {
        const r = await inboxApi.playDemo();
        await onReloadMe();
        await onChanged();
        return `Demo played: ${r.conversationsCreated} conversations created, ${r.conversationsAlreadyThere} already there, ${r.messages} messages.`;
      },
      'The demo could not be played.',
    );

  const sendInbound = (e: FormEvent) => {
    e.preventDefault();
    if (!account) return;
    const hint =
      category || language
        ? { ...(category ? { category } : {}), ...(language ? { language } : {}) }
        : undefined;
    void press(
      'inbound',
      async () => {
        const r = await inboxApi.simulateInbound({
          channelAccountId: account.id,
          from: from.trim(),
          name: name.trim() || undefined,
          text: text.trim() ? text : undefined,
          voice: voice ? { contentType: voice.contentType, dataBase64: voice.dataBase64 } : undefined,
          hint,
        });
        await onChanged();
        setText('');
        setVoice(null);
        return r.conversationsCreated > 0
          ? 'Received: a new conversation, routed.'
          : r.reopened > 0
            ? 'Received: the handled conversation reopened.'
            : r.duplicates > 0
              ? 'Received once already: nothing new.'
              : 'Received into the existing conversation.';
      },
      'The message could not be played.',
    );
  };

  const pushReceipts = () => {
    if (!account) return;
    void press(
      'receipts',
      async () => {
        const r = await inboxApi.simulateReceipts(account.id);
        await onChanged();
        const statuses = r.deliveries.reduce((n, d) => n + d.statuses, 0);
        return statuses === 0 ? 'No receipts were waiting.' : `${statuses} receipt${statuses === 1 ? '' : 's'} pushed.`;
      },
      'The receipts could not be pushed.',
    );
  };

  return (
      <div className="space-y-5">
        <Section title="Demo conversations">
          <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
            Plays the ten demo threads, the six demo staff and the four simulator channel accounts. Playing it again
            writes nothing.
          </p>
          <button type="button" onClick={() => void playDemo()} disabled={busy !== null} className={`mt-2 ${PRIMARY_BUTTON}`}>
            {busy === 'demo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
            Play the demo
          </button>
        </Section>

        <Section title="A customer writes">
          {accounts.length === 0 ? (
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400">No simulator channel account yet — play the demo first.</p>
          ) : (
            <form onSubmit={sendInbound} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Channel account" wide>
                <select value={account?.id ?? ''} onChange={(e) => setAccountId(e.target.value)} className={FIELD}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From (digits, country code first)">
                <input value={from} onChange={(e) => setFrom(e.target.value)} inputMode="numeric" className={FIELD} />
              </Field>
              <Field label="Name (optional)">
                <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
              </Field>
              <Field label="Category (instead of the AI)">
                <select value={category} onChange={(e) => setCategory(e.target.value as Category | '')} className={FIELD}>
                  <option value="">As the channel routes it</option>
                  {(Object.keys(CATEGORY_LABEL) as Category[]).map((k) => (
                    <option key={k} value={k}>
                      {CATEGORY_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Language (instead of the AI)">
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className={FIELD}>
                  <option value="">Not given</option>
                  {LANGUAGE_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Message" wide>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={`${FIELD} resize-y`} />
              </Field>
              <Field label="Voice note (optional): an audio file, played as a WhatsApp voice message" wide>
                <input
                  type="file"
                  accept="audio/*,.ogg,.opus,.oga,.mp3,.m4a,.wav,.webm"
                  data-testid="simulator-voice"
                  onChange={(e) => void pickVoice(e.target.files?.[0])}
                  className={FIELD}
                />
                {voice && (
                  <span className="inline-flex items-center gap-1 text-[11.5px] font-normal text-slate-600 dark:text-slate-300">
                    <Mic className="h-3 w-3" /> {voice.name}
                  </span>
                )}
                {voiceError && <span className="text-[11.5px] font-normal text-rose-600 dark:text-rose-400">{voiceError}</span>}
              </Field>
              <div className="sm:col-span-2">
                <button type="submit" disabled={busy !== null || (!text.trim() && !voice) || !from.trim()} className={PRIMARY_BUTTON}>
                  {busy === 'inbound' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send as the customer
                </button>
              </div>
            </form>
          )}
        </Section>

        <Section title="Delivery receipts">
          {accounts.length === 0 ? (
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400">No simulator channel account yet — play the demo first.</p>
          ) : (
            <>
              <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
                Marks the replies sent on {account ? accountLabel(account) : 'the account'} delivered, then read.
              </p>
              <button type="button" onClick={pushReceipts} disabled={busy !== null} className={`mt-2 ${PRIMARY_BUTTON}`}>
                {busy === 'receipts' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                Push receipts
              </button>
            </>
          )}
        </Section>

        {done && (
          <p role="status" className="rounded-lg bg-emerald-50 dark:bg-emerald-500/15 px-3 py-2 text-[12.5px] text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-200 dark:ring-emerald-500/30">
            {done}
          </p>
        )}
        {error && <Refusal text={error} />}
      </div>
  );
}

/** The settings-dialog wrapper kept for the existing entry point. */
export function SimulatorDialog({
  open,
  onClose,
  me,
  onChanged,
  onReloadMe,
}: {
  open: boolean;
  onClose: () => void;
  me: InboxMe;
  onChanged: () => Promise<void>;
  onReloadMe: () => Promise<void>;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={FlaskConical}
      iconTint="bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
      title="Simulator"
      subtitle="Pretend customers, through the real webhook. Local and staging only — nothing reaches a real customer."
      wide
    >
      <SimulatorBody me={me} onChanged={onChanged} onReloadMe={onReloadMe} />
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <Eyebrow className="mb-2">{title}</Eyebrow>
      {children}
    </section>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 ${wide ? 'sm:col-span-2' : ''}`}>
      {label}
      {children}
    </label>
  );
}
