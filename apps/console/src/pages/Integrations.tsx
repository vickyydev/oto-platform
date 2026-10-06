import { useCallback, useEffect, useState } from 'react';
import {
  Bug,
  CreditCard,
  HardDrive,
  KeyRound,
  Loader2,
  MessageSquare,
  Package,
  Plug,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { isMissingRoute } from '@/api/client';
import {
  integrationsApi,
  type EnvVariable,
  type IntegrationProvider,
  type IntegrationsSnapshot,
} from '@/api/observability';
import { Button } from '@/components/ui/button';
import { ErrorNote, Loading, RouteUnavailable } from '@/components/Panel';
import { StatusMark, type Tone } from '@/components/Status';
import { GatewaySimulatorPanel } from '@/components/integrations/GatewaySimulatorPanel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { BarChip, CodeTag, StatusChip, Tag, TitleChip } from '@/components/redesign/chips';
import { CardShell, FactLine, FactList, PageGrid, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { useSession } from '@/auth/SessionContext';
import { formatWhen, timeAgo } from '@/lib/time';

/**
 * The outside services this platform leans on, and what each is doing — one
 * card per service, shaped from exactly what `/ops/integrations` reports
 * (SCRUM-474). A card never claims more than the route says: configured or
 * not, what is unset, where it answers, and what it last delivered.
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
  const requiredUnset = unset.filter((v) => v.required).length;
  // Grouped as before — a category's services side by side — and then laid
  // out as one card each.
  const ordered = groupByCategory(providers).flatMap(([, list]) => list);
  const categories = new Set(providers.map((p) => p.category ?? 'Services'));

  return (
    <>
      <CommandBar
        sectionId="integrations"
        badges={<TitleChip>whether each is configured, and what it last did</TitleChip>}
        actions={
          <>
            {snapshot && !missing && (
              <BarChip tone={unset.length === 0 ? 'ok' : requiredUnset > 0 ? 'down' : 'warn'}>
                {unset.length === 0
                  ? 'Everything provisioned'
                  : `${unset.length} variable${unset.length === 1 ? '' : 's'} unset`}
              </BarChip>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 rounded-full px-3.5"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
          </>
        }
      />

      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
        Whether each service is configured, and what it last did. No value of any credential appears on
        this page or in the response behind it.
      </p>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <PageGrid>
        {missing ? (
          <CardShell span={12} icon={Plug} title="Services">
            <RouteUnavailable
              what="The integration register"
              detail="It is generated from the API's own environment schema, so it appears as soon as that route is deployed here."
            />
          </CardShell>
        ) : loading && !snapshot ? (
          <CardShell span={12} icon={Plug} title="Services">
            <Loading what="integrations" />
          </CardShell>
        ) : providers.length === 0 ? (
          <CardShell span={12} icon={Plug} title="Services">
            <EmptyNote title="No services declared" detail="The API names no outside service it calls." />
          </CardShell>
        ) : (
          ordered.map((provider) => (
            <ProviderCard
              key={provider.key}
              provider={provider}
              timezone={timezone}
              showCategory={categories.size > 1}
            />
          ))
        )}

        {/**
         * THE QR GATEWAY GETS A CARD OF ITS OWN, below the service cards and
         * above the variable list.
         *
         * The cards above answer "is it configured"; this one answers the two
         * questions that only matter for money — WHICH gateway is actually live
         * right now, and, when it is the simulator, a way to rehearse every case
         * a QR can end in before one of them happens at a counter on a Saturday.
         * A deployment quietly running a pretend gateway is the thing this page
         * exists to make impossible to miss, so it says so here in its own words
         * rather than as one card among a dozen.
         */}
        <GatewaySimulatorPanel timezone={timezone} span={12} />

        {!missing && snapshot && (
          <CardShell
            span={7}
            icon={KeyRound}
            title="Variables to provision"
            note="named from the API's environment schema; anything unset is a service that will not work until someone sets it in Render"
          >
            {unset.length === 0 ? (
              <EmptyNote
                good
                className="py-3"
                title="Everything is set"
                detail="Every variable the API declares has a value on this deployment."
              />
            ) : (
              <StripedList label="Unset variables">
                {unset.map((variable) => (
                  <VariableRow key={variable.name} variable={variable} />
                ))}
              </StripedList>
            )}
          </CardShell>
        )}

        <ConsoleBuild span={!missing && snapshot ? 5 : 12} />
      </PageGrid>
    </>
  );
}

