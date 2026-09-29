import { useEffect, useRef, useState } from 'react';
import {
  DisplayCartSchema,
  DisplayMemberSchema,
  DisplayPaymentSchema,
  DisplayTotalsSchema,
  type StationSessionDocument,
} from '@oto/shared';
import { ApiError } from '@/api/client';
import { fleetApi } from '@/api/fleet';
import { Button } from '@/components/ui/button';
import { ErrorNote, Loading } from '@/components/Panel';
import { formatExact } from '@/lib/time';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Unknown fields from an older server never become diagnostic output. */
function publicFields(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  const source = record(value);
  if (!source) return null;
  return Object.fromEntries(
    fields
      .filter(
        (key) =>
          key in source &&
          (source[key] === null || ['string', 'number', 'boolean'].includes(typeof source[key])),
      )
      .map((key) => [key, source[key]]),
  );
}

export function displaySnapshotView(document: StationSessionDocument) {
  const cart = record(document.cart);
  const sale = record(cart?.sale);
  const prompt = record(document.prompt);
  const publicCart = DisplayCartSchema.safeParse(cart);
  const publicMember = DisplayMemberSchema.safeParse(document.member);
  const publicTotals = DisplayTotalsSchema.safeParse(document.totals);
  const publicPayment = DisplayPaymentSchema.safeParse(document.payment);
  // The first identify/contact slice published only a tier. Never accept a
  // malformed full sale through that earlier, narrower contract.
  const earlyCart =
    sale &&
    !('id' in sale) &&
    typeof sale.tier === 'string' &&
    typeof cart?.supported === 'boolean' &&
    ['identify', 'welcome', 'input'].includes(document.stage)
      ? { supported: cart.supported, sale: { tier: sale.tier } }
      : null;
  const { qrPayload, qrImageUrl, ...payment } = publicPayment.success
    ? publicPayment.data
    : { qrPayload: null, qrImageUrl: null };
  return {
    ...publicFields(document, [
      'stationId',
      'boxId',
      'schemaVersion',
      'sequence',
      'stage',
      'language',
      'updatedAt',
    ]),
    member: publicMember.success ? publicMember.data : null,
    cart: publicCart.success ? publicCart.data : earlyCart,
    totals: publicTotals.success ? publicTotals.data : null,
    payment: publicPayment.success
      ? { ...payment, qrAvailable: Boolean(qrPayload || qrImageUrl) }
      : null,
    prompt: prompt
      ? {
          ...publicFields(prompt, [
            'kind',
            'requestId',
            'phone',
            'nickname',
            'contactChannel',
            'answeredAt',
          ]),
          answer: publicFields(prompt.answer, [
            'type',
            'actionId',
            'phone',
            'nickname',
            'contactChannel',
          ]),
        }
      : null,
  };
}

export function DisplaySnapshotPanel({
  stationId,
  stationLabel,
  timezone,
  revoked,
}: {
  stationId: string;
  stationLabel: string;
  timezone?: string | null;
  revoked: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{
    view: ReturnType<typeof displaySnapshotView>;
    serverTime: string;
  } | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const readSequence = useRef(0);

  useEffect(() => {
    const sequence = ++readSequence.current;
    setBusy(true);
    setSnapshot(null);
    setFailed(null);
    void fleetApi
      .displaySnapshot(stationId)
      .then((result) => {
        if (sequence !== readSequence.current) return;
        if (result.view !== 'customer' || result.document?.stationId !== stationId) {
          throw new Error('The customer view could not be verified.');
        }
        setSnapshot({ view: displaySnapshotView(result.document), serverTime: result.serverTime });
      })
      .catch((error: unknown) => {
        if (sequence !== readSequence.current) return;
        setFailed(
          error instanceof ApiError && error.status === 403
            ? 'You do not have permission to read this station.'
            : error instanceof ApiError && error.status === 404
              ? 'The station customer view is not available.'
              : 'The customer view could not be read. Try again.',
        );
      })
      .finally(() => {
        if (sequence === readSequence.current) setBusy(false);
      });
    return () => {
      readSequence.current += 1;
    };
  }, [stationId, refresh]);

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Current customer view at {stationLabel}. This is a fresh station read, not a record of what
        a disconnected display received.
      </p>
      {revoked && (
        <p className="text-sm">This display's access is revoked. It cannot receive this view.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Only public display fields are shown. Staff, medical and credential fields and payment QR
        contents are omitted.
      </p>
      {busy && <Loading what="customer view" />}
      {failed && <ErrorNote message={failed} />}
      {snapshot && (
        <>
          <p className="text-xs text-muted-foreground">
            Read at {formatExact(snapshot.serverTime, timezone)}
          </p>
          <pre
            aria-label="Current customer snapshot"
            className="max-h-[50dvh] min-w-0 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 text-xs"
          >
            {JSON.stringify(snapshot.view, null, 2)}
          </pre>
        </>
      )}
      <Button variant="outline" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Refresh snapshot
      </Button>
    </>
  );
}
