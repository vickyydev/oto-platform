import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, FlaskConical } from 'lucide-react';
import { idemKey } from '@/api/client';
import {
  integrationsApi,
  type CredentialExpiry,
  type CredentialExpiryList,
  type IntegrationTestResult,
  type IntegrationTests,
} from '@/api/observability';
import { StatusMark, type Tone } from '@/components/Status';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/redesign/chips';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { UnreadNote } from '@/components/redesign/StatTile';
import { availabilityWord, expiryWords } from '@/lib/readAvailability';
import { formatWhen, timeAgo } from '@/lib/time';

/**
 * SCRUM-645 (planner ruling Q26) — the two Integrations controls.
 *
 * CREDENTIAL EXPIRY: the dates the owner was told when each credential was
 * issued. The watch reads only these and never asks a provider; an alert
 * opens 30 days and again 7 days before. Anybody who reads Health
 * estate-wide sees them; `console:integration:manage` may change them.
 *
 * TEST BUTTONS: one harmless round trip per integration, each through a seam
 * with a local fake adapter — no real provider is called in this release —
 * pressed only where the deployment allows test controls and the caller holds
 * `console:integration:test`. Each press is an operational run and an audit
 * row.
 */

function expiryTone(window: CredentialExpiry['window']): Tone {
  if (window === 'expired' || window === '7_days') return 'down';
  if (window === '30_days') return 'warn';
  if (window === 'ok') return 'ok';
  return 'idle';
}

export function CredentialExpiryCard({
  data,
  error,
  busyKey,
  onSave,
}: {
  data: CredentialExpiryList | null;
  error: string | null;
  busyKey: string | null;
  onSave: (key: CredentialExpiry['integration'], expiresOn: string | null) => void;
}) {
  if (data && !data.visible) return null;
  return (
    <CardShell
      span={12}
      icon={CalendarClock}
      title="Credential expiry"
      note="dates the owner recorded; an alert opens 30 days and again 7 days before — the watch never asks a provider"
    >
      {error ? (
        <UnreadNote what="The recorded expiry dates" />
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Reading the recorded dates…</p>
      ) : data.availability !== 'ok' ? (
        <>
          <UnreadNote what="The recorded expiry dates" />
          <p className="text-xs text-muted-foreground">
            The read was {availabilityWord(data.availability)}. A missing date here is not the same as no date.
          </p>
        </>
      ) : (
        <StripedList label="Credential expiry dates">
          {data.credentials.map((credential) => (
            <CredentialRow
              key={credential.integration}
              credential={credential}
              canManage={data.canManage}
              busy={busyKey === credential.integration}
              onSave={onSave}
            />
          ))}
        </StripedList>
      )}
    </CardShell>
  );
}

function CredentialRow({
  credential,
  canManage,
  busy,
  onSave,
}: {
  credential: CredentialExpiry;
  canManage: boolean;
  busy: boolean;
  onSave: (key: CredentialExpiry['integration'], expiresOn: string | null) => void;
}) {
  const [draft, setDraft] = useState(credential.expiresOn ?? '');
  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusMark tone={expiryTone(credential.window)} />
        <span className="text-[13px] font-semibold break-words">{credential.name}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {expiryWords(credential.window, credential.daysLeft, credential.expiresOn)}
        </span>
      </div>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground break-words">{credential.purpose}</p>
      {canManage && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            Expires on
            <input
              aria-label={`${credential.name} expiry date`}
              type="date"
              className="h-9 rounded-md border px-2 text-sm"
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <Button size="sm" disabled={busy || !draft || draft === credential.expiresOn} onClick={() => onSave(credential.integration, draft)}>
            {busy ? 'Saving…' : 'Save date'}
          </Button>
          {credential.expiresOn && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onSave(credential.integration, null)}>
              Clear date
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function CredentialExpiryPanel() {
  const [data, setData] = useState<CredentialExpiryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await integrationsApi.credentials());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the recorded expiry dates');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: CredentialExpiry['integration'], expiresOn: string | null) => {
    setBusyKey(key);
    setSaveError(null);
    try {
      await integrationsApi.setExpiry(key, expiresOn, idemKey());
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The date was not saved');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <CredentialExpiryCard data={data} error={error} busyKey={busyKey} onSave={(key, value) => void save(key, value)} />
      {saveError && (
        <p role="alert" className="col-span-full text-sm text-amber-600">
          {saveError}
        </p>
      )}
    </>
  );
}

export function IntegrationTestsCard({
  data,
  error,
  running,
  results,
  timezone,
  onRun,
}: {
  data: IntegrationTests | null;
  error: string | null;
  running: string | null;
  results: Partial<Record<string, IntegrationTestResult | string>>;
  timezone?: string | null;
  onRun: (key: IntegrationTests['tests'][number]['integration']) => void;
}) {
  return (
    <CardShell
      span={12}
      icon={FlaskConical}
      title="Integration tests"
      note="each a harmless round trip through a local fake adapter — no real provider is called in this release"
    >
      {error ? (
        <UnreadNote what="The integration tests" />
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Reading the integration tests…</p>
      ) : (
        <>
          {!data.available && (
            <p className="text-xs text-muted-foreground">
              Running a test needs a deployment with test controls on and the console:integration:test permission.
            </p>
          )}
          {data.availability !== 'ok' && (
            <p className="text-xs text-muted-foreground">
              When each last ran could not be read ({availabilityWord(data.availability)}).
            </p>
          )}
          <StripedList label="Integration tests">
            {data.tests.map((test) => {
              const result = results[test.integration];
              return (
                <li key={test.integration} className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusMark tone={test.lastOutcome === 'ok' ? 'ok' : test.lastOutcome === 'failed' ? 'down' : 'idle'} />
                    <span className="text-[13px] font-semibold break-words">{test.label}</span>
                    <Tag>{data.adapter} adapter</Tag>
                    <span className="ml-auto text-xs text-muted-foreground" title={test.lastRunAt ? formatWhen(test.lastRunAt, timezone) : undefined}>
                      {test.lastRunAt ? `last ${test.lastOutcome ?? 'run'} ${timeAgo(test.lastRunAt)}` : 'never run here'}
                    </span>
                    {data.available && (
                      <Button size="sm" variant="outline" disabled={running !== null} onClick={() => onRun(test.integration)}>
                        {running === test.integration ? 'Running…' : 'Run test'}
                      </Button>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground break-words">{test.description}</p>
                  {typeof result === 'string' ? (
                    <p role="alert" className="mt-1 text-xs text-amber-600">{result}</p>
                  ) : result ? (
                    <p role="status" className="mt-1 text-xs">
                      {result.outcome === 'ok' ? 'Passed' : 'Failed'} ·{' '}
                      {result.steps.map((s) => `${s.step} ${s.outcome}`).join(', ')} · {result.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </StripedList>
        </>
      )}
    </CardShell>
  );
}

export function IntegrationTestsPanel({ timezone }: { timezone?: string | null }) {
  const [data, setData] = useState<IntegrationTests | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<string, IntegrationTestResult | string>>>({});

  const load = useCallback(async () => {
    try {
      setData(await integrationsApi.tests());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the integration tests');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: IntegrationTests['tests'][number]['integration']) => {
    setRunning(key);
    try {
      const result = await integrationsApi.runTest(key, idemKey());
      setResults((prev) => ({ ...prev, [key]: result }));
      await load();
    } catch (err) {
      setResults((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : 'The test did not run' }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <IntegrationTestsCard
      data={data}
      error={error}
      running={running}
      results={results}
      timezone={timezone}
      onRun={(key) => void run(key)}
    />
  );
}
