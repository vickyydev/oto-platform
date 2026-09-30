import { useEffect, useMemo, useState } from 'react';
import { KeyRound, UserPlus } from 'lucide-react';
import {
  BOOTH_STAFF_SESSION_DEFAULT_MINUTES,
  ROLE_BUNDLES,
  boothStaffCode,
  type SystemRole,
} from '@oto/shared';
import { staffCandidates, type BranchStaffMember } from '@/api/fleet';
import { ErrorNote, Loading, RouteUnavailable, Unreadable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Field, Select, TextInput } from '@/components/Form';
import { CONTROL } from '@/components/Filters';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { cn } from '@/lib/utils';
import type { BoothPinInput, BoothPinResult, BoothStaffRow } from './boothApi';
import type { Read } from './readState';

/**
 * Staff assigned to the booth, with person-wide PIN management.
 * Typed PINs are cleared after saving; generated PINs are displayed once.
 * Only hashes and expiry reach the box, where offline sign-in is checked.
 *
 * On the page's card language (SCRUM-474): the people as striped rows, the
 * forms beneath the row or the list they belong to, the words unchanged.
 */
export function BoothStaffPanel({
  branchId,
  staff,
  session,
  busy,
  readOnly,
  error,
  onAdd,
  onRemove,
  onSetPin,
  onClearPin,
  onRetry,
  id,
  className,
}: {
  /** The booth's branch: whose staff the picker offers. */
  branchId: string;
  staff: Read<BoothStaffRow[]>;
  /**
   * How long a sign-in lasts, in minutes, null being the box's own twelve
   * hours: `running` is what the published wheel grants now (null too when
   * nothing is published or it names no length), `next` is the draft's,
   * which a publish would send.
   */
  session: { running: number | null; next: number | null };
  busy: boolean;
  /** The caller may read the list but not change it (`admin:booth:staff_assign`). */
  readOnly: boolean;
  error: string | null;
  onAdd: (accountId: string) => void;
  onRemove: (accountId: string) => void;
  /** Resolves true once the API has the PIN, so the fields can be emptied. */
  onSetPin: (accountId: string, input: BoothPinInput) => Promise<BoothPinResult | null>;
  onClearPin: (accountId: string) => void;
  onRetry: () => void;
  id?: string;
  className?: string;
}) {
  const [candidates, setCandidates] = useState<BranchStaffMember[] | null>(null);
  const [candidatesFailed, setCandidatesFailed] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [query, setQuery] = useState('');
  /** Whose PIN form is open, and the two fields — the only place a PIN is held. */
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [generate, setGenerate] = useState(false);
  const [expires, setExpires] = useState('');
  const [generated, setGenerated] = useState<{ accountId: string; pin: string } | null>(null);
  const [confirm, setConfirm] = useState<{ accountId: string; what: 'remove' | 'withdraw' } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    setCandidatesFailed(null);
    void staffCandidates(branchId)
      .then((result) => {
        if (!cancelled) setCandidates(result.staff);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setCandidates([]);
        setCandidatesFailed(
          reason instanceof Error ? reason.message : 'The staff list could not be read',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const byId = useMemo(
    () => new Map((candidates ?? []).map((c) => [c.accountId, c])),
    [candidates],
  );
  const onList = new Set(staff.value.map((s) => s.accountId));
  const offered = (candidates ?? [])
    .filter((c) => !onList.has(c.accountId))
    .filter((c) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (c.name ?? '').toLowerCase().includes(q) || (c.phone ?? '').toLowerCase().includes(q);
    });

  const nameOf = (accountId: string): string => {
    const c = byId.get(accountId);
    return c?.name ?? c?.phone ?? `Account ${boothStaffCode(accountId)}`;
  };

  const pinValid = /^\d{5}$/.test(pin);
  const pinsMatch = pin === again;
  const closePin = () => {
    setPinFor(null);
    setPin('');
    setAgain('');
    setExpires('');
    setGenerate(false);
  };

  const submitPin = async (accountId: string) => {
    if (!generate && (!pinValid || !pinsMatch)) return;
    setGenerated(null);
    const result = await onSetPin(accountId, {
      ...(generate ? { generate: true } : { pin }),
      expiresAt: expires ? new Date(expires).toISOString() : null,
    });
    // Emptied whatever the answer: a PIN is not kept on screen for a retry.
    closePin();
    if (result) {
      if (result.pin) setGenerated({ accountId, pin: result.pin });
      setNotice(
        `PIN set for ${nameOf(accountId)}. It reaches the booth at the box's next pull — within about a minute when the box is online.`,
      );
    }
  };

  const roles = (Object.entries(ROLE_BUNDLES) as Array<[SystemRole, readonly string[]]>)
    .filter(([, permissions]) => permissions.includes('booth:staff:sign_in'))
    .map(([role]) => ROLE_NAMES[role]);
  const hoursOf = (minutes: number | null): string => {
    const hours = (minutes ?? BOOTH_STAFF_SESSION_DEFAULT_MINUTES) / 60;
    return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  };
  const runningHours = hoursOf(session.running);
  const nextHours = hoursOf(session.next);
  /**
   * What the box grants NOW, which is the published length — a length saved
   * under Booth settings reaches the booth only with the next publish, and
   * until then the box still grants the old one.
   */
  const lasts =
    runningHours === nextHours
      ? `lasts ${runningHours} hours`
      : `lasts ${runningHours} hours (${nextHours} hours for sign-ins after the next publish)`;

  return (
    <CardShell
      id={id}
      className={className}
      icon={KeyRound}
      title="Booth staff"
      note="who may sign in at this booth, and whether each has a booth PIN — changes reach the booth at the box's next pull, no publish needed"
      footer={
        <p>
          Staff on this list can also sign in at the booth with their own phone and password, when
          their role allows it (<code className="font-mono">booth:staff:sign_in</code>):{' '}
          {roles.join(', ')}. A role the park created itself allows it only if it carries that
          permission. Either way a sign-in {lasts} — set under Booth settings — and does not end
          when nobody presses anything.
        </p>
      }
    >
      {error && <ErrorNote message={error} />}
      {notice && (
        <p className="rounded-[14px] border border-status-ok/30 bg-status-ok/12 px-3.5 py-2.5 text-sm">
          {notice}
        </p>
      )}
      {readOnly && (
        <p className="text-xs text-muted-foreground">
          Changing who works this booth needs{' '}
          <code className="font-mono text-xs">admin:booth:staff_assign</code>.
        </p>
      )}

      {staff.state === 'absent' ? (
        <RouteUnavailable
          what="Booth staff"
          detail="This deployment does not serve the booth staff routes yet."
        />
      ) : staff.state === 'failed' ? (
        <Unreadable what="This booth’s staff" message={staff.error} onRetry={onRetry} />
      ) : staff.state === 'unread' ? (
        <Loading what="booth staff" />
      ) : staff.value.length === 0 ? (
        <EmptyNote
          className="py-3"
          icon={KeyRound}
          title="Nobody may sign in at this booth"
          detail="The wheel still plays; every spin is recorded with nobody signed in. Add the people who work the booth below."
        />
      ) : (
        <StripedList label="Booth staff">
          {staff.value.map((member) => {
            const name = nameOf(member.accountId);
            const known = byId.has(member.accountId);
            return (
              <li key={member.accountId} className="flex flex-col gap-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13.5px] font-semibold">{name}</span>
                  <code className="font-mono text-xs text-muted-foreground">
                    {boothStaffCode(member.accountId)}
                  </code>
                  {member.hasPin ? (
                    <StatusChip tone="ok">PIN set</StatusChip>
                  ) : (
                    <StatusChip tone="idle">no PIN</StatusChip>
                  )}
                  {member.hasPin && member.pinExpiresAt && (
                    <span className="text-xs text-muted-foreground">
                      {Date.parse(member.pinExpiresAt) <= Date.now() ? 'Expired' : 'Expires'}{' '}
                      {new Date(member.pinExpiresAt).toLocaleString()}
                    </span>
                  )}
                  {candidates !== null && !known && (
                    <span className="text-xs text-muted-foreground">
                      not on this branch’s staff list — deactivated, or moved to another park
                    </span>
                  )}
                  {!readOnly &&
                    pinFor !== member.accountId &&
                    confirm?.accountId !== member.accountId && (
                      <span className="ml-auto flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-full bg-card px-3.5"
                          disabled={busy}
                          onClick={() => {
                            setNotice(null);
                            setConfirm(null);
                            setPin('');
                            setAgain('');
                            setGenerate(false);
                            setExpires('');
                            setGenerated(null);
                            setPinFor(member.accountId);
                          }}
                        >
                          <KeyRound className="w-4 h-4" />
                          Set PIN
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-full bg-card px-3.5"
                          disabled={busy}
                          onClick={() => {
                            closePin();
                            setConfirm(null);
                            setNotice(null);
                            setGenerated(null);
                            setGenerate(true);
                            setPinFor(member.accountId);
                          }}
                        >
                          Generate PIN
                        </Button>
                        {member.hasPin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full px-3.5"
                            disabled={busy}
                            onClick={() =>
                              setConfirm({ accountId: member.accountId, what: 'withdraw' })
                            }
                          >
                            Remove PIN
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full px-3.5"
                          disabled={busy}
                          onClick={() =>
                            setConfirm({ accountId: member.accountId, what: 'remove' })
                          }
                        >
                          Remove
                        </Button>
                      </span>
                    )}
                </div>

                {confirm?.accountId === member.accountId && (
                  <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-border bg-card px-3 py-2">
                    <span className="text-sm">
                      {confirm.what === 'remove'
                        ? `Take ${name} off this booth? Their PIN stays theirs for any other booth they work.`
                        : `Remove ${name}'s booth PIN? It stops working at every booth at the next pull.`}
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="rounded-full px-3.5"
                      disabled={busy}
                      onClick={() => {
                        setConfirm(null);
                        setNotice(null);
                        if (confirm.what === 'remove') onRemove(member.accountId);
                        else onClearPin(member.accountId);
                      }}
                    >
                      {confirm.what === 'remove' ? 'Remove' : 'Remove PIN'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full px-3.5"
                      onClick={() => setConfirm(null)}
                    >
                      Keep
                    </Button>
                  </div>
                )}

                {pinFor === member.accountId && (
                  <form
                    className="grid gap-3 rounded-[14px] border border-border bg-card p-3 @lg:grid-cols-[1fr_1fr_auto] @lg:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitPin(member.accountId);
                    }}
                  >
                    {!generate && (
                      <>
                        <Field
                          label={member.hasPin ? 'New PIN' : 'PIN'}
                          hint={
                            pin !== '' && !pinValid ? (
                              <span className="text-status-down">Exactly five digits.</span>
                            ) : (
                              'Exactly five digits, including any leading zero.'
                            )
                          }
                        >
                          <PinInput
                            label={member.hasPin ? 'New PIN' : 'PIN'}
                            value={pin}
                            onChange={setPin}
                            disabled={busy}
                          />
                        </Field>
                        <Field
                          label="PIN again"
                          hint={
                            again !== '' && !pinsMatch ? (
                              <span className="text-status-down">The two PINs are not the same.</span>
                            ) : (
                              'Never shown again once saved.'
                            )
                          }
                        >
                          <PinInput
                            label="PIN again"
                            value={again}
                            onChange={setAgain}
                            disabled={busy}
                          />
                        </Field>
                      </>
                    )}
                    <Field label="Expires" hint="Optional. Leave empty for no expiry.">
                      <input
                        type="datetime-local"
                        aria-label="Expires"
                        className={CONTROL}
                        value={expires}
                        onChange={(event) => setExpires(event.target.value)}
                        disabled={busy}
                      />
                    </Field>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        className="rounded-full px-3.5 font-bold"
                        disabled={busy || (!generate && (!pinValid || !pinsMatch))}
                      >
                        {generate ? 'Generate PIN' : 'Save PIN'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="rounded-full px-3.5"
                        onClick={closePin}
                      >
                        Cancel
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground @lg:col-span-3">
                      This replaces the person's PIN at every booth. A generated PIN is shown once:
                      write it down before closing.
                    </p>
                  </form>
                )}
                {generated?.accountId === member.accountId && (
                  <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-border bg-card p-3">
                    <span className="text-sm">
                      Generated PIN:{' '}
                      <strong className="font-mono tracking-widest">{generated.pin}</strong>. Shown
                      once — write it down.
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-full px-3.5"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(generated.pin)
                          .then(() => setNotice('PIN copied.'))
                          .catch(() => setNotice('Copy did not work. Write the PIN down.'))
                      }
                    >
                      Copy PIN
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full px-3.5"
                      onClick={() => setGenerated(null)}
                    >
                      Done
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </StripedList>
      )}

      {!readOnly && staff.state !== 'absent' && (
        <div className="flex flex-col gap-3 rounded-[14px] border border-border p-3">
          <p className="text-sm font-semibold">Add somebody to this booth</p>
          {candidatesFailed && (
            <ErrorNote message={`The staff list could not be read: ${candidatesFailed}`} />
          )}
          <div className="grid gap-3 @lg:grid-cols-[1fr_1fr_auto] @lg:items-end">
            <Field label="Search">
              <TextInput
                value={query}
                onChange={setQuery}
                placeholder="Name or phone"
                disabled={busy}
              />
            </Field>
            <Field label="Person">
              <Select
                value={adding}
                onChange={setAdding}
                disabled={busy || candidates === null}
                placeholder={candidates === null ? 'Loading staff…' : '— choose somebody —'}
                options={offered.map((c) => ({
                  value: c.accountId,
                  label: c.name
                    ? `${c.name}${c.phone ? ` — ${c.phone}` : ''}`
                    : (c.phone ?? c.accountId),
                }))}
              />
            </Field>
            <Button
              size="sm"
              className="rounded-full px-4 font-bold"
              disabled={busy || adding === '' || onList.has(adding)}
              onClick={() => {
                setNotice(null);
                onAdd(adding);
                setAdding('');
              }}
            >
              <UserPlus className="w-4 h-4" />
              Add to booth
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The people of this branch: those who work here, those with a role at this branch, and
            the park’s administrators.
          </p>
        </div>
      )}
    </CardShell>
  );
}

const ROLE_NAMES: Record<SystemRole, string> = {
  platform_admin: 'Platform admin',
  operator_admin: 'Operator admin',
  branch_manager: 'Branch manager',
  reception: 'Reception',
  staff: 'Staff',
};

/**
 * Digits only, masked, and marked as a NEW secret: `new-password` is the hint
 * browsers honour for not filling in a saved one. A booth PIN is not this
 * administrator's password, and an autofill that put the administrator's own
 * digits in here would set them as somebody else's PIN.
 */
function PinInput({
  label,
  value,
  onChange,
  disabled,
}: {
  /** The field's own name, so it is not read out with the hint under it. */
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <input
      aria-label={label}
      type="password"
      inputMode="numeric"
      autoComplete="new-password"
      maxLength={5}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      className={cn(CONTROL, 'font-mono tracking-[0.4em] disabled:opacity-60')}
    />
  );
}
