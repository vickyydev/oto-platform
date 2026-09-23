import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Ban, Clock, Hourglass, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { api, idemKey, isMissingRoute } from '@/api/client';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNote, Loading, Panel, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusPill, type Tone } from '@/components/Status';
import { formatWhen, timeAgo } from '@/lib/time';

/**
 * DRIVING THE QR GATEWAY FROM HERE, so a payment can be rehearsed.
 *
 * WHAT THIS IS FOR. Every case the park will meet on a QR — a guest who pays,
 * one who walks away, a code that times out, one scanned on the way out of the
 * mall, and the callback that simply never arrives — has to be watched from
 * end to end before it happens on a Saturday, and none of it can be rehearsed
 * by sending real money through a real bank from here.
 *
 * WHAT IT IS NOT. None of these buttons marks a sale paid. Each one changes
 * what the simulated gateway will SAY, and then the API signs a notification
 * with the configured secret and sends it through the REAL webhook route: the
 * signature is verified, the merchant is checked, the delivery is recorded and
 * de-duplicated, the invoice is matched, the amount is compared, a Payment
 * Inquiry has to agree, and only then does the sale close — inside the same
 * transaction a cash tender uses. A demo that took a shortcut past any of that
 * would be a demo of something nobody is going to run.
 *
 * "SUPPRESS THE CALLBACK" IS THE MOST USEFUL BUTTON HERE. It marks the payment
 * paid at the gateway and posts nothing at all, so the only thing that can
 * discover the money is the inquiry poller. That is how the safety net is
 * shown to work rather than assumed to.
 *
 * NO CREDENTIAL REACHES THIS PAGE. The panel names an attempt and an event;
 * the signing happens in the API. What it shows about configuration is
 * presence and names — never a value, never a partial value, never a masked
 * one, because a masked secret on a screen is still a secret on a screen.
 */

interface PendingAttempt {
  id: string;
  saleId: string | null;
  status: string;
  amountSatang: number;
  invoiceNo: string;
  expiresAt: string | null;
  createdAt: string;
  /** False when the API restarted after this QR was minted — see the note below. */
  simulatorKnowsIt: boolean;
  saleReceiptNumber: string | null;
}

interface GatewayStatus {
  provider: 'simulator' | '2c2p';
  environment: string;
  fellBack: boolean;
  reason: string;
  missingVars: string[];
  simulatorAvailable: boolean;
  channelCode: string;
  backendReturnUrlSet: boolean;
  webhookSecretSet: boolean;
  maintenanceConfigured: boolean;
  attempts: PendingAttempt[];
}

type GatewayEvent = 'paid' | 'decline' | 'expire' | 'late_paid' | 'suppress_webhook';

/**
 * The five controls, in the order somebody reaches for them, each with the
 * sentence that says what it actually does — because "decline" and "expire"
 * look interchangeable and are two different rows in the ledger.
 */
const CONTROLS: Array<{
  event: GatewayEvent;
  label: string;
  detail: string;
  icon: typeof BadgeCheck;
  said: string;
}> = [
  {
    event: 'paid',
    label: 'Customer paid',
    detail:
      'The gateway records the payment and posts a signed notification. The sale closes and takes its receipt number.',
    icon: BadgeCheck,
    said: 'The gateway says it was paid.',
  },
  {
    event: 'decline',
    label: 'Decline',
    detail: 'The guest abandoned it. The attempt closes, the sale is untouched, and the till offers the tenders again.',
    icon: Ban,
    said: 'The gateway declined it.',
  },
  {
    event: 'expire',
    label: 'Expire',
    detail: 'The code timed out with nobody scanning it. Different from a decline, and the ledger records which it was.',
    icon: Clock,
    said: 'The QR expired.',
  },
  {
    event: 'late_paid',
    label: 'Late payment',
    detail:
      'Paid after it expired — the guest who scanned on the way out. It never closes a sale on its own: it waits for a person to apply or refund it.',
    icon: Hourglass,
    said: 'A late payment arrived.',
  },
  {
    event: 'suppress_webhook',
    label: 'Suppress the callback',
    detail:
      'Mark it paid at the gateway and send NOTHING. Only the inquiry poller can find the money — which is the whole point of having one.',
    icon: WifiOff,
    said: 'Paid at the gateway, with no notification sent. The poller has to find it.',
  },
];