/** A glyph for the card, from what the service says about itself. Presentation only. */
function providerIcon(provider: IntegrationProvider): LucideIcon {
  const words = `${provider.key} ${provider.category ?? ''} ${provider.name}`.toLowerCase();
  if (/2c2p|payment|gateway|edc|card/.test(words)) return CreditCard;
  if (/sms|twilio|message|whatsapp|mail|line|telegram|notif/.test(words)) return MessageSquare;
  if (/\bai\b|openai|anthropic|claude|llm|assistant/.test(words)) return Sparkles;
  if (/storage|s3|minio|bucket|file/.test(words)) return HardDrive;
  if (/sentry|error/.test(words)) return Bug;
  if (/oto app|app|staff/.test(words)) return Smartphone;
  if (/package|release|deploy/.test(words)) return Package;
  return Plug;
}

function ProviderCard({
  provider,
  timezone,
  showCategory,
}: {
  provider: IntegrationProvider;
  timezone?: string | null;
  showCategory: boolean;
}) {
  const tone = toneForIntegration(provider.state);
  const hasFacts =
    (provider.missingVars?.length ?? 0) > 0 || Boolean(provider.endpoint) || Boolean(provider.lastDeliveryAt);
  return (
    <CardShell
      span={6}
      icon={providerIcon(provider)}
      title={provider.name}
      badge={showCategory && provider.category ? <Tag>{provider.category}</Tag> : undefined}
      actions={<StatusChip tone={tone}>{stateWord(provider.state)}</StatusChip>}
    >
      {provider.purpose && (
        <p className="text-[13px] text-muted-foreground break-words">{provider.purpose}</p>
      )}
      {hasFacts && (
        <FactList>
          {provider.missingVars && provider.missingVars.length > 0 && (
            <FactLine label="Unset">
              <span className="inline-flex flex-wrap justify-end gap-1.5">
                {provider.missingVars.map((name) => (
                  <CodeTag key={name}>{name}</CodeTag>
                ))}
              </span>
            </FactLine>
          )}
          {provider.endpoint && (
            <FactLine label="Answers at">
              <span className="font-mono text-xs font-normal break-all">{provider.endpoint}</span>
            </FactLine>
          )}
          {provider.lastDeliveryAt && (
            <FactLine label="Last delivery">
              <span
                className="inline-flex items-center gap-2"
                title={formatWhen(provider.lastDeliveryAt, timezone)}
              >
                <Tag>{provider.lastDeliveryOutcome ?? 'delivered'}</Tag>
                {timeAgo(provider.lastDeliveryAt)}
              </span>
            </FactLine>
          )}
        </FactList>
      )}
      {provider.detail && (
        <p className="mt-auto text-xs leading-normal text-muted-foreground/80 break-words">{provider.detail}</p>
      )}
    </CardShell>
  );
}

function VariableRow({ variable }: { variable: EnvVariable }) {
  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusMark tone={variable.required ? 'down' : 'warn'} />
        <code className="font-mono text-[13px] font-semibold break-all">{variable.name}</code>
        {variable.provider && <Tag>{variable.provider}</Tag>}
        <span className="ml-auto text-xs text-muted-foreground">
          {variable.required ? 'required' : 'optional'}
        </span>
      </div>
      {variable.purpose && (
        <p className="mt-0.5 text-[12.5px] text-muted-foreground break-words">{variable.purpose}</p>
      )}
    </li>
  );
}

/**
 * This static site's own build-time settings. It belongs on this page for the
 * same reason the rest does — a link that goes nowhere is an integration that
 * is not configured — and it is the one card that works with no API at all,
 * because Vite inlined these values when the bundle was built.
 */
function ConsoleBuild({ span }: { span: 5 | 12 }) {
  const settings = [
    {
      name: 'VITE_LAUNCHER_URL',
      value: import.meta.env.VITE_LAUNCHER_URL,
      purpose: 'The suite front door, for the All apps link and for password changes.',
    },
    {
      name: 'VITE_POS_URL',
      value: import.meta.env.VITE_POS_URL,
      purpose: "The till's origin, for the link to its /admin back-office panels.",
    },
  ];

  return (
    <CardShell
      span={span}
      icon={Package}
      title="This console's own build"
      note="set when the site was built, not when it started — changing one is a rebuild, not a restart"
    >
      <StripedList label="Build settings">
        {settings.map((setting) => (
          <li key={setting.name} className="px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusMark tone={setting.value ? 'ok' : 'idle'} />
              <code className="font-mono text-[13px] font-semibold break-all">{setting.name}</code>
              <span className="ml-auto text-xs text-muted-foreground">{setting.value ? 'set' : 'not set'}</span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{setting.purpose}</p>
          </li>
        ))}
      </StripedList>
    </CardShell>
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
