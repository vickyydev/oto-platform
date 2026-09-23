import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { isMissingRoute } from '@/api/client';
import {
  integrationsApi,
  type EnvVariable,
  type IntegrationProvider,
  type IntegrationsSnapshot,
} from '@/api/observability';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNote, Loading, Panel, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusMark, StatusPill, type Tone } from '@/components/Status';
import { GatewaySimulatorPanel } from '@/components/integrations/GatewaySimulatorPanel';
import { useSession } from '@/auth/SessionContext';
import { formatWhen, timeAgo } from '@/lib/time';

/**
 * The outside services this platform leans on, and what each is doing.
 *
 * NAMES AND STATES ONLY. Nothing on this page is ever a credential: a provider
 * is "configured" or it is not, and where it is not, what is named is the
 * VARIABLE that is unset — never its value, never a partial value, never a
 * masked one. A masked secret on a screen is still a secret on a screen, and
 * the page is read over shoulders in a back office.
 */
export function Integrations() {
  const { me } = useSession();
  const timezone = me?.branch?.timezone;

  const [snapshot, setSnapshot] = useState<IntegrationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await integrationsApi.snapshot());
      setMissing(false);
    } catch (err) {
      if (isMissingRoute(err)) {
        setMissing(true);
        setSnapshot(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not read the integration list');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = snapshot?.providers ?? [];
  const unset = (snapshot?.variables ?? []).filter((v) => !v.present);
  const grouped = groupByCategory(providers);

  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
        Whether each service is configured, and what it last did. No value of any credential appears on
        this page or in the response behind it.
      </p>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <Panel
        title="Services"
        description="Everything the platform calls out to."
        actions={
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </Button>
        }
      >
        {missing ? (
          <RouteUnavailable
            what="The integration register"
            detail="It is generated from the API's own environment schema, so it appears as soon as that route is deployed here."
          />
        ) : loading ? (
          <Loading what="integrations" />
        ) : providers.length === 0 ? (
          <EmptyState title="No services declared" />
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map(([category, list]) => (
              <div key={category}>
                {grouped.length > 1 && (
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-foreground/35">
                    {category}
                  </h3>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  {list.map((provider) => (
                    <ProviderCard key={provider.key} provider={provider} timezone={timezone} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/**
       * THE QR GATEWAY GETS A PANEL OF ITS OWN, above the variable list and
       * below the service cards.
       *
       * The cards above answer "is it configured"; this one answers the two
       * questions that only matter for money — WHICH gateway is actually live
       * right now, and, when it is the simulator, a way to rehearse every case
       * a QR can end in before one of them happens at a counter on a Saturday.
       * A deployment quietly running a pretend gateway is the thing this page
       * exists to make impossible to miss, so it says so here in its own words
       * rather than as one card among a dozen.
       */}
      <GatewaySimulatorPanel timezone={timezone} />

      {!missing && snapshot && (
        <Panel
          title="Variables to provision"
          description="Named from the API's environment schema. Anything unset is a service that will not work until someone sets it in Render."
        >
          {unset.length === 0 ? (
            <EmptyState
              title="Everything is set"
              detail="Every variable the API declares has a value on this deployment."
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {unset.map((variable) => (
                <VariableRow key={variable.name} variable={variable} />
              ))}
            </ul>
          )}
        </Panel>
      )}

      <ConsoleBuild />
    </div>
  );
}

function ProviderCard({
  provider,
  timezone,
}: {
  provider: IntegrationProvider;
  timezone?: string | null;
}) {
  const tone = toneForIntegration(provider.state);
  return (
    <div className="rounded-xl border bg-background/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold min-w-0 break-words">{provider.name}</span>
        <StatusPill tone={tone} className="ml-auto">
          {stateWord(provider.state)}
        </StatusPill>
      </div>

      {provider.purpose && (
        <p className="mt-1.5 text-sm text-muted-foreground break-words">{provider.purpose}</p>
      )}
      {provider.detail && (
        <p className="mt-1.5 text-sm text-muted-foreground break-words">{provider.detail}</p>
      )}

      {provider.missingVars && provider.missingVars.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">unset:</span>
          {provider.missingVars.map((name) => (
            <code key={name} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono">
              {name}
            </code>
          ))}
        </p>
      )}

      {provider.endpoint && (
        <p className="mt-2 text-xs text-muted-foreground break-all">
          <span className="font-mono">{provider.endpoint}</span>
        </p>
      )}

      {provider.lastDeliveryAt && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Chip>{provider.lastDeliveryOutcome ?? 'delivered'}</Chip>
          <span title={formatWhen(provider.lastDeliveryAt, timezone)}>
            last delivery {timeAgo(provider.lastDeliveryAt)}
          </span>
        </p>
      )}
    </div>
  );
}

function VariableRow({ variable }: { variable: EnvVariable }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
      <StatusMark tone={variable.required ? 'down' : 'warn'} />
      <code className="font-mono text-sm font-semibold break-all">{variable.name}</code>
      {variable.provider && <Chip>{variable.provider}</Chip>}
      <span className="text-xs text-muted-foreground ml-auto">
        {variable.required ? 'required' : 'optional'}
      </span>
      {variable.purpose && (
        <p className="w-full text-sm text-muted-foreground break-words">{variable.purpose}</p>
      )}
    </li>
  );
}

/**
 * This static site's own build-time settings. It belongs on this page for the
 * same reason the rest does — a link that goes nowhere is an integration that
 * is not configured — and it is the one section that works with no API at all,
 * because Vite inlined these values when the bundle was built.
 */
function ConsoleBuild() {
  const settings = [
    {
      name: 'VITE_LAUNCHER_URL',
      value: import.meta.env.VITE_LAUNCHER_URL,
      purpose: 'The suite front door, for the header link and for password changes.',
    },
    {
      name: 'VITE_POS_URL',
      value: import.meta.env.VITE_POS_URL,
      purpose: "The till's origin, for the link to its /admin back-office panels.",
    },
  ];

  return (
    <Panel
      title="This console's own build"
      description="Set when the site was built, not when it started — changing one is a rebuild, not a restart."
    >
      <ul className="flex flex-col divide-y">
        {settings.map((setting) => (
          <li key={setting.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
            <StatusMark tone={setting.value ? 'ok' : 'idle'} />
            <code className="font-mono text-sm font-semibold break-all">{setting.name}</code>
            <span className="text-sm text-muted-foreground ml-auto">{setting.value ? 'set' : 'not set'}</span>
            <p className="w-full text-sm text-muted-foreground">{setting.purpose}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function groupByCategory(providers: IntegrationProvider[]): Array<[string, IntegrationProvider[]]> {
  const groups = new Map<string, IntegrationProvider[]>();
  for (const provider of providers) {
    const key = provider.category ?? 'Services';
    const list = groups.get(key) ?? [];
    list.push(provider);
    groups.set(key, list);
  }
  return Array.from(groups.entries());
}

function stateWord(state: string): string {
  switch (state) {
    case 'configured':
      return 'Configured';
    case 'missing':
      return 'Not configured';
    case 'disabled':
      return 'Off';
    case 'degraded':
      return 'Failing';
    default:
      return state;
  }
}

function toneForIntegration(state: string): Tone {
  switch (state) {
    case 'configured':
      return 'ok';
    case 'degraded':
      return 'down';
    case 'missing':
      return 'warn';
    case 'disabled':
      return 'idle';
    default:
      return 'idle';
  }
}