export function GatewaySimulatorPanel({ timezone }: { timezone?: string | null }) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.get<GatewayStatus>('/webhooks/2c2p/simulator'));
      setMissing(false);
    } catch (err) {
      if (isMissingRoute(err)) {
        setMissing(true);
        setStatus(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not read the payment gateway');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const press = async (attempt: PendingAttempt, control: (typeof CONTROLS)[number]) => {
    const key = `${attempt.id}:${control.event}`;
    setBusy(key);
    setNote(null);
    setFailed(null);
    try {
      const result = await api.post<{ webhookOutcome: string | null; gatewayState: string }>(
        '/webhooks/2c2p/simulator',
        { attemptId: attempt.id, event: control.event },
        { idempotencyKey: idemKey() },
      );
      setNote(
        result.webhookOutcome === null
          ? control.said
          : `${control.said} The webhook answered “${result.webhookOutcome}”.`,
      );
      await load();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'That did not reach the API');
    } finally {
      setBusy(null);
    }
  };

  if (missing) {
    return (
      <Panel title="QR payment gateway">
        <RouteUnavailable
          what="The gateway simulator"
          detail="It appears as soon as the payments API is deployed here."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="QR payment gateway"
      description="Which gateway this deployment runs, and — when it is the simulator — a way to rehearse every case a QR can end in."
      actions={
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </Button>
      }
    >
      {error && <ErrorNote message={error} onRetry={() => void load()} />}
      {loading && !status ? (
        <Loading what="the payment gateway" />
      ) : !status ? null : (
        <div className="flex flex-col gap-4">
          <GatewayCard status={status} />

          {note && (
            <p className="rounded-xl border px-4 py-2.5 text-sm text-muted-foreground">{note}</p>
          )}
          {failed && <ErrorNote message={failed} />}

          {!status.simulatorAvailable ? (
            <EmptyState
              title="This deployment talks to the real gateway"
              detail="There is nothing to simulate: a QR here is a real payment instruction, and it is paid in somebody's banking app."
            />
          ) : status.attempts.length === 0 ? (
            <EmptyState
              title="No QR is waiting to be paid"
              detail="Take a QR tender on a till and it appears here while the code is on the customer display."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {status.attempts.map((attempt) => (
                <AttemptRow
                  key={attempt.id}
                  attempt={attempt}
                  timezone={timezone}
                  busy={busy}
                  onPress={press}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function GatewayCard({ status }: { status: GatewayStatus }) {
  const tone: Tone = status.provider === '2c2p' ? 'ok' : status.fellBack ? 'warn' : 'idle';
  return (
    <div className="rounded-xl border bg-background/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">
          {status.provider === '2c2p' ? '2C2P' : 'Gateway simulator'}
        </span>
        <Chip>{status.environment}</Chip>
        <Chip>{status.channelCode}</Chip>
        <StatusPill tone={tone} className="ml-auto">
          {status.provider === '2c2p' ? 'Live' : status.fellBack ? 'Fallback' : 'Simulated'}
        </StatusPill>
      </div>

      <p className="mt-1.5 text-sm text-muted-foreground break-words">{status.reason}</p>

      {status.missingVars.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">unset:</span>
          {status.missingVars.map((name) => (
            <code key={name} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono">
              {name}
            </code>
          ))}
        </p>
      )}

      {/* Presence, never contents. */}
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Chip>{status.backendReturnUrlSet ? 'callback URL set' : 'no callback URL'}</Chip>
        <Chip>{status.webhookSecretSet ? 'URL filter set' : 'no URL filter'}</Chip>
        <Chip>{status.maintenanceConfigured ? 'refund keys set' : 'no refund keys'}</Chip>
      </p>
    </div>
  );
}

function AttemptRow({
  attempt,
  timezone,
  busy,
  onPress,
}: {
  attempt: PendingAttempt;
  timezone?: string | null;
  busy: string | null;
  onPress: (attempt: PendingAttempt, control: (typeof CONTROLS)[number]) => Promise<void>;
}) {
  return (
    <div className="rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-semibold">{attempt.invoiceNo}</code>
        <Chip>{baht(attempt.amountSatang)}</Chip>
        <Chip>{attempt.status}</Chip>
        <span className="ml-auto text-xs text-muted-foreground" title={formatWhen(attempt.createdAt, timezone)}>
          shown {timeAgo(attempt.createdAt)}
        </span>
      </div>

      {attempt.expiresAt && (
        <p className="mt-1 text-xs text-muted-foreground">
          expires {timeAgo(attempt.expiresAt)}
          {attempt.saleId ? ' · on a sale' : ' · not yet attached to a sale'}
        </p>
      )}

      {!attempt.simulatorKnowsIt ? (
        /**
         * The one limitation, said plainly rather than shown as a button that
         * fails. A pretend gateway's pretend state lives in the API process —
         * the same shape the box's printer simulators have — so a QR minted
         * before the last restart cannot be driven from here. The attempt is
         * still real, still pending, and still closes by the ordinary paths.
         */
        <p className="mt-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          The API has restarted since this QR was taken, so the simulator no longer remembers it.
          Take a new QR on the till to rehearse against.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {CONTROLS.map((control) => {
            const key = `${attempt.id}:${control.event}`;
            const Icon = control.icon;
            return (
              <Button
                key={control.event}
                variant="outline"
                size="sm"
                className="h-9 gap-2"
                title={control.detail}
                disabled={busy !== null}
                onClick={() => void onPress(attempt, control)}
              >
                {busy === key ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Icon className="w-4 h-4" />
                )}
                {control.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Satang to ฿, formatted the way every other figure on the console is. */
function baht(amountSatang: number): string {
  return `฿${(amountSatang / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
