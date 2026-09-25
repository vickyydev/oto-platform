import { useState } from 'react';
import { MonitorSmartphone, Unplug } from 'lucide-react';
import { EmptyState, ErrorNote, Panel, RouteUnavailable, Unreadable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/Status';
import { formatWhen, timeAgo } from '@/lib/time';
import type { BoothScreenRow, BoothStatus, MintedPairingCode } from './boothApi';
import type { Read } from './readState';

/**
 * Where a booth's box runs, as its live status reports it — which decides
 * whether its television is paired here at all.
 *
 *   - `here`: the box is the platform's virtual box, running inside the api
 *     that answered (`box.inProcess`). Its television is the booth page the
 *     platform serves, and that page presses only with a credential it was
 *     paired with on this panel.
 *   - `own_box`: the box runs somewhere else — a Raspberry Pi at the booth.
 *     The Pi serves its own television from the same machine and checks no
 *     credential (`packages/box-agent/src/runner/kiosk-server.ts`), so there
 *     is nothing to pair, and a screen paired here cannot press this booth
 *     while it runs on that box: the api's booth relay reaches only a booth
 *     whose box runs inside that api (`resolveInProcessBooth` in
 *     `apps/api/src/services/booth.ts`).
 *   - `no_box`: the booth has no box, so nothing can play it yet.
 *   - `unknown`: the status has not been read, or what is held belongs to the
 *     booth selected before this one.
 */
export type BoothBoxPlace = 'here' | 'own_box' | 'no_box' | 'unknown';

/**
 * The place for THIS booth. The page keeps the last booth's status on screen
 * while the next one's is read, so a reading is used only when it names the
 * booth being shown; a stale one still does, because a booth rarely changes
 * box and an older true answer beats none.
 */
export function boothBoxPlace(status: Read<BoothStatus | null>, boothId: string): BoothBoxPlace {
  const s = status.value;
  if (!s || s.booth.id !== boothId) return 'unknown';
  if (status.state !== 'read' && status.state !== 'stale') return 'unknown';
  if (s.box.id === null) return 'no_box';
  return s.box.inProcess ? 'here' : 'own_box';
}

/**
 * Console > Booths > "Screens" (SCRUM-244).
 *
 * The panel that closed a hole rather than added a feature. The booth
 * television used to carry nothing at all — no cookie, no account, no key —
 * which meant `POST /booth/spin` was a URL anybody could press on a deployment
 * running the virtual box, and pressing it minted a voucher the park would
 * honour. A screen now holds a credential it was PAIRED with, and this is
 * where a member of staff mints one and takes one away.
 *
 * **Only a booth on the platform's virtual box is paired.** A booth on its own
 * box — the Raspberry Pi — has its television on that box and needs no
 * pairing, so for it the panel says so and offers no "Pair a screen"; a screen
 * paired to it before stays listed, so it can still be unpaired
 * (`BoothBoxPlace` above). Until the status has been read the panel cannot tell
 * the two apart, and it says what each needs.
 *
 * **The code is shown once and this panel does not keep it.** The API returns
 * it outside anything it stores — only a hash is kept — so there is nothing to
 * come back to. Pressing "Pair a screen" again mints a fresh code and kills
 * the previous one, which is said on the panel rather than left to be
 * discovered: a manager who walks away and returns needs to know that the
 * digits on the sticky note are already dead.
 *
 * **Why revoked screens stay on the list.** "Which television was unpaired,
 * and when" is the question somebody asks after a screen goes missing from a
 * mall, and a list that quietly dropped them could not answer it.
 */
export function BoothScreensPanel({
  place,
  screens,
  minted,
  busy,
  readOnly,
  error,
  timezone,
  onMint,
  onUnpair,
  onRetry,
  onDismissCode,
}: {
  /** Where this booth's box runs (`boothBoxPlace`): whether pairing applies to it. */
  place: BoothBoxPlace;
  screens: Read<BoothScreenRow[]>;
  /** The code just minted, held by the PAGE for as long as it is on screen. */
  minted: MintedPairingCode | null;
  busy: boolean;
  /** The caller may read this booth but not pair screens to it. */
  readOnly: boolean;
  error: string | null;
  timezone?: string | null;
  onMint: () => void;
  onUnpair: (screen: BoothScreenRow) => void;
  onRetry: () => void;
  onDismissCode: () => void;
}) {
  /** Pairing is offered unless the status says this booth cannot use it. */
  const pairable = place === 'here' || place === 'unknown';
  const listed = screens.state === 'read' || screens.state === 'stale' ? screens.value : [];
  return (
    <Panel
      title="Screens"
      description={
        place === 'own_box'
          ? 'This booth runs on its own box; its television needs no pairing.'
          : place === 'no_box'
            ? 'This booth has no box yet, so no television can play it.'
            : 'The televisions allowed to press this booth’s button. A screen is paired once, by somebody standing at it with a code.'
      }
      actions={
        readOnly || !pairable ? undefined : (
          <Button variant="outline" size="sm" onClick={onMint} disabled={busy}>
            <MonitorSmartphone className="w-4 h-4" />
            {busy ? 'Minting…' : 'Pair a screen'}
          </Button>
        )
      }
    >
      {error && <ErrorNote message={error} />}

      {minted && <PairingCode minted={minted} timezone={timezone} onDismiss={onDismissCode} />}

      {readOnly && (pairable || listed.length > 0) && (
        <p className="mb-3 text-xs text-muted-foreground">
          Pairing and unpairing screens needs{' '}
          <code className="font-mono text-xs">admin:booth:manage</code>.
        </p>
      )}

      {!pairable && listed.some((screen) => screen.revokedAt === null) && (
        <p className="mb-3 text-xs text-muted-foreground">
          {place === 'own_box'
            ? 'A screen paired to this booth here is not used while the booth runs on its own box. Unpair any still listed as paired.'
            : 'A screen paired to this booth here does nothing while the booth has no box. Unpair any that are not wanted.'}
        </p>
      )}

      {screens.state === 'absent' ? (
        <RouteUnavailable
          what="Booth screens"
          detail="This deployment does not serve the booth pairing routes yet — SCRUM-244."
        />
      ) : screens.state === 'failed' ? (
        <Unreadable what="This booth’s screens" message={screens.error} onRetry={onRetry} />
      ) : screens.value.length === 0 ? (
        place === 'own_box' ? (
          <EmptyState
            title="Nothing to pair"
            detail="The box serves the booth’s television itself, so there is no code to type there."
          />
        ) : place === 'no_box' ? (
          <EmptyState
            title="Nothing to pair yet"
            detail="Give the booth a box on Devices. A booth on its own box, such as a Raspberry Pi, needs no pairing; one on the platform’s virtual box has its screen paired here."
          />
        ) : place === 'here' ? (
          <EmptyState
            title="No screen is paired to this booth"
            detail="Until one is, the television shows “ask our staff” and the booth surface refuses every press — which is the point: an unpaired screen cannot mint a voucher."
          />
        ) : (
          <EmptyState
            title="No screen is paired to this booth"
            detail="A booth on the platform’s virtual box needs one: until then its television asks for staff and refuses every press. A booth on its own box, such as a Raspberry Pi, needs none."
          />
        )
      ) : (
        <ul className="flex flex-col divide-y">
          {screens.value.map((screen) => (
            <li key={screen.id} className="py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold">{screen.label ?? 'unnamed screen'}</span>

              {screen.revokedAt !== null ? (
                <StatusPill tone="idle">unpaired</StatusPill>
              ) : screen.pairingOutstanding ? (
                <StatusPill tone="warn">code outstanding</StatusPill>
              ) : (
                <StatusPill tone="ok">paired</StatusPill>
              )}

              <span className="text-sm text-muted-foreground">
                {screen.revokedAt !== null
                  ? `unpaired ${formatWhen(screen.revokedAt, timezone)}${
                      screen.revokedReason ? ` — ${screen.revokedReason}` : ''
                    }`
                  : screen.pairedAt !== null
                    ? `paired ${formatWhen(screen.pairedAt, timezone)}`
                    : screen.pairingCodeExpiresAt !== null
                      ? `code expires ${formatWhen(screen.pairingCodeExpiresAt, timezone)}`
                      : 'never paired'}
              </span>

              {/*
                "Last seen" is how a manager tells a live television from one
                that was unplugged: the booth page polls status every five
                seconds, so a paired screen that has not been seen for minutes
                is a screen that is off, unplugged or gone.
              */}
              {screen.revokedAt === null && screen.pairedAt !== null && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {screen.lastSeenAt === null
                    ? 'not seen since pairing'
                    : `last seen ${timeAgo(screen.lastSeenAt)}`}
                </span>
              )}

              {!readOnly && screen.revokedAt === null && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => onUnpair(screen)}
                >
                  <Unplug className="w-4 h-4" />
                  Unpair
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The digits, while somebody walks to the booth with them.
 *
 * Shown large and monospaced because they are read off this screen and typed
 * into a number pad across the room, and grouped in threes for the same
 * reason a phone number is. It has a dismiss control rather than a timer: a
 * manager who has finished pairing should be able to take a code off their own
 * screen, and a code that vanished on its own mid-walk would be worse than one
 * that is still showing when it has already expired — which the expiry line
 * says.
 */
function PairingCode({
  minted,
  timezone,
  onDismiss,
}: {
  minted: MintedPairingCode;
  timezone?: string | null;
  onDismiss: () => void;
}) {
  const [revealed, setRevealed] = useState(true);
  const code = minted.pairingCode;
  return (
    <div className="mb-4 rounded-xl border-2 border-dashed px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Type this into the booth television
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <code className="font-mono text-2xl font-bold tabular-nums tracking-[0.3em]">
          {revealed ? `${code.slice(0, 3)} ${code.slice(3)}` : '••• •••'}
        </code>
        <Button variant="outline" size="sm" onClick={() => setRevealed((v) => !v)}>
          {revealed ? 'Hide' : 'Show'}
        </Button>
        <Button variant="outline" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Expires {formatWhen(minted.expiresAt, timezone)}. It works once, and it is not stored — a
        new one can be minted at any time, which kills this one.
      </p>
    </div>
  );
}
