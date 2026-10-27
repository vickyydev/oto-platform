import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2 } from 'lucide-react';
import { alertRoutingApi, type AlertRecipient, type AlertRecipientPage } from '@/api/observability';
import { Button } from '@/components/ui/button';
import { CONTROL, Labelled } from '@/components/Filters';
import { CardShell, RailNote } from '@/components/redesign/layout';
import { CodeTag, Tag } from '@/components/redesign/chips';
import { EmptyNote, UnreadNote } from '@/components/redesign/StatTile';
import { Loading } from '@/components/Panel';
import { recipientAddressWords, recipientFormProblem } from '@/lib/alertRouting';

/**
 * SCRUM-644 (planner ruling Q25) — who an alert family is meant for.
 *
 * Each row maps a category to a channel and, for email or a webhook, the NAME
 * of the environment variable that holds the address — never the address, so
 * no address or webhook secret is ever typed into, stored by or shown on this
 * screen. Delivery is console-only on this build, and the panel says so in the
 * API's own words: an email or webhook row is kept, and each alert it would
 * have reached is recorded as not delivered.
 */
export function AlertRecipients() {
  const [page, setPage] = useState<AlertRecipientPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    setError(null);
    void alertRoutingApi
      .recipients()
      .then((p) => { if (active) setPage(p); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : 'Could not read the recipients'); });
    return () => { active = false; };
  }, [tick]);

  return (
    <CardShell icon={BellRing} title="Alert recipients">
      <p role="note" className="text-[13px] font-semibold leading-normal">
        {page?.deliveryNote ??
          'Alerts are delivered to the console only. Email and webhook rows are kept, and recorded as not delivered, until a provider integration is built as its own ticket.'}
      </p>
      {error ? (
        <UnreadNote className="py-3" what="The recipient list" message={error} onRetry={reload} />
      ) : page === null ? (
        <Loading what="recipients" />
      ) : page.recipients.length === 0 ? (
        <EmptyNote className="py-3" title="No recipients yet" detail="Every alert is written to the console log." />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Alert recipients">
          {page.recipients.map((r) => (
            <RecipientRow key={r.id} recipient={r} onChanged={reload} />
          ))}
        </ul>
      )}
      <AddRecipient onAdded={reload} />
      <RailNote>
        Name the environment variable (ALERT_…) that holds an address; set its value on the deployment, never here.
      </RailNote>
    </CardShell>
  );
}

function RecipientRow({ recipient, onChanged }: { recipient: AlertRecipient; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-1 rounded-[12px] border px-3 py-2.5 text-[13px]">
      <span className="flex flex-wrap items-center gap-2">
        <CodeTag>{recipient.category}</CodeTag>
        <span aria-hidden>→</span>
        <Tag>{recipient.channel}</Tag>
        {recipient.scope === 'platform' && <Tag>platform</Tag>}
        {!recipient.delivered && <span className="text-xs font-semibold text-status-warn">not delivered on this build</span>}
        <button
          type="button"
          disabled={busy}
          className="ml-auto text-xs font-semibold text-primary-ink hover:underline underline-offset-4 disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            void alertRoutingApi
              .archiveRecipient(recipient.id)
              .then(onChanged)
              .catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not remove it'))
              .finally(() => setBusy(false));
          }}
        >
          {note ?? 'Remove'}
        </button>
      </span>
      <span className="text-xs text-muted-foreground">{recipientAddressWords(recipient)}</span>
      {recipient.label && <span className="text-xs">{recipient.label}</span>}
    </li>
  );
}

function AddRecipient({ onAdded }: { onAdded: () => void }) {
  const [category, setCategory] = useState('');
  const [channel, setChannel] = useState<'console' | 'email' | 'webhook'>('console');
  const [addressRef, setAddressRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = recipientFormProblem({ category, channel, addressRef });

  const add = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await alertRoutingApi.addRecipient({
        category: category.trim(),
        channel,
        addressRef: channel === 'console' ? null : addressRef.trim(),
        scope: 'operator',
      });
      setCategory('');
      setAddressRef('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label="Add a recipient"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <Labelled label="Alert family">
        <input className={CONTROL} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="ops.failing or *" />
      </Labelled>
      <Labelled label="Channel">
        <select className={CONTROL} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
          <option value="console">Console log (delivered)</option>
          <option value="email">Email (not delivered yet)</option>
          <option value="webhook">Webhook (not delivered yet)</option>
        </select>
      </Labelled>
      {channel !== 'console' && (
        <Labelled label="Address variable name">
          <input
            className={CONTROL}
            value={addressRef}
            onChange={(e) => setAddressRef(e.target.value.toUpperCase())}
            placeholder="ALERT_ONCALL_EMAIL"
            autoComplete="off"
            spellCheck={false}
          />
        </Labelled>
      )}
      {(error ?? (category || addressRef ? problem : null)) && (
        <p role="alert" className="text-xs font-semibold text-status-down">
          {error ?? problem}
        </p>
      )}
      <Button type="submit" size="sm" variant="outline" className="self-start rounded-full" disabled={Boolean(problem) || busy}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
        Add recipient
      </Button>
    </form>
  );
}
