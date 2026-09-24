import { useEffect, useMemo, useState } from 'react';
import { KeyRound, UserPlus } from 'lucide-react';
import {
  BOOTH_STAFF_SESSION_DEFAULT_MINUTES,
  ROLE_BUNDLES,
  boothStaffCode,
  type SystemRole,
} from '@oto/shared';
import { staffCandidates, type BranchStaffMember } from '@/api/fleet';
import { EmptyState, ErrorNote, Loading, Panel, RouteUnavailable, Unreadable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Field, Select, TextInput } from '@/components/Form';
import { CONTROL } from '@/components/Filters';
import { StatusPill } from '@/components/Status';
import { cn } from '@/lib/utils';
import type { BoothStaffRow } from './boothApi';
import type { Read } from './readState';

/**
 * Console > Booths > "Booth staff" (SCRUM-400): who may sign in at this
 * booth, and the PIN each of them types there.
 *
 * **Two ways in, both only for the people on this list.** The PIN is checked
 * on the box, so it works with the mall's internet down; a phone and password
 * is checked by the platform, and only for somebody whose role carries
 * `booth:staff:sign_in` — the note at the foot of the panel names the roles
 * that do. Taking somebody off the list refuses their phone-and-password
 * sign-in at once, because the platform reads the list live; their PIN keeps
 * working until the box's next pull brings the new list, and a sign-in they
 * already have at the booth ends at that pull.
 *
 * **A PIN is typed twice, sent once, and never shown.** It goes to the API in
 * the one request that sets it, is hashed there with argon2id, and reaches a
 * box only as that hash. This panel keeps it in two fields until the answer
 * comes back and then empties them: there is nothing to read back, and the
 * list says only whether a PIN is set. A PIN is the person's, not the
 * booth's, so setting it here replaces the one they type at every booth.
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
  onSetPin: (accountId: string, pin: string) => Promise<boolean>;
  onClearPin: (accountId: string) => void;
  onRetry: () => void;
}) {
  const [candidates, setCandidates] = useState<BranchStaffMember[] | null>(null);
  const [candidatesFailed, setCandidatesFailed] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [query, setQuery] = useState('');
  /** Whose PIN form is open, and the two fields — the only place a PIN is held. */
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [confirm, setConfirm] = useState<{ accountId: string; what: 'remove' | 'withdraw' } | null>(null);
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
        setCandidatesFailed(reason instanceof Error ? reason.message : 'The staff list could not be read');
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

  const pinValid = /^\d{4,8}$/.test(pin);
  const pinsMatch = pin === again;
  const closePin = () => {
    setPinFor(null);
    setPin('');
    setAgain('');
  };

  const submitPin = async (accountId: string) => {
    if (!pinValid || !pinsMatch) return;
    const ok = await onSetPin(accountId, pin);
    // Emptied whatever the answer: a PIN is not kept on screen for a retry.
    closePin();
    if (ok) {
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
    <Panel
      title="Booth staff"
      description="Who may sign in at this booth, and whether each has a booth PIN. Changes reach the booth at the box's next pull — no publish needed."
    >
      {error && <ErrorNote message={error} />}
      {notice && (
        <p
          className="mb-3 rounded-xl border px-3.5 py-2.5 text-sm"
          style={{
            borderColor: 'hsl(var(--status-ok) / 0.4)',
            backgroundColor: 'hsl(var(--status-ok) / 0.07)',
          }}
        >
          {notice}
        </p>
      )}
      {readOnly && (
        <p className="mb-3 text-xs text-muted-foreground">
          Changing who works this booth needs{' '}
          <code className="font-mono text-xs">admin:booth:staff_assign</code>.
        </p>
      )}

      {staff.state === 'absent' ? (
        <RouteUnavailable what="Booth staff" detail="This deployment does not serve the booth staff routes yet." />
      ) : staff.state === 'failed' ? (
        <Unreadable what="This booth’s staff" message={staff.error} onRetry={onRetry} />
      ) : staff.state === 'unread' ? (
        <Loading what="booth staff" />
      ) : staff.value.length === 0 ? (
        <EmptyState
          title="Nobody may sign in at this booth"
          detail="The wheel still plays; every spin is recorded with nobody signed in. Add the people who work the booth below."
        />
      ) : (
        <ul className="flex flex-col divide-y" aria-label="Booth staff">
          {staff.value.map((member) => {
            const name = nameOf(member.accountId);
            const known = byId.has(member.accountId);
            return (
              <li key={member.accountId} className="py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold">{name}</span>
                  <code className="font-mono text-xs text-muted-foreground">
                    {boothStaffCode(member.accountId)}
                  </code>
                  {member.hasPin ? (
                    <StatusPill tone="ok">PIN set</StatusPill>
                  ) : (
                    <StatusPill tone="idle">no PIN</StatusPill>
                  )}
                  {candidates !== null && !known && (
                    <span className="text-xs text-muted-foreground">
                      not on this branch’s staff list — deactivated, or moved to another park
                    </span>
                  )}
                  {!readOnly && pinFor !== member.accountId && confirm?.accountId !== member.accountId && (
                    <span className="ml-auto flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setNotice(null);
                          setConfirm(null);
                          setPin('');
                          setAgain('');
                          setPinFor(member.accountId);
                        }}
                      >
                        <KeyRound className="w-4 h-4" />
                        {member.hasPin ? 'Reset PIN' : 'Set PIN'}
                      </Button>
                      {member.hasPin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirm({ accountId: member.accountId, what: 'withdraw' })}
                        >
                          Withdraw PIN
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirm({ accountId: member.accountId, what: 'remove' })}
                      >
                        Remove
                      </Button>
                    </span>
                  )}
                </div>

                {confirm?.accountId === member.accountId && (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2">
                    <span className="text-sm">
                      {confirm.what === 'remove'
                        ? `Take ${name} off this booth? Their PIN stays theirs for any other booth they work.`
                        : `Withdraw ${name}'s booth PIN? It stops working at every booth at the next pull.`}
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setConfirm(null);
                        setNotice(null);
                        if (confirm.what === 'remove') onRemove(member.accountId);
                        else onClearPin(member.accountId);
                      }}
                    >
                      {confirm.what === 'remove' ? 'Remove' : 'Withdraw'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                      Keep
                    </Button>
                  </div>
                )}

                {pinFor === member.accountId && (
                  <form
                    className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitPin(member.accountId);
                    }}
                  >
                    <Field
                      label={member.hasPin ? 'New PIN' : 'PIN'}
                      hint={
                        pin !== '' && !pinValid ? (
                          <span style={{ color: 'hsl(var(--status-down))' }}>4 to 8 digits.</span>
                        ) : (
                          '4 to 8 digits, typed on the booth’s number pad.'
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
                          <span style={{ color: 'hsl(var(--status-down))' }}>The two PINs are not the same.</span>
                        ) : (
                          'Never shown again once saved.'
                        )
                      }
                    >
                      <PinInput label="PIN again" value={again} onChange={setAgain} disabled={busy} />
                    </Field>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={busy || !pinValid || !pinsMatch}>
                        Save PIN
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={closePin}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && staff.state !== 'absent' && (
        <div className="mt-4 rounded-xl border p-3 flex flex-col gap-3">
          <p className="text-sm font-semibold">Add somebody to this booth</p>
          {candidatesFailed && <ErrorNote message={`The staff list could not be read: ${candidatesFailed}`} />}
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Search">
              <TextInput value={query} onChange={setQuery} placeholder="Name or phone" disabled={busy} />
            </Field>
            <Field label="Person">
              <Select
                value={adding}
                onChange={setAdding}
                disabled={busy || candidates === null}
                placeholder={candidates === null ? 'Loading staff…' : '— choose somebody —'}
                options={offered.map((c) => ({
                  value: c.accountId,
                  label: c.name ? `${c.name}${c.phone ? ` — ${c.phone}` : ''}` : (c.phone ?? c.accountId),
                }))}
              />
            </Field>
            <Button
              size="sm"
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
            The people of this branch: those who work here, those with a role at this branch, and the
            park’s administrators.
          </p>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Staff on this list can also sign in at the booth with their own phone and password, when their
        role allows it (<code className="font-mono">booth:staff:sign_in</code>): {roles.join(', ')}. A role the
        park created itself allows it only if it carries that permission. Either way a sign-in {lasts} — set
        under Booth settings — and does not end when nobody presses anything.
      </p>
    </Panel>
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
      maxLength={8}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      className={cn(CONTROL, 'font-mono tracking-[0.4em] disabled:opacity-60')}
    />
  );
}
