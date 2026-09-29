import { useEffect, useRef, useState } from 'react';
import type { DisplaySnapshotResponse } from '@oto/shared';
import { ApiError } from '@/api/client';
import { fleetApi } from '@/api/fleet';
import { Button } from '@/components/ui/button';
import { ErrorNote, Loading } from '@/components/Panel';
import { formatExact } from '@/lib/time';

export function DisplaySnapshotPanel({
  credentialId,
  stationId,
  stationLabel,
  timezone,
  revoked,
}: {
  credentialId: string;
  stationId: string | null;
  stationLabel: string;
  timezone?: string | null;
  revoked: boolean;
}) {
  const [result, setResult] = useState<DisplaySnapshotResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const readSequence = useRef(0);

  useEffect(() => {
    const sequence = ++readSequence.current;
    setBusy(true);
    setResult(null);
    setFailed(null);
    void fleetApi
      .displaySnapshot(credentialId)
      .then((response) => {
        if (sequence !== readSequence.current) return;
        const saved = response.snapshot;
        if (saved && (saved.document.stationId !== saved.stationId
          || saved.document.boxId !== saved.boxId
          || (!response.targetChanged && saved.stationId !== stationId))) {
          throw new Error('The recorded display response could not be verified.');
        }
        setResult(response);
      })
      .catch((error: unknown) => {
        if (sequence !== readSequence.current) return;
        setFailed(
          error instanceof ApiError && error.status === 403
            ? "You do not have permission to read this display's saved response."
            : error instanceof ApiError && error.status === 404
              ? "This display's saved response is not available."
              : 'The recorded display response could not be read. Try again.',
        );
      })
      .finally(() => {
        if (sequence === readSequence.current) setBusy(false);
      });
    return () => {
      readSequence.current += 1;
    };
  }, [credentialId, stationId, refresh]);

  const saved = result?.snapshot;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Last recorded response prepared by OTO Park. Browser receipt is not verified.
      </p>
      <p className="text-xs text-muted-foreground">
        Refresh reads this display's saved response. It does not request a fresh station view.
      </p>
      {(revoked || result?.revoked) && (
        <p className="text-sm">This display's access is revoked. Its last recorded response is retained as history.</p>
      )}
      {result?.targetChanged && (
        <p className="text-sm">
          This response belongs to an earlier park, station, box or box reset. It is retained as history.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Only public display fields are shown. Staff, medical and credential fields, contact answers
        and payment QR contents are omitted.
      </p>
      {busy && <Loading what="recorded display response" />}
      {failed && <ErrorNote message={failed} />}
      {result && !saved && (
        <p className="text-sm">No response has been recorded for this display yet.</p>
      )}
      {saved && (
        <>
          {!result?.targetChanged && <p className="text-xs text-muted-foreground">Prepared for {stationLabel}.</p>}
          <p className="text-xs text-muted-foreground" aria-label="Recorded display response details">
            Prepared at {formatExact(saved.preparedAt, timezone)}
            {' · '}{saved.responseKind === 'session' ? 'Station response' : 'Intent response'}
            {' · '}HTTP {saved.statusCode}
            {saved.journalEpoch !== null && <> · Box epoch {saved.journalEpoch}</>}
          </p>
          <pre
            aria-label="Last recorded display snapshot"
            className="max-h-[50dvh] min-w-0 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 text-xs"
          >
            {JSON.stringify(saved.document, null, 2)}
          </pre>
        </>
      )}
      <Button variant="outline" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Refresh snapshot
      </Button>
    </>
  );
}
